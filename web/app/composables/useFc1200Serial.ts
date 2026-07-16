import type { Fc1200State, Fc1200Event, MeasurementResult, SensorLifetime, MemoryRecord } from '~/types'
import { isClient } from '~/utils/env'
import type { Fc1200WasmSession } from 'fc1200-wasm'
import { initFc1200Wasm, createFc1200Session } from '~/utils/fc1200'

const SERIAL_OPTIONS: SerialOptions = {
  baudRate: 9600,
  dataBits: 8,
  parity: 'none' as ParityType,
  stopBits: 1,
  flowControl: 'none' as FlowControlType,
}

// BLE Gateway の既知 VID:PID（除外用）
const BLE_GW_DEVICES = [
  { vid: 0x1A86 },            // CH340/CH552
  { vid: 0x10C4 },            // CP210x
  { vid: 0x303A },            // Espressif native USB
  { vid: 0x0403, pid: 0x6001 }, // FTDI FT232R (ATOM Lite)
]

// Android FC-1200 Bridge WebSocket
const FC1200_WS_URL = 'ws://127.0.0.1:9878'
const FC1200_WS_RECONNECT_DELAY = 3000
const FC1200_WS_MAX_RECONNECT = 10

// serial ポート探索リトライ — 0 件が続いたら WS ブリッジへフォールバック (#123)
const SERIAL_SCAN_ATTEMPTS = 3
const SERIAL_SCAN_DELAY = 500

function isBleGwPort(info: SerialPortInfo): boolean {
  // 呼び出し元で usbVendorId !== undefined を確認済み
  return BLE_GW_DEVICES.some(d =>
    d.vid === info.usbVendorId && (d.pid === undefined || d.pid === info.usbProductId),
  )
}

