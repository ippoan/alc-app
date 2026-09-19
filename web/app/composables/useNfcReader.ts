/**
 * 免許証の読み取り口。USB 直結 (CoreS3 / 血圧測定台の Atom S3) と NFC ブリッジ
 * (WebSocket 9876) を束ねる。
 *
 * 公開 API は useNfcWebSocket と 1 対 1 で同じ 9 キー。呼び出し側 (NfcStatus /
 * LicenseRegistration) は経路の違いを知らずに済む (Refs ippoan/alc-app#182)。
 *
 * 経路の選び方:
 *   - WebSerial が使えない環境 (Android WebView 等) → useNfcWebSocket をそのまま返す
 *   - 使える環境では CoreS3 を優先し、**直結しているあいだブリッジは購読しない**。
 *     直結が切れたら 9876 へ戻す
 *   - 血圧測定台 (`?station=bp`) には CoreS3 もブリッジも無く、挿さっているのは
 *     Atom S3 だけ。**どちらか一方しか繋がらない端末が普通**なので、`EVT` は
 *     CoreS3 と Atom S3 の**両方**から受ける (Refs ippoan/alc-app#353)。ポートの
 *     取り合いは arbiter が `DEVICE <kind>` で捌くので、1 本のポートを両方が
 *     預かることは無い。測定台の Atom S3 を掴むのは useBpStationDeviceToken
 *     (起動時に 1 回) なので、ここは**受け口を繋ぐだけ**で connect() はしない
 *
 * それでも経路の切り替わり際に同じ免許証が二重に届きうるので、同じ employee_id を
 * DEDUPE_WINDOW_MS 以内に再受信したら捨てる。firmware 側にも重複除去はあるが、
 * 経路をまたがない — 二重に配ると NfcStatus の emit('read') が計測ステップを
 * 2 つ進めてしまう。
 */

import type { NfcReadEvent, NfcLicenseReadEvent, NfcErrorEvent, NfcReadSource } from '~/types'
import { isWebSerialSupported } from '~/utils/webserial'
import { evtArg as argValue } from '~/composables/useCoreS3Serial'

/** 同じ免許証を配り直さない窓 (経路の切り替わり際の二重配布を断つ) */
const DEDUPE_WINDOW_MS = 3000

/**
 * CoreS3 が寄越す日付 1 つぶんの桁数。
 *
 * firmware (`nfc_shim.cpp`) は交付日・有効期限それぞれに 9 バイト以上のバッファを
 * 要求しており、どちらも YYYYMMDD の 8 文字。
 */
const DATE_LEN = 8

/**
 * card_id / expiry_date の頭に詰める 10 桁の詰め物。
 *
 * 免許証 IC の hex 文字列は「先頭 10 文字 + 交付日 8 + 有効期限 8 = 26 文字」で、
 * utils/license.ts は substring(10,18) を交付日、substring(18,26) を有効期限として
 * 読む。CoreS3 は日付 2 つしか寄越さないので、**先頭 10 桁は意味を持たない詰め物**を
 * 置いて桁を合わせる (LicenseRegistration の `card_id.substring(10, 26)` もこの契約に
 * 乗っている)。
 */
const CARD_ID_PAD = '0'.repeat(10)

/**
 * `EVT` を受け取る、生きている useNfcReader の受け口。
 *
 * `source` は**どの端末から来た行か** — 束ねたあとでは判別できないので、繋いだ
 * 側が名乗って渡す (`emitRead` の doc と同じ理由)
 */
type EventSink = (name: string, args: string[], source: NfcReadSource) => void

// useNfcReader は複数の component から呼ばれる。onEvent は解除を返すが、useNfcReader は
// module 単位で 1 回だけ購読するので、繋ぐのは 1 度だけにして、配る先はここで出し入れする
const sinks = new Set<EventSink>()
let wired = false

