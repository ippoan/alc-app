/**
 * CoreS3 (統合ハブ) との USB シリアル接続。useSerialArbiter の利用側。
 *
 * CoreS3 は BLE 医療機器ゲートウェイ (JSON 行) と NFC リーダー (`EVT` 行) を 1 本の
 * USB CDC に相乗りさせる。どちらの機能を使う側も自分でポートを探しに行かず、ここが
 * 受け取った行を接頭辞で振り分けて配る。
 *
 * プロトコル (行指向 \n / ASCII / 115200 8N1):
 *   host → dev  `STATUS`                     … 機種判定のためのプローブ (arbiter が撃つ)
 *   host → dev  `HB OK`                      … 3 秒ごと。CoreS3 は返信しない
 *   dev  → host `{"type":"ready",...}`       … BLE ゲートウェイの JSON メッセージ
 *   dev  → host `STATUS BOARD=cores3 ...`    … プローブへの応答 (名乗り)
 *   dev  → host `EVT <NAME> <args...>`       … NFC など状態遷移の通知
 * 既知の接頭辞に当てはまらない行は捨てる。
 *
 * 機種識別を USB 記述子では行えない: CoreS3 も警告デバイス (Atom VoiceS3R) も
 * VID 0x303A / PID 0x1001 で同一。ポートの探索・open・`STATUS` プローブは
 * useSerialArbiter が 1 本で行い、ここは「これは CoreS3 だ」と名乗り出る述語と、
 * 預かったポートの使い方だけを持つ (Refs ippoan/alc-app#182)。
 *
 * ready まで無言のファームウェアが「無応答」で閉じられ続けないよう、JSON 行が
 * 先着したら `STATUS` の応答を待たずに claim する。
 *
 * 接続しているあいだは 3 秒ごとに `HB OK` を送る。CoreS3 は heartbeat が途切れたら
 * 自分の判断で鳴るので、ブラウザは「鳴れ」と命令しない — タブを閉じた・別タブへ移った・
 * PC がフリーズした、のいずれも「無音」という同じ形で拾える (Refs ippoan/alc-app-s3#187)。
 * 送る中身は `HB OK` 固定: CoreS3 が見るのは「ブラウザの沈黙」だけで、着信の通知や
 * signaling の生死は警告デバイス (useAlarmDevice) の役割のまま。
 * 意図した reload の直前だけ `HB OK grace=45` を 1 行送り、その 1 回の沈黙の猶予を
 * 広げてもらう (sendGrace、呼び口は useAlarmDevice.notifyIntentionalReload。
 * Refs ippoan/alc-app-s3#192)。
 */

import type { SerialClaimant } from '~/composables/useSerialArbiter'
import { HEARTBEAT_INTERVAL, RELOAD_GRACE_SEC } from '~/composables/useAlarmDevice'
import { writeLine } from '~/composables/useSerialArbiter'

/** arbiter に登録する名前 */
const CLAIMANT_NAME = 'cores3'

/**
 * connect() が claim を待つ上限。
 *
 * 過ぎても登録は残り、arbiter は 10 秒ごとに探し続ける — 呼び出し側は false を
 * 受け取ったあとでも isConnected / onOpen で接続を知れる。
 */
const CLAIM_TIMEOUT = 3000

/** 行の素性。CoreS3 のものか、警告デバイスのものか、どちらとも言えないか */
type LineKind = 'json' | 'status' | 'event' | 'alarm' | 'unknown'

// シングルトン: 1 台の PC につながる CoreS3 は 1 台
const isConnected = ref(false)

const jsonHandlers = new Set<(msg: unknown) => void>()
const eventHandlers = new Set<(name: string, args: string[]) => void>()
const openHandlers = new Set<() => void>()
const closeHandlers = new Set<() => void>()
/** claim を待っている connect() */
const waiters = new Set<() => void>()

/** 預かっているポートの writer (未接続なら null) */
let held: WritableStreamDefaultWriter<Uint8Array> | null = null

/** 走っている heartbeat のタイマー (未接続なら null) */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

/**
 * 行の接頭辞から素性を決める。
 *
 * 警告デバイスの行を先に見る: `EVT ALARM` は `EVT ` にも当てはまるため。
 */
function classify(line: string): LineKind {
  if (line.startsWith('STATUS alarm') || line.startsWith('EVT ALARM')) return 'alarm'
  if (line.startsWith('{')) return 'json'
  if (line.startsWith('STATUS ') && line.includes('BOARD=cores3')) return 'status'
  if (line.startsWith('EVT ')) return 'event'
  return 'unknown'
}

