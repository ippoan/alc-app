/**
 * 免許証の読み取り口。CoreS3 直結 (USB) と NFC ブリッジ (WebSocket 9876) を束ねる。
 *
 * 公開 API は useNfcWebSocket と 1 対 1 で同じ 9 キー。呼び出し側 (NfcStatus /
 * LicenseRegistration) は経路の違いを知らずに済む (Refs ippoan/alc-app#182)。
 *
 * 経路の選び方:
 *   - WebSerial が使えない環境 (Android WebView 等) → useNfcWebSocket をそのまま返す
 *   - 使える環境では CoreS3 を優先し、**直結しているあいだブリッジは購読しない**。
 *     直結が切れたら 9876 へ戻す
 *
 * それでも経路の切り替わり際に同じ免許証が二重に届きうるので、同じ employee_id を
 * DEDUPE_WINDOW_MS 以内に再受信したら捨てる。firmware 側にも重複除去はあるが、
 * 経路をまたがない — 二重に配ると NfcStatus の emit('read') が計測ステップを
 * 2 つ進めてしまう。
 */

import type { NfcReadEvent, NfcLicenseReadEvent, NfcErrorEvent } from '~/types'
import { isWebSerialSupported } from '~/utils/webserial'

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

/** `EVT` を受け取る、生きている useNfcReader の受け口 */
type EventSink = (name: string, args: string[]) => void

// useNfcReader は複数の component から呼ばれる。useCoreS3Serial.onEvent に解除が
// 無いので、繋ぐのは 1 度だけにして、配る先はここで出し入れする
const sinks = new Set<EventSink>()
let wired = false

/** `key=value` の並びから値を取り出す (無ければ空文字) */
function argValue(args: string[], key: string): string {
  const prefix = `${key}=`
  const hit = args.find(arg => arg.startsWith(prefix))
  return hit === undefined ? '' : hit.slice(prefix.length)
}

export function useNfcReader() {
  const ws = useNfcWebSocket()
  // WebSerial が無ければ CoreS3 は繋げない。従来どおりブリッジだけを使う
  if (!isWebSerialSupported()) return ws

  const core = useCoreS3Serial()

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

  function emitRead(employeeId: string): void {
    const now = Date.now()
    if (employeeId === lastEmployeeId && now - lastEmittedAt < DEDUPE_WINDOW_MS) return
    lastEmployeeId = employeeId
    lastEmittedAt = now
    for (const cb of [...readCallbacks]) cb({ type: 'nfc_read', employee_id: employeeId })
  }

  function emitLicenseRead(event: NfcLicenseReadEvent): void {
    for (const cb of [...licenseReadCallbacks]) cb(event)
  }

  function emitError(event: NfcErrorEvent): void {
    for (const cb of [...errorCallbacks]) cb(event)
  }

  // --- CoreS3 直結 ---

  function handleCoreEvent(name: string, args: string[]): void {
    if (name === 'NFC_LICENSE') {
      const issue = argValue(args, 'issue')
      const expiry = argValue(args, 'expiry')
      // 26 桁の契約を満たせない行は捨てる (utils/license.ts の桁が合わなくなる)
      if (issue.length !== DATE_LEN || expiry.length !== DATE_LEN) return

      console.log('[NFC] License read (CoreS3):', { issue, expiry })

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
      emitRead(issue + expiry)
      return
    }

    // firmware は「画面が受け付ける状態 かつ 期限切れ」のときだけ寄越す。
    // 来ないことは異常ではないので、待ち受けるだけにする
    if (name === 'LICENSE_EXPIRED') {
      emitError({ type: 'nfc_error', error: 'license_expired' })
    }
  }

  sinks.add(handleCoreEvent)
  if (!wired) {
    wired = true
    core.onEvent((name, args) => {
      for (const sink of [...sinks]) sink(name, args)
    })
  }

  // --- NFC ブリッジ (9876) ---

  ws.onLicenseRead(event => emitLicenseRead(event))
  ws.onRead(event => emitRead(event.employee_id))
  ws.onError(event => emitError(event))

  // --- 状態 ---

  function sync(): void {
    if (core.isConnected.value) {
      isConnected.value = true
      readers.value = ['CoreS3']
      // 直結が生きているあいだはブリッジの再接続エラーを見せない
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

  watch([core.isConnected, ws.isConnected, ws.error, ws.readers, ws.bridgeVersion], sync)

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
    sinks.delete(handleCoreEvent)
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