/** 端末 1 台ぶんの `onEvent` に渡す受け口を作る (生きている sink 全部へ配る) */
function fanout(source: NfcReadSource) {
  return (name: string, args: string[]): void => {
    for (const sink of [...sinks]) sink(name, args, source)
  }
}

export function useNfcReader() {
  const ws = useNfcWebSocket()
  // WebSerial が無ければ CoreS3 は繋げない。従来どおりブリッジだけを使う
  if (!isWebSerialSupported()) return ws

  const core = useCoreS3Serial()
  // 測定台の Atom S3 (NFC は CoreS3 と共通実装なので、行も `EVT NFC_LICENSE` で同じ)
  const atom = useAtomS3Serial()

  const isConnected = ref(false)
  const error = ref<string | null>(null)
  const readers = ref<string[]>([])
  const bridgeVersion = ref<string | null>(null)

  const readCallbacks = new Set<(event: NfcReadEvent) => void>()
  const licenseReadCallbacks = new Set<(event: NfcLicenseReadEvent) => void>()
  const errorCallbacks = new Set<(event: NfcErrorEvent) => void>()

  /** connect() 済みか (直結が切れたときブリッジへ戻すかの判断に使う) */
  let wantConnected = false
  /** 直前に配った employee_id と、配った時刻 */
  let lastEmployeeId: string | null = null
  let lastEmittedAt = 0

  /**
   * 読み取りを配る。**`source` は呼び出し元が名乗る** — 束ねたあとでは
   * CoreS3 が読んだのかブリッジが読んだのか判別できないため
   * (Refs ippoan/rust-alc-api#644)。打刻を二重にするか消すかがこれで決まる。
   */
  function emitRead(employeeId: string, source: NfcReadSource): void {
    const now = Date.now()
    if (employeeId === lastEmployeeId && now - lastEmittedAt < DEDUPE_WINDOW_MS) return
    lastEmployeeId = employeeId
    lastEmittedAt = now
    for (const cb of [...readCallbacks]) cb({ type: 'nfc_read', employee_id: employeeId, source })
  }

  function emitLicenseRead(event: NfcLicenseReadEvent): void {
    for (const cb of [...licenseReadCallbacks]) cb(event)
  }

  function emitError(event: NfcErrorEvent): void {
    for (const cb of [...errorCallbacks]) cb(event)
  }

  // --- USB 直結 (CoreS3 / 測定台の Atom S3) ---

  /**
   * どちらの端末から来た `EVT` も同じ形で捌く — 読み取りループは alc-app-s3 の
   * `crates/hub-drivers/src/nfc.rs` 1 本 (ボード非依存) で、CoreS3 も測定台も
   * `EVT NFC_LICENSE issue=… expiry=…` を出す。
   *
   * 違うのは `source` だけ ⇒ 引数で受ける。`LICENSE_EXPIRED` は CoreS3 の画面
   * (`crates/hub-ui`) が出す行で、画面を持たない測定台からは来ない — 来ないことは
   * 異常ではないので、ここは待ち受けるだけにしておく。
   */
  function handleDeviceEvent(name: string, args: string[], source: NfcReadSource): void {
    if (name === 'NFC_LICENSE') {
      const issue = argValue(args, 'issue')
      const expiry = argValue(args, 'expiry')
      // 26 桁の契約を満たせない行は捨てる (utils/license.ts の桁が合わなくなる)
      if (issue.length !== DATE_LEN || expiry.length !== DATE_LEN) return

      console.log(`[NFC] License read (${source}):`, { issue, expiry })

      const cardId = CARD_ID_PAD + issue + expiry
      // useNfcWebSocket と同じ順 — 先に期限を配り、続けて読み取りを配る
      emitLicenseRead({
        type: 'nfc_license_read',
        card_type: 'driver_license',
        card_id: cardId,
        expiry_date: cardId,
        // ATR は USB CDC の行に乗らない (ブリッジ経由でのみ得られる)
        atr: '',
      })
      emitRead(issue + expiry, source)
      return
    }

    // firmware は「画面が受け付ける状態 かつ 期限切れ」のときだけ寄越す。
    // 来ないことは異常ではないので、待ち受けるだけにする
    if (name === 'LICENSE_EXPIRED') {
      emitError({ type: 'nfc_error', error: 'license_expired' })
    }
  }

  sinks.add(handleDeviceEvent)
  if (!wired) {
    wired = true
    core.onEvent(fanout('cores3'))
    atom.onEvent(fanout('bp-station'))
  }

  // --- NFC ブリッジ (9876) ---

  ws.onLicenseRead(event => emitLicenseRead(event))
  // ブリッジの先に CoreS3 は居ない = 誰も打刻していない。source をそのまま運ぶ
  ws.onRead(event => emitRead(event.employee_id, event.source))
  ws.onError(event => emitError(event))

  // --- 状態 ---

  /**
   * USB 直結で繋がっている端末の名前。無ければ null (= ブリッジの状態を見せる)。
   *
   * 測定台には CoreS3 が挿さらず、Atom S3 だけが挿さる。ここで拾わないと、カードは
   * 読めているのに `isConnected` が false のまま = 「未接続」と出る (Refs ippoan/alc-app#353)。
   * 両方とは繋がらない前提だが、万一重なったら従来どおり CoreS3 を優先する
   */
  function directReader(): string | null {
    if (core.isConnected.value) return 'CoreS3'
    if (atom.isConnected.value) return 'ATOM S3'
    return null
  }

  function sync(): void {
    const direct = directReader()
    if (direct) {
      isConnected.value = true
      readers.value = [direct]
      // 直結が生きているあいだはブリッジの再接続エラーを見せない
      // (測定台にブリッジは無いので、Atom S3 が正常でも常に出てしまう)
      error.value = null
      bridgeVersion.value = null
      return
    }
    isConnected.value = ws.isConnected.value
    readers.value = [...ws.readers.value]
    error.value = ws.error.value
    bridgeVersion.value = ws.bridgeVersion.value
  }

  watch(core.isConnected, (connected) => {
    // 直結しているあいだはブリッジを購読しない (同じ免許証の二重発火を断つ)
    if (connected) ws.disconnect()
    else if (wantConnected) ws.connect()
  })

  // immediate: 既に接続済みの CoreS3 / Atom S3 / ブリッジへ再 mount した時点で local ref に
  // 反映する (タブを戻すたびに local isConnected が false から作り直されるため)。
  watch([core.isConnected, atom.isConnected, ws.isConnected, ws.error, ws.readers, ws.bridgeVersion], sync, { immediate: true })

  function connect(): void {
    wantConnected = true
    // claim は 3 秒で諦めるが登録は残る。後から掴めば isConnected が立つ
    void core.connect()
    if (!core.isConnected.value) ws.connect()
  }

  function disconnect(): void {
    wantConnected = false
    ws.disconnect()
    // CoreS3 のポートは BLE ゲートウェイと共有しているので手放さない
    sync()
  }

  function onRead(callback: (event: NfcReadEvent) => void) {
    readCallbacks.add(callback)
    return () => { readCallbacks.delete(callback) }
  }

  function onLicenseRead(callback: (event: NfcLicenseReadEvent) => void) {
    licenseReadCallbacks.add(callback)
    return () => { licenseReadCallbacks.delete(callback) }
  }

  function onError(callback: (event: NfcErrorEvent) => void) {
    errorCallbacks.add(callback)
    return () => { errorCallbacks.delete(callback) }
  }

  onUnmounted(() => {
    sinks.delete(handleDeviceEvent)
  })

  return {
    isConnected: readonly(isConnected),
    error: readonly(error),
    readers: readonly(readers),
    bridgeVersion: readonly(bridgeVersion),
    connect,
    disconnect,
    onRead,
    onLicenseRead,
    onError,
  }
}
