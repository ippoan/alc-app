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
 * native USB (VID 0x303A / PID 0x1001) で同一。ポートの探索・open・`STATUS` プローブは
 * useSerialArbiter が 1 本で行い、ここは「これは Atom S3 の測定台だ」と名乗り出る述語と、
 * 預かったポートの使い方だけを持つ (useCoreS3Serial.ts:1-45 の doc、Refs ippoan/alc-app#182)。
 *
 * 機種識別の正規の形は「`STATUS` 応答の先頭 2 トークン」— `atoms3-alarm/src/console.rs`
 * の doc (★ `STATUS` 応答の先頭 2 トークン `STATUS alarm` は変えないこと。ブラウザ側は
 * これで機種を識別する) の通り、CoreS3 は `STATUS ... BOARD=cores3`、警告デバイスは
 * `STATUS alarm ...` で名乗る。測定台 (`atoms3-nfc`) は `STATUS nfc ...` で名乗る
 * (`start_common` が `STATUS <tag> ...` を返す。`<tag>` は `"nfc"` 固定、
 * `crates/atoms3-nfc/src/main.rs`)。
 *
 * **後方互換**: `STATUS` に無応答で `ERR UNSUPPORTED (<tag>)` を返す初版ファーム
 * (`start_common` が `STATUS` を返す前の版) が Pages で配布済み
 * (ippoan/alc-app-s3#260、`https://ippoan.github.io/alc-app-s3/atoms3-nfc.html`) なので、
 * それを焼いた個体のために `ERR UNSUPPORTED (nfc)` も claim 信号に残す。裸の
 * `ERR UNSUPPORTED` は `start_common` を使う機 (atoms3-timecard / atoms3-alarm /
 * atoms3-print) 全部の catch-all なので使わない — tag まで見て測定台に限定する。
 *
 * BLE の測定値 (JSON) が `STATUS` の応答より先に届くこともあるため、JSON の先着も
 * claim 信号に含める (useCoreS3Serial.ts の「ready まで無言のファームウェアを取りこぼさない」
 * 流儀と同じフォールバック)。
 */

import type { SerialClaimant } from '~/composables/useSerialArbiter'
import { writeLine } from '~/composables/useSerialArbiter'

/** arbiter に登録する名前 */
const CLAIMANT_NAME = 'atoms3'

/** connect() が claim を待つ上限 (useCoreS3Serial と同じ値・同じ意味) */
const CLAIM_TIMEOUT = 3000

/** 測定台 (`atoms3-nfc`) が `start_common` に渡す tag。ここ限定で名乗る */
const NFC_TAG = 'nfc'

/** 行の素性。自分のものか、他の 2 機 (CoreS3 / 警告デバイス) のものか、どちらとも言えないか */
type LineKind = 'alarm' | 'cores3' | 'nfc' | 'unsupported' | 'json' | 'unknown'

/**
 * 行の接頭辞から素性を決める。
 *
 * 警告デバイスの行を先に見る: `EVT ALARM` は `EVT ` にも当てはまるため。空白まで見る —
 * CoreS3 が起動時に出す `EVT ALARM_RESTORED` を警告デバイスの行と取り違えないため
 * (useCoreS3Serial.ts の `classify()` と同じ注意、Refs ippoan/alc-app#225)。
 *
 * `STATUS nfc` / `ERR UNSUPPORTED (nfc)` はどちらも tag (`nfc`) まで見る — 接頭辞だけだと
 * `atoms3-timecard` / `atoms3-alarm` / `atoms3-print` の `STATUS` 応答や
 * `ERR UNSUPPORTED` (どの機も catch-all で返しうる) と取り違える (doc 冒頭の注意参照)。
 */
function classify(line: string): LineKind {
  if (line.startsWith('STATUS alarm') || line === 'EVT ALARM' || line.startsWith('EVT ALARM ')) return 'alarm'
  if (line.startsWith('STATUS ') && line.includes('BOARD=cores3')) return 'cores3'
  if (line.startsWith(`STATUS ${NFC_TAG}`)) return 'nfc'
  if (line.startsWith(`ERR UNSUPPORTED (${NFC_TAG})`)) return 'unsupported'
  if (line.startsWith('{')) return 'json'
  return 'unknown'
}

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
  if (classify(line) !== 'json') return
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

  // --- arbiter に預ける述語とハンドラ ---

  const claimant: SerialClaimant = {
    // `STATUS nfc` (正規の名乗り) か `ERR UNSUPPORTED (nfc)` (初版ファームの後方互換)、
    // あるいは JSON が先着したら自分のもの
    claim: lines => lines.some((line) => {
      const kind = classify(line)
      return kind === 'nfc' || kind === 'unsupported' || kind === 'json'
    }),
    // 警告デバイスか CoreS3 の名乗りが来たら自分のものではないと確定
    reject: lines => lines.some((line) => {
      const kind = classify(line)
      return kind === 'alarm' || kind === 'cores3'
    }),

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
