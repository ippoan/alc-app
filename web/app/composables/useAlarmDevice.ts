/**
 * 据置警告デバイス (Atom VoiceS3R / USB CDC) との接続と heartbeat 送信。
 *
 * つなぐ先は**運行管理者の PC**。見張る対象は「運行管理者ダッシュボードが開いていて、
 * 乗務員からの着信を受けられる状態か」であって、乗務員側キオスクの生死ではない。
 *
 * ブラウザは「鳴れ」と命令しない。3 秒ごとに状態を 1 行送るだけで、デバイスは
 * heartbeat が途切れたら自分の判断で鳴る。管理者がタブを閉じた・別タブへ移った・
 * PC がフリーズした、のいずれも「無音」という同じ形で拾えるようにするため。
 * ダッシュボード側は unmount で disconnect() するだけでよい。
 *
 * プロトコル (firmware と同文。行指向 \n / ASCII / 115200 8N1):
 *   host → dev  `HB OK` / `HB NG <reason>`  … 3 秒ごと。デバイスは返信しない
 *   host → dev  `STATUS`                    … 機種判定のためのプローブ (arbiter が撃つ)
 *   dev  → host `STATUS alarm state=<idle|alarming|muted> cause=<none|silence|ng:<reason>|call> hb_age_ms=<n|-> VER=<ver>`
 *   dev  → host `EVT ALARM state=<...> cause=<...>` … 状態遷移のたび + 5 秒ごと無条件
 * 末尾トークン ` call=1` / ` call=0` は任意 (無ければ 0)。` grace=<秒>` も任意 (下記)。
 *
 * 送る中身は useActiveRooms から組み立てる:
 *   room 一覧の購読 (WebSocket) が 15 秒以上切れている → `HB NG signaling` (着信を受けられない)
 *   それ以外                                          → `HB OK`
 *   room が立っていて管理者がまだどれにも入っていない → 末尾に ` call=1` (着信中)
 *
 * 意図した reload (chunk 読み込み失敗の自動復旧 / アプリ内の reload / 利用者の F5) では
 * シリアルが閉じて heartbeat が途絶するが、鳴らさずに再接続を待ってほしい。reload の
 * 直前に ` grace=45` 付きの heartbeat を 1 行送ると firmware はその 1 回だけ沈黙の猶予を
 * 広げる (Refs ippoan/alc-app-s3#192)。呼び口は notifyIntentionalReload()。
 *
 * 機種識別を USB 記述子では行えない: CoreS3 の BLE ゲートウェイも VoiceS3R も
 * VID 0x303A / PID 0x1001 で同一。ポートの探索・open・`STATUS` プローブは
 * useSerialArbiter が 1 本で行い、ここは「`STATUS alarm` / `EVT ALARM` が来たら
 * 自分のものだ」と名乗り出る述語と、預かったポートの使い方だけを持つ
 * (Refs ippoan/alc-app#182)。
 *
 * 診断ログ (`[ALARM-DEV]`) は運行者端末の DevTools で読む用に出しっぱなし (Refs #197)。
 */

import type { SerialClaimant } from '~/composables/useSerialArbiter'
import { msSinceLoad, writeLine } from '~/composables/useSerialArbiter'

/** デバイスが報告する鳴動状態 */
export interface AlarmDeviceState {
  state: 'idle' | 'alarming' | 'muted'
  cause: string
}

/** arbiter に登録する名前 */
const CLAIMANT_NAME = 'alarm-device'

/** mount 直後は BLE ゲートウェイに先にポートを選ばせる (同居しない PC では 0 を渡す) */
const INITIAL_SCAN_DELAY = 5000

/**
 * heartbeat の送信間隔。CoreS3 (useCoreS3Serial) も同じ間隔で `HB OK` を送るので
 * ここを唯一の出どころにする — firmware 側の失効判定は両機とも同じ前提で組んである。
 */
export const HEARTBEAT_INTERVAL = 3000

/**
 * 意図した reload の直前に送る ` grace=<秒>`。firmware はこの 1 回だけ沈黙の猶予を
 * 10 秒からこの秒数に広げる (Refs ippoan/alc-app-s3#192)。旧 firmware は ERR で捨てる (害なし)。
 * CoreS3 (useCoreS3Serial) も同じ値を送るのでここを唯一の出どころにする。
 */
