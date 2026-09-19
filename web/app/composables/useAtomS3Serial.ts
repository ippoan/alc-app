/**
 * Atom S3 (血圧計用 PC の測定台、`atoms3-nfc` の VoiceS3R build + `--features ble`) との
 * USB シリアル接続。useSerialArbiter の利用側 (Refs ippoan/alc-app#353)。
 *
 * 現場に「血圧計をつないだ PC」を置き、血圧だけを測る PWA (測定台) を開かせる。挿す端末は
 * CoreS3 ではなく Atom S3 になる。ホストへの出力は ble-medical-gateway のシリアル JSON
 * 互換 (`{"type":"blood_pressure",...}` 等。ippoan/alc-app-s3 の `crates/hub-ble/src/lib.rs`
 * の doc 参照) — CoreS3 の BLE ゲートウェイと同じ JSON 語彙なので、行の解釈
 * (`useBleGateway.processMessage`) は変えずに済む。
 *
 * NFC も同じ 1 本に乗る。測定台には NFC ブリッジ (Windows の常駐アプリ + USB リーダー)
 * を置かないので、**免許証を読むのはこの Atom S3 だけ**。読み取りループは CoreS3 と
 * 共通の実装 (alc-app-s3 `crates/hub-drivers/src/nfc.rs`、ボード非依存) なので、行も
 * CoreS3 と同じ `EVT NFC_LICENSE issue=… expiry=…` で来る ⇒ `onEvent` も同形にして
 * useNfcReader が両機を同じ受け口で捌けるようにする (Refs ippoan/alc-app#353)。
 *
 * 機種識別を USB 記述子では行えない: CoreS3 も Atom S3 (測定台) も Espressif の
 * native USB (VID 0x303A / PID 0x1001) で同一。ポートの探索・open・`DEVICE` プローブ・
 * `DEVICE <kind>` の判定は useSerialArbiter が 1 本で行う (Refs ippoan/alc-app#182,
 * #353)。ここは預かったポートの使い方だけを持つ。
 *
 * 名乗りの kind は auth-worker の `DEVICE_KINDS` の key に揃えた語彙で `bp-station`
 * (`nfc` ではない)。release 前で測定台の実機は現場にまだ 1 台も無い (Pages に置いた
 * だけ) ので、`STATUS` ベースの旧い名乗りや `ERR UNSUPPORTED` への後方互換は持たない。
 * JSON の先着も claim 信号にしない — CoreS3 と測定台は同じ BLE の JSON を出すので
 * JSON は機種を決められず、`DEVICE` は `handle_common` (読み出しスレッド) が即答する
 * ので「ready まで無言」の心配も無い。
 */

import type { SerialClaimant } from '~/composables/useSerialArbiter'
import { writeLine, BP_STATION_DEVICE_KIND } from '~/composables/useSerialArbiter'

/**
 * arbiter に登録する名前。`DEVICE bp-station` の kind と一致させる — arbiter は
 * `DEVICE <kind>` の kind をそのままこの名前として引く。**語彙の正本は arbiter 側**
 * (`BP_STATION_DEVICE_KIND`) から引く — 同じ文字列を「測定台か」の判定にも使うので、
 * 2 か所に書くと片方だけ直す事故になる (Refs ippoan/alc-app#368)
 */
const CLAIMANT_NAME = BP_STATION_DEVICE_KIND

/** connect() が claim を待つ上限 (useCoreS3Serial と同じ値・同じ意味) */
const CLAIM_TIMEOUT = 3000

// シングルトン: 1 台の PC につながる測定台は 1 台
const isConnected = ref(false)

const jsonHandlers = new Set<(msg: unknown) => void>()
const eventHandlers = new Set<(name: string, args: string[]) => void>()
const openHandlers = new Set<() => void>()
const closeHandlers = new Set<() => void>()
/** claim を待っている connect() */
const waiters = new Set<() => void>()

/** 預かっているポートの writer (未接続なら null) */
let held: WritableStreamDefaultWriter<Uint8Array> | null = null

/**
 * `EVT <NAME> <args...>` を名前と引数に割って配る (useCoreS3Serial の dispatchEvent と同形)。
 *
 * **絞り込みはしない。** CoreS3 側で `EVT` を選り分けているのは `get_log` に載せる
 * 診断ログ (`DIAG_EVENT_PREFIXES` → `appendDiag`) の方だけで、`onEvent` への配布は
 * 全部通す (免許証・カードの値を診断ログに残さないための許可リストなので、配布に
 * 持ち込むと `NFC_LICENSE` が画面へ届かなくなる)。測定台は診断ログを持たないので、
 * ここには配布しか無い。
 */