export function useFc1200Serial() {
  const isConnected = ref(false)
  const isWasmReady = ref(false)
  const state = ref<Fc1200State>('idle')
  const error = ref<string | null>(null)
  const result = ref<MeasurementResult | null>(null)
  const sensorLifetime = ref<SensorLifetime | null>(null)
  const memoryRecords = ref<MemoryRecord[]>([])
  const dateUpdateSuccess = ref<boolean | null>(null)
  const transport = ref<'serial' | 'websocket' | null>(null)

  let port: SerialPort | null = null
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  let session: Fc1200WasmSession | null = null
  let readLoopActive = false

  // WebSocket state
  let ws: WebSocket | null = null
  let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
  let wsReconnectAttempts = 0
  let wsIntentionalClose = false

  function isWebSerialSupported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator
  }

  /** WebSerial または WebSocket (Android ブリッジ) で接続可能か */
  function isSupported(): boolean {
    // WebSerial 対応 or Android WebView (WebSocket フォールバック)
    if (isWebSerialSupported()) return true
    // WebView 内 = WebSocket ブリッジが使える
    if (isClient && typeof WebSocket !== 'undefined') return true
    return false
  }

  // --- WebSocket transport (Android FC-1200 Bridge) ---

  function connectWebSocket(): void {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    error.value = null
    wsIntentionalClose = false

    try {
      ws = new WebSocket(FC1200_WS_URL)
    }
    catch {
      error.value = 'FC-1200 ブリッジへの WebSocket 接続に失敗しました'
      scheduleWsReconnect()
      return
    }

    ws.onopen = () => {
      console.log('[FC-1200] WebSocket connected')
      isConnected.value = true
      transport.value = 'websocket'
      error.value = null
      wsReconnectAttempts = 0
    }

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data) as Fc1200Event
        console.log('[FC-1200 WS RX]', msg)
        processEvent(msg)
      }
      catch {
        console.warn('[FC-1200] Invalid WebSocket JSON:', event.data)
      }
    }

    ws.onclose = () => {
      if (transport.value === 'websocket') {
        isConnected.value = false
        transport.value = null
      }
      ws = null
      if (!wsIntentionalClose) {
        scheduleWsReconnect()
      }
    }

    ws.onerror = () => {
      error.value = 'FC-1200 ブリッジとの接続でエラーが発生しました'
    }
  }

  function scheduleWsReconnect(): void {
    if (wsReconnectAttempts >= FC1200_WS_MAX_RECONNECT) {
      error.value = 'FC-1200 ブリッジに接続できません'
      return
    }
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer)
    wsReconnectTimer = setTimeout(() => {
      wsReconnectAttempts++
      connectWebSocket()
    }, FC1200_WS_RECONNECT_DELAY)
  }

  function disconnectWebSocket(): void {
    wsIntentionalClose = true
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null }
    if (ws) {
      ws.close()
      ws = null
    }
    if (transport.value === 'websocket') {
      isConnected.value = false
      transport.value = null
    }
  }

  function sendWsCommand(command: string): void {
    if (ws?.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ command }))
    console.log('[FC-1200 WS TX]', command)
  }

  // --- WebSerial transport (PC) ---

  /** FC-1200 候補の許可済みポートを探す (BLE GW 以外で USB VID があるポートを優先) */
  async function findSerialPort(): Promise<SerialPort | null> {
    try {
      const ports = await navigator.serial.getPorts()
      return ports.find((p) => {
        const info = p.getInfo()
        return info.usbVendorId !== undefined && !isBleGwPort(info)
      }) ?? null
    }
    catch {
      return null
    }
  }

  async function openSerialPort(candidate: SerialPort): Promise<boolean> {
    try {
      port = candidate

      await initFc1200Wasm()
      isWasmReady.value = true

      await port.open(SERIAL_OPTIONS)

      session = createFc1200Session()
      state.value = session.state() as Fc1200State

      if (port.readable && port.writable) {
        reader = port.readable.getReader()
        writer = port.writable.getWriter()
        isConnected.value = true
        transport.value = 'serial'
        startReadLoop()
        return true
      }
      else {
        throw new Error('シリアルポートの読み書きストリームが取得できません')
      }
    }
    catch (e) {
      // デバイス未接続 or 別タブで使用中 → 静かに失敗
      if (e instanceof DOMException && (e.name === 'NetworkError' || e.name === 'InvalidStateError')) {
        console.warn('[FC-1200] autoConnect failed:', e.name)
      }
      await cleanup()
      return false
    }
  }

  /** 許可済みポートに自動接続（ダイアログなし）。serial ポート 0 件が続いたら WS ブリッジへフォールバック (#123) */
  async function autoConnect(): Promise<boolean> {
    error.value = null

    // WebSerial 非対応 → WebSocket で接続
    if (!isWebSerialSupported()) {
      connectWebSocket()
      await new Promise(r => setTimeout(r, 500))
      return isConnected.value
    }

    for (let attempt = 0; attempt < SERIAL_SCAN_ATTEMPTS; attempt++) {
      const candidate = await findSerialPort()
      if (candidate) {
        return openSerialPort(candidate)
      }
      if (attempt < SERIAL_SCAN_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, SERIAL_SCAN_DELAY))
      }
    }

    // WebSerial はあるのにポートが見つからない (GW の WebView で Serial 無効化フラグが
    // 効いていない等) → alc-gw / Android の WS ブリッジへフォールバック
    connectWebSocket()
    await new Promise(r => setTimeout(r, 500))
    if (isConnected.value) return true
    disconnectWebSocket()
    return false
  }

  async function connect(): Promise<void> {
    error.value = null

    if (!isWebSerialSupported()) {
      // WebSerial 非対応 → WebSocket フォールバック
      connectWebSocket()
      return
    }

    try {
      // WASM 初期化
      await initFc1200Wasm()
      isWasmReady.value = true

      // シリアルポート選択 (ブラウザのポートピッカー)
      port = await navigator.serial.requestPort()
      await port.open(SERIAL_OPTIONS)

      // WASM セッション作成
      session = createFc1200Session()
      state.value = session.state() as Fc1200State

      // Reader/Writer 取得
      if (port.readable && port.writable) {
        reader = port.readable.getReader()
        writer = port.writable.getWriter()
        isConnected.value = true
        transport.value = 'serial'
        startReadLoop()
      }
      else {
        throw new Error('シリアルポートの読み書きストリームが取得できません')
      }
    }
    catch (e) {
      // ユーザーがポートピッカーをキャンセル
      if (e instanceof DOMException && e.name === 'NotFoundError') {
        return
      }
      error.value = e instanceof Error ? e.message : 'FC-1200 との接続に失敗しました'
      await cleanup()
    }
  }

  async function startReadLoop(): Promise<void> {
    readLoopActive = true

    try {
      while (readLoopActive) {
        const { value, done } = await reader!.read()
        if (done) break
        if (!value || !session) break

        // 受信バイト列を WASM に投入
        const raw = new TextDecoder().decode(value)
        console.log('[FC-1200 RX]', raw.replace(/\r\n/g, '\\r\\n'))

        const events: Fc1200Event[] = session.feed(value)

        if (Array.isArray(events)) {
          for (const event of events) {
            console.log('[FC-1200 Event]', event)
            processEvent(event)
          }
        }

        // 保留中の応答バイトを送信
        await sendPendingResponse()
      }
    }
    catch {
      // readLoopActive は finally で false にするため、ここでは常に true
      error.value = 'FC-1200 からの受信中にエラーが発生しました'
    }
    finally {
      readLoopActive = false
    }
  }

  function processEvent(event: Fc1200Event): void {
    switch (event.type) {
      case 'state_changed':
        if (event.to) {
          state.value = event.to
        }
        break

      case 'measurement_result':
        state.value = 'result_received'
        if (event.alcohol_value !== undefined) {
          result.value = {
            employeeId: '',
            alcoholValue: event.alcohol_value,
            resultType: event.result_type ?? 'error',
            deviceUseCount: event.use_count ?? 0,
            measuredAt: new Date(),
          }
        }
        break

      case 'usage_time':
        sensorLifetime.value = {
          totalSeconds: event.total_seconds ?? 0,
          elapsedDays: event.elapsed_days ?? 0,
        }
        break

      case 'memory_data':
        if (event.id && event.datetime && event.alcohol_value !== undefined) {
          memoryRecords.value.push({
            id: event.id,
            datetime: event.datetime,
            alcoholValue: event.alcohol_value,
          })
        }
        break

      case 'date_update_response':
        dateUpdateSuccess.value = event.success ?? false
        break

      case 'error':
        error.value = getErrorMessage(event.error_code, event.message)
        break

      // Android USB serial status events
      case 'connected':
        error.value = null
        break

      case 'status':
        // "No USB serial devices found" etc.
        if (event.message && event.message.includes('No USB serial')) {
          error.value = 'FC-1200 が USB 接続されていません'
        }
        break

      case 'permission_requested':
        error.value = 'USB パーミッションを許可してください'
        break
    }
  }

  function getErrorMessage(code?: string, message?: string): string {
    switch (code) {
      case 'MSTO': return '吹きかけタイムアウト：制限時間内に息を検知できませんでした'
      case 'RSERBL': return '吹きかけエラー：正しく息を吹きかけてください'
      default: return message ?? 'FC-1200 でエラーが発生しました'
    }
  }

  async function sendPendingResponse(): Promise<void> {
    // startReadLoop / startMeasurement 等から呼ばれるため writer と session は常に非 null
    let response = session!.get_response()
    while (response) {
      await writer!.write(response)
      response = session!.get_response()
    }
  }

  async function startMeasurement(): Promise<void> {
    if (!isConnected.value) {
      error.value = 'FC-1200 が接続されていません'
      return
    }

    error.value = null
    result.value = null

    if (transport.value === 'websocket') {
      sendWsCommand('reset')
      return
    }

    session!.start_measurement()
    state.value = session!.state() as Fc1200State
    await sendPendingResponse()
  }

  /** センサ寿命確認 (RQUT) */
  async function checkSensorLifetime(): Promise<void> {
    if (!isConnected.value) {
      error.value = 'FC-1200 が接続されていません'
      return
    }
    error.value = null
    sensorLifetime.value = null

    if (transport.value === 'websocket') {
      sendWsCommand('sensor_lifetime')
      return
    }

    session!.check_sensor_lifetime()
    await sendPendingResponse()
  }

  /** メモリ取込開始 (RQDD) */
  async function startMemoryRead(): Promise<void> {
    if (!isConnected.value) {
      error.value = 'FC-1200 が接続されていません'
      return
    }
    error.value = null
    memoryRecords.value = []

    if (transport.value === 'websocket') {
      sendWsCommand('memory_read')
      return
    }

    session!.start_memory_read()
    await sendPendingResponse()
  }

  /** メモリ取込完了 (DDOK — デバイスメモリクリア) */
  async function completeMemoryRead(): Promise<void> {
    if (!isConnected.value) {
      error.value = 'FC-1200 が接続されていません'
      return
    }

    if (transport.value === 'websocket') {
      sendWsCommand('memory_complete')
      return
    }

    session!.complete_memory_read()
    await sendPendingResponse()
  }

  /** デバイス日時更新 (DT) */
  async function updateDeviceDate(datetime?: string): Promise<void> {
    if (!isConnected.value) {
      error.value = 'FC-1200 が接続されていません'
      return
    }
    error.value = null
    dateUpdateSuccess.value = null
    const dt = datetime ?? formatDateForDevice(new Date())

    if (transport.value === 'websocket') {
      sendWsCommand(`date_update:${dt}`)
      return
    }

    session!.update_date(dt)
    await sendPendingResponse()
  }

  function formatDateForDevice(date: Date): string {
    const yy = String(date.getFullYear()).slice(2)
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    const hh = String(date.getHours()).padStart(2, '0')
    const mi = String(date.getMinutes()).padStart(2, '0')
    return `${yy}${mm}${dd}${hh}${mi}`
  }

  function resetSession(): void {
    if (transport.value === 'websocket') {
      sendWsCommand('reset')
    }
    else if (session) {
      session.reset()
      state.value = session.state() as Fc1200State
    }
    result.value = null
    error.value = null
    sensorLifetime.value = null
    memoryRecords.value = []
    dateUpdateSuccess.value = null
  }

  /** Android 側の USB デバイス再スキャンを要求 */
  function scanDevices(): void {
    if (transport.value === 'websocket') {
      sendWsCommand('connect')
    }
  }

  async function disconnect(): Promise<void> {
    disconnectWebSocket()
    await cleanup()
  }

  async function cleanup(): Promise<void> {
    readLoopActive = false

    if (reader) {
      try { await reader.cancel() } catch {}
      try { reader.releaseLock() } catch {}
      reader = null
    }

    if (writer) {
      try { await writer.close() } catch {}
      try { writer.releaseLock() } catch {}
      writer = null
    }

    if (port) {
      try { await port.close() } catch {}
      port = null
    }

    if (session) {
      try { session.free() } catch {}
      session = null
    }

    if (transport.value === 'serial') {
      isConnected.value = false
      transport.value = null
    }
    state.value = 'idle'
  }

  onUnmounted(() => {
    disconnectWebSocket()
    cleanup()
  })

  return {
    isConnected: readonly(isConnected),
    isWasmReady: readonly(isWasmReady),
    state: readonly(state),
    error: readonly(error),
    result: readonly(result),
    sensorLifetime: readonly(sensorLifetime),
    memoryRecords: readonly(memoryRecords),
    dateUpdateSuccess: readonly(dateUpdateSuccess),
    transport: readonly(transport),
    isWebSerialSupported,
    isSupported,
    autoConnect,
    connect,
    disconnect,
    scanDevices,
    startMeasurement,
    resetSession,
    checkSensorLifetime,
    startMemoryRead,
    completeMemoryRead,
    updateDeviceDate,
  }
}
