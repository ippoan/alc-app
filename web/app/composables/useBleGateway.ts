import type {
  BleGatewayMessage,
  TemperatureReading,
  BloodPressureReading,
  AlcoholReading,
  Fc1200State,
} from '~/types'
import { readAlcohol } from '~/utils/alcohol'

// Android BLE Bridge WebSocket
const BLE_WS_URL = 'ws://127.0.0.1:9877'
const BLE_WS_RECONNECT_DELAY = 3000
const BLE_WS_MAX_RECONNECT = 10

// serial 探索がこの回数連続で失敗したら WS ブリッジも試す (#123)
const SERIAL_WS_FALLBACK_AFTER = 2

// firmware の `EVT FC1200 <name> <args...>` → PC 直結と同じ Fc1200State (Refs ippoan/alc-app-s3#135)。
// BLOW_TIMEOUT は段階なし (firmware も計測待ちに戻すため案内文に戻す)
const FC1200_EVT_STATE: Record<string, Fc1200State | null> = {
  CONNECTED: 'connected',
  WARMING: 'warming_up',
  BLOW_WAITING: 'blow_waiting',
  BLOW_TIMEOUT: null,
  MEASURING: 'measuring',
}

// シングルトン: 全コンポーネントで共有
const isConnected = ref(false)
const error = ref<string | null>(null)
const thermometerConnected = ref(false)
const bloodPressureConnected = ref(false)
const latestTemperature = ref<TemperatureReading | null>(null)
const latestBloodPressure = ref<BloodPressureReading | null>(null)
const latestAlcohol = ref<AlcoholReading | null>(null)
/** CoreS3 につないだ FC-1200 の進み (PC 直結と同じ語彙)。firmware の EVT FC1200 から */
const alcoholStage = ref<Fc1200State | null>(null)
const gatewayVersion = ref<string | null>(null)
const transport = ref<'serial' | 'websocket' | null>(null)

/** useCoreS3Serial の受け口を繋いだか (useBleGateway は複数の component から呼ばれる) */
let wired = false

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
  // serial 側のポートは自前で探さない。探索・open・機種判定は useSerialArbiter に
  // 集約され、その利用側 useCoreS3Serial から JSON を受け取る (Refs #182)
  const coreS3 = useCoreS3Serial()

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
      // WS に決まったので serial の探索は降りる (後から CoreS3 を挿されて
      // transport が横取りされないように)
      void coreS3.disconnect()
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

  // --- WebSerial transport (CoreS3 / ATOM Lite USB) ---

  /** CoreS3 の受け口を 1 度だけ繋ぐ */
  function wire(): void {
    if (wired) return
    wired = true

    coreS3.onOpen(() => {
      isConnected.value = true
      transport.value = 'serial'
    })

    coreS3.onJson((msg) => {
      console.log('[BLE-GW RX]', msg)
      processMessage(msg as BleGatewayMessage)
    })

    // firmware が USB に流す FC-1200 の状態遷移 (`EVT FC1200 <name> <args...>`)。
    // CoreS3 の画面と連動しないので、PC 直結と同じ語彙でここから進みを出す (Refs ippoan/alc-app-s3#135)
    coreS3.onEvent((name, args) => {
      if (name !== 'FC1200') return
      alcoholStage.value = FC1200_EVT_STATE[args[0] ?? ''] ?? null
    })

    // 抜線・クラッシュでポートを失った → serial の state を畳む
    // (掴み直しは arbiter が 10 秒ごとの再スキャンで行う)
    coreS3.onClose(() => { void cleanup() })
  }

  /** ブラウザのポートピッカーで手動接続 */
  async function connect(): Promise<void> {
    error.value = null

    if (!coreS3.isSupported) {
      // WebSerial 非対応 → WebSocket フォールバック
      connectWebSocket()
      return
    }

    wire()
    // 許可 (ユーザー操作) のあとは arbiter に任せる。ここで open すると
    // 調停役と二重に掴んで InvalidStateError になる (#182)
    await coreS3.requestPort()
  }

  /** 許可済みポートに自動接続 (arbiter の claim を待つ) */
  async function autoConnect(): Promise<boolean> {
    if (isConnected.value) return true

    // WebSerial 非対応 → WebSocket で接続
    if (!coreS3.isSupported) {
      connectWebSocket()
      // WebSocket の接続完了を少し待つ
      await new Promise(r => setTimeout(r, 500))
      return isConnected.value
    }

    wire()
    return await coreS3.connect(0)
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

      case 'alcohol': {
        // useBleGateway は `JSON.parse(...) as BleGatewayMessage` で受けているだけで
        // 実行時の形チェックは無いので、HubMeasurementsViewer と同じ readAlcohol で
        // 値・判定を確かめてから latestAlcohol に入れる (Refs ippoan/alc-app-s3#135)
        const reading = readAlcohol(msg)
        if (reading?.result) {
          latestAlcohol.value = {
            value: reading.value ?? 0,
            unit: 'mg/L',
            result: reading.result as 'normal' | 'over' | 'error',
            useCount: reading.useCount ?? 0,
            measuredAt: new Date(),
          }
          alcoholStage.value = 'result_received'
        }
        break
      }

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
    const ok = await coreS3.write(JSON.stringify(cmd))
    if (ok) console.log('[BLE-GW TX]', cmd)
    else console.warn('[BLE-GW] sendCommand failed:', cmd)
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
    latestAlcohol.value = null
    error.value = null
  }

  /** アルコール測定値だけをクリア（AlcMeasurement の mount 時に呼ぶ。
   * 体温・血圧など他の測定値は触らない — 同時に別ステップが進んでいることがある）。
   * alcoholStage は測定完了 (result_received) のときだけ落とす — 次の運転者が
   * 来た時点で FC-1200 が既に吹き込み待ちのことがあるので、無条件には消さない。 */
  function clearAlcoholReading(): void {
    latestAlcohol.value = null
    if (alcoholStage.value === 'result_received') {
      alcoholStage.value = null
    }
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
      if (coreS3.isSupported && i + 1 >= SERIAL_WS_FALLBACK_AFTER) {
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
    // 明示的な切断なので探索ごと降りる
    await coreS3.disconnect()
    await cleanup()
  }

  async function cleanup(): Promise<void> {
    stopHeartbeatCheck()
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

    // 預かっているポートは arbiter に返す (登録は残るので掴み直しに行く)
    await coreS3.release()

    if (transport.value === 'serial') {
      isConnected.value = false
      transport.value = null
      thermometerConnected.value = false
      bloodPressureConnected.value = false
    }
  }

  return {
    isConnected: readonly(isConnected),
    error: readonly(error),
    thermometerConnected: readonly(thermometerConnected),
    bloodPressureConnected: readonly(bloodPressureConnected),
    latestTemperature: readonly(latestTemperature),
    latestBloodPressure: readonly(latestBloodPressure),
    latestAlcohol: readonly(latestAlcohol),
    alcoholStage: readonly(alcoholStage),
    gatewayVersion: readonly(gatewayVersion),
    transport: readonly(transport),
    hasMedicalData,
    connect,
    autoConnect,
    startAutoConnect,
    disconnect,
    clearReadings,
    clearAlcoholReading,
    sendCommand,
    resetGateway,
  }
}
