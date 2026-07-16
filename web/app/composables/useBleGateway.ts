import type {
  BleGatewayMessage,
  TemperatureReading,
  BloodPressureReading,
} from '~/types'

const SERIAL_OPTIONS: SerialOptions = {
  baudRate: 115200,
  dataBits: 8,
  parity: 'none' as ParityType,
  stopBits: 1,
  flowControl: 'none' as FlowControlType,
}

// BLE Gateway の既知 VID:PID (CH340, CP210x, Espressif, FTDI FT232R)
const BLE_GW_DEVICES = [
  { vid: 0x1A86 },            // CH340/CH552
  { vid: 0x10C4 },            // CP210x
  { vid: 0x303A },            // Espressif native USB
  { vid: 0x0403, pid: 0x6001 }, // FTDI FT232R (ATOM Lite)
]

// Android BLE Bridge WebSocket
const BLE_WS_URL = 'ws://127.0.0.1:9877'
const BLE_WS_RECONNECT_DELAY = 3000
const BLE_WS_MAX_RECONNECT = 10

// serial 探索がこの回数連続で失敗したら WS ブリッジも試す (#123)
const SERIAL_WS_FALLBACK_AFTER = 2

// シングルトン: 全コンポーネントで共有
const isConnected = ref(false)
const error = ref<string | null>(null)
const thermometerConnected = ref(false)
const bloodPressureConnected = ref(false)
const latestTemperature = ref<TemperatureReading | null>(null)
const latestBloodPressure = ref<BloodPressureReading | null>(null)
const gatewayVersion = ref<string | null>(null)
const transport = ref<'serial' | 'websocket' | null>(null)

let port: SerialPort | null = null
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
let readLoopActive = false
let lineBuffer = ''

// WebSocket state
let ws: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
let wsReconnectAttempts = 0
let wsIntentionalClose = false

// Reconnection state (serial)
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_BASE_DELAY = 2000

// Heartbeat state
let lastHeartbeatTime = 0
let heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null
const HEARTBEAT_TIMEOUT = 30000

