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
import { writeLine } from '~/composables/useSerialArbiter'

/**
 * arbiter に登録する名前。`DEVICE bp-station` の kind と一致させる — arbiter は
 * `DEVICE <kind>` の kind をそのままこの名前として引く
 */
const CLAIMANT_NAME = 'bp-station'

/** connect() が claim を待つ上限 (useCoreS3Serial と同じ値・同じ意味) */
const CLAIM_TIMEOUT = 3000

// シングルトン: 1 台の PC につながる測定台は 1 台
const isConnected = ref(false)

const jsonHandlers = new Set<(msg: unknown) => void>()
const openHandlers = new Set<() => void>()
const closeHandlers = new Set<() => void>()
/** claim を待っている connect() */
const waiters = new Set<() => void>()

/** 預かっているポートの writer (未接続なら null) */
let held: WritableStreamDefaultWriter<Uint8Array> | null = null

/** JSON として読める行だけ配る。他機と語彙を共有しているので中身の検査はしない */
function handleLine(line: string): void {
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

  return {
    isSupported,
    isConnected: readonly(isConnected),
    onJson,
    onOpen,
    onClose,
    write,
    connect,
    release,
    disconnect,
  }
}