export const RELOAD_GRACE_SEC = 45

/**
 * 購読 (WebSocket) が切れてから `HB NG signaling` に切り替えるまでの猶予。
 * WS の 3 秒再接続 (useActiveRooms) で鳴らさないため。沈黙の 10 秒より長いのは、
 * 本当に切れていれば heartbeat 自体が NG で届き続けるため (Refs ippoan/alc-app#198)。
 */
export const NG_GRACE_MS = 15_000

/**
 * reload をまたいで「直前まで握っていた」ことを次の page load に伝える印 (sessionStorage)。
 * onOpen で立て、disconnect() の明示切断で消す。connect() が読んだら消して即スキャンする。
 */
const RECONNECT_MARK_KEY = 'alarm_dev_connected'

// シングルトン: 管理者 PC につながる警告デバイスは 1 台なので状態も 1 つ
const isConnected = ref(false)
const deviceState = ref<AlarmDeviceState | null>(null)

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
/** 預かっているポートの writer (未接続なら null)。grace の送り先 */
let held: WritableStreamDefaultWriter<Uint8Array> | null = null
/** 購読が切れた時刻 (購読中は null)。NG_GRACE_MS の起点 */
let ngSince: number | null = null
/** 購読の監視を張ったか (アプリ全体で 1 本) */
let ngWatchInstalled = false
/** 直前に送った heartbeat の中身。変化したときだけログに出す */
let lastLine: string | null = null

function log(message: string): void {
  console.log(`[ALARM-DEV] ${message} (+${msSinceLoad()}ms)`)
}