export function useBleGateway() {

  function isWebSerialSupported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator
  }

  // --- WebSocket transport (Android BLE Bridge) ---

  function connectWebSocket(): void {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    error.value = null
    wsIntentionalClose = false

    try {
      ws = new WebSocket(BLE_WS_URL)
    }
    catch {
      error.value = 'BLE ブリッジへの WebSocket 接続に失敗しました'
      scheduleWsReconnect()
      return
    }

    ws.onopen = () => {
      console.log('[BLE-GW] WebSocket connected')
      isConnected.value = true
      transport.value = 'websocket'
      error.value = null
      wsReconnectAttempts = 0
    }

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data) as BleGatewayMessage
        console.log('[BLE-GW WS RX]', msg)
        processMessage(msg)
      }
      catch {
        console.warn('[BLE-GW] Invalid WebSocket JSON:', event.data)
      }
    }

    ws.onclose = () => {
      isConnected.value = false
      transport.value = null
      ws = null
      if (!wsIntentionalClose) {
        scheduleWsReconnect()
      }
    }

    ws.onerror = () => {
      error.value = 'BLE ブリッジとの接続でエラーが発生しました'
    }
  }

  function scheduleWsReconnect(): void {
    if (wsReconnectAttempts >= BLE_WS_MAX_RECONNECT) {
      error.value = 'BLE ブリッジに接続できません'
      return
    }
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer)
    wsReconnectTimer = setTimeout(() => {
      wsReconnectAttempts++
      connectWebSocket()
    }, BLE_WS_RECONNECT_DELAY)
  }

  function disconnectWebSocket(): void {
    wsIntentionalClose = true
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null }
    const wasWebSocket = transport.value === 'websocket'
    if (ws) {
      ws.close()
      ws = null
    }
    if (wasWebSocket) {
      isConnected.value = false
      transport.value = null
      thermometerConnected.value = false
      bloodPressureConnected.value = false
    }
  }

  function sendWsCommand(cmd: Record<string, string>): void {
    if (ws?.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(cmd))
    console.log('[BLE-GW WS TX]', cmd)
  }

  // --- WebSerial transport (PC / ATOM Lite USB) ---

  /** ブラウザのポートピッカーで手動接続 */
  async function connect(): Promise<void> {
    error.value = null

    if (!isWebSerialSupported()) {
      // WebSerial 非対応 → WebSocket フォールバック
      connectWebSocket()
      return
    }

    try {
      port = await navigator.serial.requestPort()
      await port.open(SERIAL_OPTIONS)

      if (port.readable) {
        reader = port.readable.getReader()
        if (port.writable) writer = port.writable.getWriter()
        isConnected.value = true
        transport.value = 'serial'
        startReadLoop()
      }
      else {
        throw new Error('シリアルポートの読み取りストリームが取得できません')
      }
    }
    catch (e) {
      // ユーザーがポートピッカーをキャンセル
      if (e instanceof DOMException && e.name === 'NotFoundError') {
        return
      }
      error.value = e instanceof Error ? e.message : 'BLE ゲートウェイへの接続に失敗しました'
      await cleanup()
    }
  }

  /** 許可済みポートに自動接続（リトライ付き） */
  async function autoConnect(): Promise<boolean> {
    if (isConnected.value) return true

    // WebSerial 非対応 → WebSocket で接続
    if (!isWebSerialSupported()) {
      connectWebSocket()
      // WebSocket の接続完了を少し待つ
      await new Promise(r => setTimeout(r, 500))
      return isConnected.value
    }

    const MAX_RETRIES = 3
    const RETRY_DELAY = 500

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const ports = await navigator.serial.getPorts()
        console.log('[BLE-GW] getPorts:', ports.map(p => {
          const info = p.getInfo()
          return { vid: info.usbVendorId?.toString(16), pid: info.usbProductId?.toString(16) }
        }))

        // VID+PID マッチを優先、なければ許可済みポートの先頭を使う
        const candidate = ports.find((p) => {
          const info = p.getInfo()
          if (info.usbVendorId === undefined) return false
          return BLE_GW_DEVICES.some(d =>
            d.vid === info.usbVendorId && (d.pid === undefined || d.pid === info.usbProductId),
          )
        }) ?? (ports.length === 1 ? ports[0] : null)
        if (!candidate) return false

        port = candidate
        await port.open(SERIAL_OPTIONS)

        if (port.readable) {
          reader = port.readable.getReader()
          if (port.writable) writer = port.writable.getWriter()
          isConnected.value = true
          transport.value = 'serial'
          startReadLoop()
          return true
        }
        return false
      }
      catch (e) {
        console.warn('[BLE-GW] autoConnect attempt', attempt + 1, 'failed:', e)
        // InvalidStateError = ポートがまだ開いている (前回の close 完了待ち) → リトライ
        if (e instanceof DOMException && e.name === 'InvalidStateError') {
          if (attempt < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, RETRY_DELAY))
          continue
        }
        await cleanup()
        return false
      }
    }
    await cleanup()
    return false
  }

  async function startReadLoop(): Promise<void> {
    readLoopActive = true
    const decoder = new TextDecoder()

    try {
      while (readLoopActive) {
        const { value, done } = await reader!.read()
        if (done) break
        if (!value) continue

        lineBuffer += decoder.decode(value, { stream: true })

        // 改行区切りで JSON を処理
        let newlineIdx: number
        while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
          const line = lineBuffer.substring(0, newlineIdx).trim()
          lineBuffer = lineBuffer.substring(newlineIdx + 1)
          if (line) {
            processLine(line)
          }
        }
      }
    }
    catch {
      // readLoopActive は finally で false にするため、ここでは常に true
      error.value = 'BLE ゲートウェイからの受信中にエラーが発生しました'
    }
    finally {
      readLoopActive = false
      // If we were connected and the loop ended unexpectedly, attempt reconnect
      if (isConnected.value) {
        console.warn('[BLE-GW] Read loop ended, attempting reconnect...')
        await cleanup()
        scheduleReconnect()
      }
    }
  }

  function processLine(line: string): void {
    try {
      const msg = JSON.parse(line) as BleGatewayMessage
      console.log('[BLE-GW RX]', msg)
      processMessage(msg)
    }
    catch {
      console.warn('[BLE-GW] Invalid JSON:', line)
    }
  }

  // --- 共通: メッセージ処理 (Serial / WebSocket 共用) ---

  function processMessage(msg: BleGatewayMessage): void {
    switch (msg.type) {
      case 'ready':
        gatewayVersion.value = msg.version
        reconnectAttempt = 0
        if (transport.value === 'serial') startHeartbeatCheck()
        break

      case 'heartbeat':
        lastHeartbeatTime = Date.now()
        thermometerConnected.value = msg.thermo
        bloodPressureConnected.value = msg.bp
        break

      case 'connected':
        if (msg.device === 'thermometer') thermometerConnected.value = true
        if (msg.device === 'blood_pressure') bloodPressureConnected.value = true
        break

      case 'disconnected':
        if (msg.device === 'thermometer') thermometerConnected.value = false
        if (msg.device === 'blood_pressure') bloodPressureConnected.value = false
        break

      case 'temperature':
        latestTemperature.value = {
          value: msg.value,
          unit: 'celsius',
          measuredAt: new Date(),
        }
        break

      case 'blood_pressure':
        latestBloodPressure.value = {
          systolic: msg.systolic,
          diastolic: msg.diastolic,
          pulse: msg.pulse && msg.pulse > 0 ? msg.pulse : undefined,
          unit: 'mmHg',
          measuredAt: new Date(),
        }
        break

      case 'reset':
        // スキャン再開のみ — 接続状態は disconnected/heartbeat で管理
        break

      case 'error':
        error.value = msg.message
        break
    }
  }

  /** コマンドを送信 (transport に応じて Serial / WebSocket を使い分け) */
  async function sendCommand(cmd: Record<string, string>): Promise<void> {
    if (transport.value === 'websocket') {
      sendWsCommand(cmd)
      return
    }
    if (!writer) return
    const encoder = new TextEncoder()
    try {
      await writer.write(encoder.encode(JSON.stringify(cmd) + '\n'))
      console.log('[BLE-GW TX]', cmd)
    }
    catch (e) {
      console.warn('[BLE-GW] sendCommand failed:', e)
    }
  }

  /** BLE 接続をリセットして再スキャン開始 */
  async function resetGateway(): Promise<void> {
    if (transport.value === 'websocket') {
      sendWsCommand({ command: 'reset' })
    }
    else {
      await sendCommand({ cmd: 'reset' })
    }
  }

  /** 測定値をクリア（BLE ステップ突入時に呼ぶ） */
  function clearReadings(): void {
    latestTemperature.value = null
    latestBloodPressure.value = null
    error.value = null
  }

  const hasMedicalData = computed(() =>
    latestTemperature.value !== null || latestBloodPressure.value !== null,
  )

  function scheduleReconnect(): void {
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      error.value = 'BLE ゲートウェイへの再接続に失敗しました'
      reconnectAttempt = 0
      return
    }
    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempt), 30000)
    reconnectAttempt++
    console.log(`[BLE-GW] Reconnect attempt ${reconnectAttempt} in ${delay}ms`)
    reconnectTimer = setTimeout(async () => {
      const success = await autoConnect()
      if (success) {
        reconnectAttempt = 0
      } else {
        scheduleReconnect()
      }
    }, delay)
  }

  function startHeartbeatCheck(): void {
    stopHeartbeatCheck()
    lastHeartbeatTime = Date.now()
    heartbeatCheckTimer = setInterval(() => {
      if (Date.now() - lastHeartbeatTime > HEARTBEAT_TIMEOUT) {
        console.warn('[BLE-GW] Heartbeat timeout, reconnecting...')
        cleanup().then(() => scheduleReconnect())
      }
    }, 10000)
  }

  function stopHeartbeatCheck(): void {
    if (heartbeatCheckTimer) {
      clearInterval(heartbeatCheckTimer)
      heartbeatCheckTimer = null
    }
  }

  /** WS ブリッジへの単発フォールバック試行 — 接続できなければ後始末して false */
  async function tryWsFallback(): Promise<boolean> {
    connectWebSocket()
    await new Promise(r => setTimeout(r, 500))
    if (isConnected.value) return true
    disconnectWebSocket()
    return false
  }

  /** 初回自動接続（複数回リトライ）。serial 探索の失敗が続いたら WS ブリッジへフォールバック (#123) */
  async function startAutoConnect(maxAttempts = 5, intervalMs = 3000): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      const success = await autoConnect()
      if (success) return true
      // WebSerial があるのにポートが見つからない (GW の WebView で Serial 無効化フラグが
      // 効いていない等) → alc-gw / Android の WS ブリッジを試す
      if (isWebSerialSupported() && i + 1 >= SERIAL_WS_FALLBACK_AFTER) {
        if (await tryWsFallback()) return true
      }
      if (i < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, intervalMs))
      }
    }
    return false
  }

  async function disconnect(): Promise<void> {
    disconnectWebSocket()
    await cleanup()
  }

  async function cleanup(): Promise<void> {
    readLoopActive = false
    stopHeartbeatCheck()
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

    if (writer) {
      try { writer.releaseLock() } catch {}
      writer = null
    }

    if (reader) {
      try { await reader.cancel() } catch {}
      try { reader.releaseLock() } catch {}
      reader = null
    }

    if (port) {
      try { await port.close() } catch {}
      port = null
    }

    if (transport.value === 'serial') {
      isConnected.value = false
      transport.value = null
      thermometerConnected.value = false
      bloodPressureConnected.value = false
    }
    lineBuffer = ''
  }

  return {
    isConnected: readonly(isConnected),
    error: readonly(error),
    thermometerConnected: readonly(thermometerConnected),
    bloodPressureConnected: readonly(bloodPressureConnected),
    latestTemperature: readonly(latestTemperature),
    latestBloodPressure: readonly(latestBloodPressure),
    gatewayVersion: readonly(gatewayVersion),
    transport: readonly(transport),
    hasMedicalData,
    isWebSerialSupported,
    connect,
    autoConnect,
    startAutoConnect,
    disconnect,
    clearReadings,
    sendCommand,
    resetGateway,
  }
}