function dispatchEvent(line: string): void {
  // 'EVT ' の 4 文字を落とし、最初の空白までが名前
  const sep = line.indexOf(' ', 4)
  const name = sep === -1 ? line.slice(4) : line.slice(4, sep)
  const args = sep === -1 ? [] : line.slice(sep + 1).split(' ')
  for (const cb of [...eventHandlers]) cb(name, args)
}

/**
 * JSON (BLE ゲートウェイ) と `EVT` (NFC など) を配る。JSON の中身は検査しない
 * (他機と語彙を共有しているため)。どちらでもない行は捨てる
 */
function handleLine(line: string): void {
  if (line.startsWith('EVT ')) {
    dispatchEvent(line)
    return
  }
  if (!line.startsWith('{')) return
  try {
    const msg = JSON.parse(line) as unknown
    for (const cb of [...jsonHandlers]) cb(msg)
  }
  catch {
    console.warn('[ATOM-S3] Invalid JSON:', line)
  }
}

export function useAtomS3Serial() {
  // ポートの探索と調停は arbiter に任せる (navigator.serial を自前で叩かない)
  const arbiter = useSerialArbiter()
  const isSupported = arbiter.isSupported

  // --- arbiter に預けるハンドラ (機種識別は arbiter が `DEVICE bp-station` で行う) ---

  const claimant: SerialClaimant = {
    onOpen(_port, _reader, w, lines) {
      held = w
      isConnected.value = true
      // 利用側の transport を先に立ててから、プローブ中に来ていた行を配る
      for (const cb of [...openHandlers]) cb()
      for (const line of lines) handleLine(line)
      for (const notify of [...waiters]) notify()
    },

    onLine: handleLine,

    onClose() {
      held = null
      isConnected.value = false
      for (const cb of [...closeHandlers]) cb()
    },
  }

  // --- 公開 API (useCoreS3Serial のうち useBleGateway が使う分だけ) ---

  /** JSON として読めた行を受け取る */
  function onJson(cb: (msg: unknown) => void): void {
    jsonHandlers.add(cb)
  }

  /** `EVT <NAME> <args...>` を受け取る。返り値を呼ぶと解除できる (useCoreS3Serial と同形) */
  function onEvent(cb: (name: string, args: string[]) => void): () => void {
    eventHandlers.add(cb)
    return () => { eventHandlers.delete(cb) }
  }

  /** ポートを預かった (接続した)。登録時点で既に接続済みならその場で 1 回呼ぶ */
  function onOpen(cb: () => void): void {
    openHandlers.add(cb)
    if (isConnected.value) cb()
  }

  /** ポートを失った / 返した */
  function onClose(cb: () => void): void {
    closeHandlers.add(cb)
  }

  /** 行を 1 本書く。書けなくなったらポートを返して掴み直しへ */
  async function write(line: string): Promise<boolean> {
    if (!held) return false
    const ok = await writeLine(held, line)
    if (!ok) await arbiter.release(CLAIMANT_NAME, 'write_failed')
    return ok
  }

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

  /** ポートだけ返す (登録は残すので arbiter は掴み直しに行く) */
  async function release(): Promise<void> {
    await arbiter.release(CLAIMANT_NAME)
  }

  /** 登録を解いてポートを返す (探索も止まる) */
  async function disconnect(): Promise<void> {
    await arbiter.unregister(CLAIMANT_NAME)
  }

  /**
   * 1 行送って応答 1 つを待つ (`AUTH SIGNBP <nonce>` → `AUTH SIGBP <pubkey> <sig> BP=<1|0>`
   * の後続タスク用。firmware 側は `handle_common` にあるので測定台も応答できる)。
   * 実体は arbiter 側 (useSerialArbiter.request) — 測定台が預かっているポートに送る。
   */
  function request(line: string, matchPrefix: string, timeoutMs: number): Promise<string> {
    return arbiter.request(CLAIMANT_NAME, line, matchPrefix, timeoutMs)
  }

  return {
    isSupported,
    isConnected: readonly(isConnected),
    onJson,
    onEvent,
    onOpen,
    onClose,
    write,
    connect,
    release,
    disconnect,
    request,
  }
}