export function useAlarmDevice() {
  // ポートの探索と調停は arbiter に任せる (navigator.serial を自前で叩かない)
  const arbiter = useSerialArbiter()
  // 送る中身の素。購読の開始/停止はダッシュボード側の責務 (ここでは読むだけ)
  const rooms = useActiveRooms()

  const isSupported = arbiter.isSupported

  // --- 行の解釈 ---

  function classify(line: string): 'alarm' | 'other' | 'unknown' {
    if (line.startsWith('STATUS alarm') || line.startsWith('EVT ALARM')) return 'alarm'
    // `STATUS LAN=...` (CoreS3) / `PONG` / JSON — 警告デバイスではないと確定できる行
    if (line.startsWith('STATUS ') || line.startsWith('PONG') || line.startsWith('{')) return 'other'
    // `EVT BOOT ...` 等は無視 (判定材料にしない)
    return 'unknown'
  }

  /** `state=` / `cause=` を拾って deviceState に畳む */
  function applyLine(line: string): void {
    let state: AlarmDeviceState['state'] | null = null
    let cause = 'none'
    for (const token of line.split(' ')) {
      if (token.startsWith('state=')) state = token.slice(6) as AlarmDeviceState['state']
      else if (token.startsWith('cause=')) cause = token.slice(6)
    }
    if (state) deviceState.value = { state, cause }
  }

  function handleLine(line: string): void {
    if (classify(line) === 'alarm') applyLine(line)
  }

  // --- heartbeat ---

  /**
   * 購読が切れた瞬間の時刻を覚える。heartbeat の周期 (3 秒) に丸めず切れた瞬間から
   * 数えるため、送信側ではなく state の変化で取る。component の scope に縛られないよう
   * 独立した effectScope に置く (呼び元の unmount で消えると数え直せなくなる)。
   */
  function installNgWatch(): void {
    if (ngWatchInstalled) return
    ngWatchInstalled = true
    effectScope(true).run(() => {
      watch(rooms.isWatching, (watching) => {
        ngSince = watching ? null : Date.now()
      }, { immediate: true, flush: 'sync' })
    })
  }

  function startHeartbeat(w: WritableStreamDefaultWriter<Uint8Array>): void {
    stopHeartbeat()
    void sendHeartbeat(w)
    heartbeatTimer = setInterval(() => { void sendHeartbeat(w) }, HEARTBEAT_INTERVAL)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  /**
   * 今の状態を 1 行に畳む。`HB OK` / `HB NG signaling` に着信中だけ ` call=1` を足す。
   * 購読が切れていても NG_GRACE_MS 経つまでは `HB OK` (復旧すれば即 `HB OK` に戻る)。
   */
  function heartbeatLine(): string {
    const ngFor = ngSince === null ? 0 : Date.now() - ngSince
    const status = ngFor >= NG_GRACE_MS ? 'HB NG signaling' : 'HB OK'
    // room はあるが管理者がまだどれにも入っていない = 呼び出しに応答していない
    const calling = rooms.activeRooms.value.length > 0 && rooms.joinedRoomId.value === null
    const line = calling ? `${status} call=1` : status
    if (line !== lastLine) {
      log(`heartbeat ${lastLine ?? '(start)'} -> ${line}`)
      lastLine = line
    }
    return line
  }

  async function sendHeartbeat(w: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
    const ok = await writeLine(w, heartbeatLine())
    // 書けなくなった = 抜線・クラッシュ → ポートを返して掴み直しへ
    if (!ok) {
      console.warn(`[ALARM-DEV] heartbeat write failed -> release port (+${msSinceLoad()}ms)`)
      await arbiter.release(CLAIMANT_NAME)
    }
  }

  /**
   * 接続中なら今の heartbeat に ` grace=45` を足した 1 行を送る。await しない・失敗は握る
   * (reload の直前なので、ポートを返す後始末は要らない)。送ったら true
   */
  function sendGrace(): boolean {
    if (!held) return false
    void writeLine(held, `${heartbeatLine()} grace=${RELOAD_GRACE_SEC}`)
    log(`sent grace=${RELOAD_GRACE_SEC}`)
    return true
  }

  // --- arbiter に預ける述語とハンドラ ---

  const claimant: SerialClaimant = {
    claim: lines => lines.some(line => classify(line) === 'alarm'),
    reject: lines => lines.some(line => classify(line) === 'other'),

    onOpen(_port, _reader, w, lines) {
      held = w
      isConnected.value = true
      sessionStorage.setItem(RECONNECT_MARK_KEY, '1')
      log(`claimed port (probe lines=${lines.length})`)
      // プローブ中に来ていた行 (名乗り出た根拠) をここで畳む
      for (const line of lines) handleLine(line)
      startHeartbeat(w)
    },

    onLine: handleLine,

    onClose() {
      held = null
      lastLine = null
      isConnected.value = false
      deviceState.value = null
      stopHeartbeat()
      log('port closed')
    },
  }

  // --- 公開 API ---

  /**
   * 探索を始める。`delay` ミリ秒待って最初のスキャン、以後 10 秒ごとに再スキャン。
   * BLE ゲートウェイと同居しない管理者 PC では 0 を渡してすぐ探してよい。
   * reload の直前まで握っていた印 (sessionStorage) があれば delay を待たず即スキャンする。
   */
  function connect(delay = INITIAL_SCAN_DELAY): void {
    if (!isSupported) return
    installNgWatch()
    const resumed = sessionStorage.getItem(RECONNECT_MARK_KEY) === '1'
    sessionStorage.removeItem(RECONNECT_MARK_KEY)
    const scanDelay = resumed ? 0 : delay
    log(`connect(delay=${scanDelay}${resumed ? ', resumed after reload' : ''})`)
    arbiter.register(CLAIMANT_NAME, claimant)
    arbiter.start(scanDelay)
  }

  /**
   * WebSerial の初回許可 (ユーザー操作が要る) → 許可されたら探索を始める。
   * ボタンを押した直後に待たせると「接続にならない」と見えるので 0 で始める。
   */
  async function requestPort(): Promise<void> {
    const granted = await arbiter.requestPort()
    if (granted) connect(0)
  }

  /** 明示的な切断。再接続の印も消す (次の page load で即スキャンしない) */
  async function disconnect(): Promise<void> {
    log('disconnect()')
    sessionStorage.removeItem(RECONNECT_MARK_KEY)
    await arbiter.unregister(CLAIMANT_NAME)
  }

  /**
   * 意図した reload の直前に呼ぶ。握っている警告デバイスと CoreS3 の両方へ
   * ` grace=45` 付きの heartbeat を送り、reload 中の沈黙で鳴らさないよう頼む。
   * 何も握っていなければ何もしない。await しない (reload を止めない)。
   */
  function notifyIntentionalReload(): void {
    sendGrace()
    useCoreS3Serial().sendGrace()
  }

  return {
    isSupported,
    isConnected: readonly(isConnected),
    deviceState: readonly(deviceState),
    connect,
    disconnect,
    requestPort,
    notifyIntentionalReload,
  }
}