export function useCoreS3Serial() {
  // ポートの探索と調停は arbiter に任せる (navigator.serial を自前で叩かない)
  const arbiter = useSerialArbiter()

  const isSupported = arbiter.isSupported

  // --- 行の振り分け ---

  /** `EVT <NAME> <args...>` を名前と引数に割る */
  function dispatchEvent(line: string): void {
    // 'EVT ' の 4 文字を落とし、最初の空白までが名前
    const sep = line.indexOf(' ', 4)
    const name = sep === -1 ? line.slice(4) : line.slice(4, sep)
    const args = sep === -1 ? [] : line.slice(sep + 1).split(' ')
    for (const cb of [...eventHandlers]) cb(name, args)
  }

  function dispatchJson(line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    }
    catch {
      console.warn('[CoreS3] Invalid JSON:', line)
      return
    }
    for (const cb of [...jsonHandlers]) cb(msg)
  }

  function handleLine(line: string): void {
    const kind = classify(line)
    if (kind === 'json') dispatchJson(line)
    else if (kind === 'event') dispatchEvent(line)
    // 'status' (名乗りそのもの) / 'alarm' / 'unknown' は捨てる
  }

  // --- heartbeat ---

  /** 接続直後に 1 回送ってから 3 秒ごと。firmware の初回武装を早めるため即時に 1 本目 */
  function startHeartbeat(): void {
    stopHeartbeat()
    void write('HB OK')
    heartbeatTimer = setInterval(() => { void write('HB OK') }, HEARTBEAT_INTERVAL)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  /**
   * 意図した reload の直前に `HB OK grace=45` を 1 行送る。未接続なら何もしない。
   * await しない (reload を止めない)。旧 firmware は ERR で捨てるだけ (害なし)
   */
  function sendGrace(): void {
    void write(`HB OK grace=${RELOAD_GRACE_SEC}`)
  }

  // --- claim を待つ ---

  /** 呼ぶ前に connect() が接続済みを弾いているので、ここは必ず未接続から始まる */
  function waitForClaim(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const onClaim = (): void => {
        clearTimeout(timer)
        waiters.delete(onClaim)
        resolve(true)
      }
      const timer = setTimeout(() => {
        waiters.delete(onClaim)
        resolve(false)
      }, CLAIM_TIMEOUT)
      waiters.add(onClaim)
    })
  }

  // --- arbiter に預ける述語とハンドラ ---

  const claimant: SerialClaimant = {
    // JSON か `BOARD=cores3` の名乗りが来たら自分のもの
    claim: lines => lines.some((line) => {
      const kind = classify(line)
      return kind === 'json' || kind === 'status'
    }),
    // 警告デバイスの行が来たら自分のものではないと確定
    reject: lines => lines.some(line => classify(line) === 'alarm'),

    onOpen(_port, _reader, w, lines) {
      held = w
      isConnected.value = true
      // 利用側の transport を先に立ててから、プローブ中に来ていた行を配る
      for (const cb of [...openHandlers]) cb()
      for (const line of lines) handleLine(line)
      for (const notify of [...waiters]) notify()
      startHeartbeat()
    },

    onLine: handleLine,

    onClose() {
      stopHeartbeat()
      held = null
      isConnected.value = false
      for (const cb of [...closeHandlers]) cb()
    },
  }

  // --- 公開 API ---

  /** JSON として読めた行を受け取る */
  function onJson(cb: (msg: unknown) => void): void {
    jsonHandlers.add(cb)
  }

  /** `EVT <NAME> <args...>` を受け取る */
  function onEvent(cb: (name: string, args: string[]) => void): void {
    eventHandlers.add(cb)
  }

  /** ポートを預かった (接続した) */
  function onOpen(cb: () => void): void {
    openHandlers.add(cb)
  }

  /** ポートを失った / 返した */
  function onClose(cb: () => void): void {
    closeHandlers.add(cb)
  }

  /** 行を 1 本書く。書けなくなったらポートを返して掴み直しへ */
  async function write(line: string): Promise<boolean> {
    if (!held) return false
    const ok = await writeLine(held, line)
    if (!ok) await arbiter.release(CLAIMANT_NAME)
    return ok
  }

  /**
   * arbiter に自分を登録して claim を待つ。`delay` ミリ秒後に最初のスキャン。
   * 待ちが切れても登録は残るので、以後 10 秒ごとの再スキャンで拾われる。
   */
  async function connect(delay = 0): Promise<boolean> {
    if (!isSupported) return false
    if (isConnected.value) return true
    arbiter.register(CLAIMANT_NAME, claimant)
    arbiter.start(delay)
    return await waitForClaim()
  }

  /** WebSerial の初回許可 (ユーザー操作が要る) → 許可されたら探索して claim を待つ */
  async function requestPort(): Promise<boolean> {
    const granted = await arbiter.requestPort()
    if (!granted) return false
    return await connect(0)
  }

  /** ポートだけ返す (登録は残すので arbiter は掴み直しに行く) */
  async function release(): Promise<void> {
    await arbiter.release(CLAIMANT_NAME)
  }

  /** 登録を解いてポートを返す (探索も止まる) */
  async function disconnect(): Promise<void> {
    await arbiter.unregister(CLAIMANT_NAME)
  }

  return {
    isSupported,
    isConnected: readonly(isConnected),
    onJson,
    onEvent,
    onOpen,
    onClose,
    write,
    sendGrace,
    connect,
    requestPort,
    release,
    disconnect,
  }
}
