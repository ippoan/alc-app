import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Mock WebSocket ---

type WsHandler = ((ev: any) => void) | null

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.CONNECTING
  url: string
  onopen: WsHandler = null
  onmessage: WsHandler = null
  onclose: WsHandler = null
  onerror: WsHandler = null
  sent: string[] = []

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    if (this.onclose) this.onclose({})
  }

  // test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN
    if (this.onopen) this.onopen({})
  }

  simulateMessage(data: any) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) })
  }

  simulateError() {
    if (this.onerror) this.onerror({})
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED
    if (this.onclose) this.onclose({})
  }
}

vi.stubGlobal('WebSocket', MockWebSocket)

// --- Mock SerialPort ---

function createMockPort(options?: {
  readable?: boolean
  writable?: boolean
  readValues?: Array<{ value: Uint8Array | null; done: boolean }>
  getInfoResult?: { usbVendorId?: number; usbProductId?: number }
}) {
  const readValues = options?.readValues ?? []
  let readIdx = 0

  const mockReader = {
    read: vi.fn(async () => {
      if (readIdx < readValues.length) {
        return readValues[readIdx++]!
      }
      return { value: null, done: true }
    }),
    cancel: vi.fn(async () => {}),
    releaseLock: vi.fn(),
  }

  const mockWriter = {
    write: vi.fn(async () => {}),
    releaseLock: vi.fn(),
  }

  const mockReadable = options?.readable !== false
    ? { getReader: vi.fn(() => mockReader) }
    : null
  const mockWritable = options?.writable !== false
    ? { getWriter: vi.fn(() => mockWriter) }
    : null

  return {
    port: {
      open: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      readable: mockReadable,
      writable: mockWritable,
      getInfo: vi.fn(() => options?.getInfoResult ?? { usbVendorId: 0x1A86 }),
    },
    reader: mockReader,
    writer: mockWriter,
  }
}

function installSerialMock(serialMock: {
  requestPort?: ReturnType<typeof vi.fn>
  getPorts?: ReturnType<typeof vi.fn>
}) {
  Object.defineProperty(navigator, 'serial', {
    value: {
      requestPort: serialMock.requestPort ?? vi.fn(),
      getPorts: serialMock.getPorts ?? vi.fn(async () => []),
    },
    configurable: true,
    writable: true,
  })
}

function removeSerialMock() {
  if ('serial' in navigator) {
    Object.defineProperty(navigator, 'serial', {
      value: undefined,
      configurable: true,
      writable: true,
    })
  }
}

// --- Tests ---

describe('useBleGateway', () => {
  let useBleGateway: typeof import('~/composables/useBleGateway').useBleGateway
  let gw: ReturnType<typeof useBleGateway>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    MockWebSocket.instances = []
    delete (navigator as any).serial

    vi.resetModules()
    const mod = await import('~/composables/useBleGateway')
    useBleGateway = mod.useBleGateway
    gw = useBleGateway()
  })

  afterEach(async () => {
    await gw.disconnect()
    delete (navigator as any).serial
    vi.useRealTimers()
  })

  // ---------- 初期状態 ----------

  it('初期値が正しい', () => {
    expect(gw.isConnected.value).toBe(false)
    expect(gw.error.value).toBeNull()
    expect(gw.thermometerConnected.value).toBe(false)
    expect(gw.bloodPressureConnected.value).toBe(false)
    expect(gw.latestTemperature.value).toBeNull()
    expect(gw.latestBloodPressure.value).toBeNull()
    expect(gw.gatewayVersion.value).toBeNull()
    expect(gw.transport.value).toBeNull()
    expect(gw.hasMedicalData.value).toBe(false)
  })

  it('isWebSerialSupported: navigator.serial なし → false', () => {
    expect(gw.isWebSerialSupported()).toBe(false)
  })

  it('isWebSerialSupported: navigator.serial あり → true', () => {
    installSerialMock({})
    expect(gw.isWebSerialSupported()).toBe(true)
    removeSerialMock()
  })

  // =============================================
  // WebSocket transport
  // =============================================

  describe('WebSocket transport', () => {
    describe('connect (WebSocket fallback)', () => {
      it('WebSerial 非対応 → WebSocket フォールバック', async () => {
        await gw.connect()
        expect(MockWebSocket.instances).toHaveLength(1)
        expect(MockWebSocket.instances[0]!.url).toBe('ws://127.0.0.1:9877')
      })

      it('WebSocket open → isConnected=true, transport=websocket', async () => {
        await gw.connect()
        MockWebSocket.instances[0]!.simulateOpen()
        expect(gw.isConnected.value).toBe(true)
        expect(gw.transport.value).toBe('websocket')
        expect(gw.error.value).toBeNull()
      })

      it('既に OPEN → 再接続しない', async () => {
        await gw.connect()
        MockWebSocket.instances[0]!.simulateOpen()
        await gw.connect()
        expect(MockWebSocket.instances).toHaveLength(1)
      })

      it('既に CONNECTING → 再接続しない', async () => {
        await gw.connect()
        // readyState is still CONNECTING
        await gw.connect()
        expect(MockWebSocket.instances).toHaveLength(1)
      })

      it('WebSocket error → error 設定', async () => {
        await gw.connect()
        MockWebSocket.instances[0]!.simulateError()
        expect(gw.error.value).toBe('BLE ブリッジとの接続でエラーが発生しました')
      })

      it('WebSocket close (非意図的) → 再接続スケジュール', async () => {
        await gw.connect()
        const ws = MockWebSocket.instances[0]!
        ws.simulateOpen()
        ws.simulateClose()
        expect(gw.isConnected.value).toBe(false)
        expect(gw.transport.value).toBeNull()
        vi.advanceTimersByTime(3000)
        expect(MockWebSocket.instances).toHaveLength(2)
      })

      it('再接続 MAX 超過 → エラー', async () => {
        await gw.connect()
        MockWebSocket.instances[0]!.simulateOpen()

        for (let i = 0; i < 10; i++) {
          MockWebSocket.instances[MockWebSocket.instances.length - 1]!.simulateClose()
          vi.advanceTimersByTime(3000)
        }

        MockWebSocket.instances[MockWebSocket.instances.length - 1]!.simulateClose()
        vi.advanceTimersByTime(3000)
        expect(gw.error.value).toBe('BLE ブリッジに接続できません')
      })

      it('WebSocket constructor throw → エラー + 再接続', async () => {
        let callCount = 0
        const OrigWs = MockWebSocket
        vi.stubGlobal('WebSocket', class extends OrigWs {
          constructor(url: string) {
            callCount++
            if (callCount === 1) throw new Error('ws fail')
            super(url)
          }
        })

        await gw.connect()
        expect(gw.error.value).toBe('BLE ブリッジへの WebSocket 接続に失敗しました')
        vi.advanceTimersByTime(3000)
        expect(callCount).toBe(2)

        vi.stubGlobal('WebSocket', OrigWs)
      })
    })

    describe('processMessage via WebSocket', () => {
      async function connectWs(): Promise<MockWebSocket> {
        await gw.connect()
        const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
        ws.simulateOpen()
        return ws
      }

      it('ready → gatewayVersion 設定 (websocket → heartbeat 不開始)', async () => {
        const ws = await connectWs()
        ws.simulateMessage({ type: 'ready', device: 'ble-gw', version: '1.2.3' })
        expect(gw.gatewayVersion.value).toBe('1.2.3')
      })

      it('heartbeat → thermometer/bp 状態更新', async () => {
        const ws = await connectWs()
        ws.simulateMessage({ type: 'heartbeat', uptime: 100, thermo: true, bp: false })
        expect(gw.thermometerConnected.value).toBe(true)
        expect(gw.bloodPressureConnected.value).toBe(false)
      })

      it('connected thermometer', async () => {
        const ws = await connectWs()
        ws.simulateMessage({ type: 'connected', device: 'thermometer' })
        expect(gw.thermometerConnected.value).toBe(true)
      })

      it('connected blood_pressure', async () => {
        const ws = await connectWs()
        ws.simulateMessage({ type: 'connected', device: 'blood_pressure' })
        expect(gw.bloodPressureConnected.value).toBe(true)
      })

      it('disconnected thermometer', async () => {
        const ws = await connectWs()
        ws.simulateMessage({ type: 'connected', device: 'thermometer' })
        ws.simulateMessage({ type: 'disconnected', device: 'thermometer' })
        expect(gw.thermometerConnected.value).toBe(false)
      })

      it('disconnected blood_pressure', async () => {
        const ws = await connectWs()
        ws.simulateMessage({ type: 'connected', device: 'blood_pressure' })
        ws.simulateMessage({ type: 'disconnected', device: 'blood_pressure' })
        expect(gw.bloodPressureConnected.value).toBe(false)
      })

      it('temperature → latestTemperature', async () => {
        const ws = await connectWs()
        ws.simulateMessage({ type: 'temperature', value: 36.7, unit: 'celsius' })
        expect(gw.latestTemperature.value!.value).toBe(36.7)
        expect(gw.latestTemperature.value!.unit).toBe('celsius')
        expect(gw.hasMedicalData.value).toBe(true)
      })

      it('blood_pressure with pulse', async () => {
        const ws = await connectWs()
        ws.simulateMessage({ type: 'blood_pressure', systolic: 120, diastolic: 80, pulse: 72, unit: 'mmHg' })
        expect(gw.latestBloodPressure.value!.systolic).toBe(120)
        expect(gw.latestBloodPressure.value!.pulse).toBe(72)
        expect(gw.hasMedicalData.value).toBe(true)
      })

      it('blood_pressure pulse=0 → undefined', async () => {
        const ws = await connectWs()
        ws.simulateMessage({ type: 'blood_pressure', systolic: 120, diastolic: 80, pulse: 0, unit: 'mmHg' })
        expect(gw.latestBloodPressure.value!.pulse).toBeUndefined()
      })

      it('blood_pressure pulse undefined → undefined', async () => {
        const ws = await connectWs()
        ws.simulateMessage({ type: 'blood_pressure', systolic: 120, diastolic: 80, unit: 'mmHg' })
        expect(gw.latestBloodPressure.value!.pulse).toBeUndefined()
      })

      it('error → error 設定', async () => {
        const ws = await connectWs()
        ws.simulateMessage({ type: 'error', message: 'BLE scan failed' })
        expect(gw.error.value).toBe('BLE scan failed')
      })

      it('reset → 状態変化なし', async () => {
        const ws = await connectWs()
        ws.simulateMessage({ type: 'reset', message: 'restarting' })
        // no crash, no state change
      })

      it('不正 JSON → console.warn', async () => {
        const ws = await connectWs()
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        if (ws.onmessage) ws.onmessage({ data: 'invalid{json' })
        expect(warnSpy).toHaveBeenCalled()
        warnSpy.mockRestore()
      })
    })

    describe('sendCommand (websocket)', () => {
      it('ws.send 呼び出し', async () => {
        await gw.connect()
        MockWebSocket.instances[0]!.simulateOpen()
        await gw.sendCommand({ cmd: 'scan' })
        expect(MockWebSocket.instances[0]!.sent).toHaveLength(1)
        expect(JSON.parse(MockWebSocket.instances[0]!.sent[0]!)).toEqual({ cmd: 'scan' })
      })

      it('WS not OPEN → 送信しない', async () => {
        await gw.connect()
        MockWebSocket.instances[0]!.simulateOpen()
        // Set transport to websocket, then close the socket
        const ws = MockWebSocket.instances[0]!
        ws.readyState = MockWebSocket.CLOSED
        // sendWsCommand checks readyState
        await gw.sendCommand({ cmd: 'test' })
        expect(ws.sent).toHaveLength(0)
      })
    })

    describe('resetGateway (websocket)', () => {
      it('command: reset 送信', async () => {
        await gw.connect()
        MockWebSocket.instances[0]!.simulateOpen()
        await gw.resetGateway()
        expect(JSON.parse(MockWebSocket.instances[0]!.sent[0]!)).toEqual({ command: 'reset' })
      })
    })

    describe('disconnect (websocket)', () => {
      it('全状態リセット', async () => {
        await gw.connect()
        const ws = MockWebSocket.instances[0]!
        ws.simulateOpen()
        ws.simulateMessage({ type: 'connected', device: 'thermometer' })
        ws.simulateMessage({ type: 'connected', device: 'blood_pressure' })

        await gw.disconnect()
        expect(gw.isConnected.value).toBe(false)
        expect(gw.transport.value).toBeNull()
        expect(gw.thermometerConnected.value).toBe(false)
        expect(gw.bloodPressureConnected.value).toBe(false)
      })

      it('disconnect 後の close は再接続しない', async () => {
        await gw.connect()
        MockWebSocket.instances[0]!.simulateOpen()
        await gw.disconnect()
        vi.advanceTimersByTime(5000)
        expect(MockWebSocket.instances).toHaveLength(1)
      })

      it('再接続タイマー中に disconnect → タイマークリア', async () => {
        await gw.connect()
        const ws = MockWebSocket.instances[0]!
        ws.simulateOpen()
        ws.simulateClose() // triggers reconnect schedule
        await gw.disconnect()
        vi.advanceTimersByTime(5000)
        expect(MockWebSocket.instances).toHaveLength(1)
      })
    })
  })

  // =============================================
  // clearReadings
  // =============================================

  it('clearReadings → 測定値クリア', async () => {
    await gw.connect()
    const ws = MockWebSocket.instances[0]!
    ws.simulateOpen()
    ws.simulateMessage({ type: 'temperature', value: 36.7, unit: 'celsius' })
    ws.simulateMessage({ type: 'blood_pressure', systolic: 120, diastolic: 80, unit: 'mmHg' })

    gw.clearReadings()
    expect(gw.latestTemperature.value).toBeNull()
    expect(gw.latestBloodPressure.value).toBeNull()
    expect(gw.error.value).toBeNull()
    expect(gw.hasMedicalData.value).toBe(false)
  })

  // =============================================
  // autoConnect (WebSocket)
  // =============================================

  describe('autoConnect (WebSocket fallback)', () => {
    it('既に接続済み → true', async () => {
      await gw.connect()
      MockWebSocket.instances[0]!.simulateOpen()
      const result = await gw.autoConnect()
      expect(result).toBe(true)
    })

    it('WebSerial 非対応 → WebSocket 接続試行', async () => {
      const result = gw.autoConnect()
      vi.advanceTimersByTime(500)
      expect(await result).toBe(false)
    })
  })

  // =============================================
  // startAutoConnect
  // =============================================

  describe('startAutoConnect', () => {
    it('全リトライ失敗 → false', async () => {
      // serial なし → autoConnect は WebSocket フォールバック → 未接続 = false
      const promise = gw.startAutoConnect(2, 10)
      // 1st autoConnect: connectWebSocket + 500ms wait
      await vi.advanceTimersByTimeAsync(500)
      // 1st interval
      await vi.advanceTimersByTimeAsync(10)
      // 2nd autoConnect: connectWebSocket + 500ms wait
      await vi.advanceTimersByTimeAsync(500)
      expect(await promise).toBe(false)
    })

    it('serial 接続成功 → 即 true (WS フォールバックなし)', async () => {
      const { port } = createMockPort({
        readValues: [{ value: null, done: true }],
      })
      installSerialMock({ getPorts: vi.fn(async () => [port]) })
      const result = await gw.startAutoConnect(2, 10)
      expect(result).toBe(true)
      expect(gw.transport.value).toBe('serial')
      expect(MockWebSocket.instances).toHaveLength(0)
    })

    it('serial ポート 0 件が続く → 2 回目以降 WS ブリッジへフォールバック (#123)', async () => {
      installSerialMock({ getPorts: vi.fn(async () => []) })
      const promise = gw.startAutoConnect(3, 10)
      // 1 回目の失敗ではまだ WS を試さない
      await vi.advanceTimersByTimeAsync(0)
      expect(MockWebSocket.instances).toHaveLength(0)
      // interval → 2 回目の serial 失敗 → WS フォールバック開始
      await vi.advanceTimersByTimeAsync(10)
      expect(MockWebSocket.instances).toHaveLength(1)
      expect(MockWebSocket.instances[0]!.url).toBe('ws://127.0.0.1:9877')
      MockWebSocket.instances[0]!.simulateOpen()
      await vi.advanceTimersByTimeAsync(500)
      expect(await promise).toBe(true)
      expect(gw.transport.value).toBe('websocket')
    })

    it('serial 0 件 + WS ブリッジも不在 → WS を後始末して false (#123)', async () => {
      installSerialMock({ getPorts: vi.fn(async () => []) })
      const promise = gw.startAutoConnect(2, 10)
      await vi.advanceTimersByTimeAsync(10)  // 1 回目失敗 + interval → 2 回目失敗 → WS フォールバック
      await vi.advanceTimersByTimeAsync(500) // WS 未接続 → disconnect
      expect(await promise).toBe(false)
      expect(gw.isConnected.value).toBe(false)
      expect(MockWebSocket.instances).toHaveLength(1)
      expect(MockWebSocket.instances[0]!.readyState).toBe(MockWebSocket.CLOSED)
    })
  })

  // =============================================
  // Serial transport
  // =============================================

  describe('Serial transport', () => {
    describe('connect (serial)', () => {
      it('正常接続 → isConnected=true, transport=serial', async () => {
        const { port } = createMockPort({
          readValues: [{ value: null, done: true }],
        })
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        await gw.connect()
        expect(gw.isConnected.value).toBe(true)
        expect(gw.transport.value).toBe('serial')
      })

      it('readable なし → エラー + cleanup', async () => {
        const { port } = createMockPort({ readable: false })
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        await gw.connect()
        expect(gw.error.value).toBe('シリアルポートの読み取りストリームが取得できません')
      })

      it('writable なし → writer=null でも接続成功', async () => {
        const { port } = createMockPort({
          writable: false,
          readValues: [{ value: null, done: true }],
        })
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        await gw.connect()
        expect(gw.isConnected.value).toBe(true)
      })

      it('NotFoundError (キャンセル) → エラーなし', async () => {
        installSerialMock({
          requestPort: vi.fn(async () => {
            const e = new DOMException('cancel', 'NotFoundError')
            throw e
          }),
        })

        await gw.connect()
        expect(gw.error.value).toBeNull()
      })

      it('一般エラー → error 設定', async () => {
        installSerialMock({
          requestPort: vi.fn(async () => { throw new Error('port error') }),
        })

        await gw.connect()
        expect(gw.error.value).toBe('port error')
      })

      it('非 Error → 汎用メッセージ', async () => {
        installSerialMock({
          requestPort: vi.fn(async () => { throw 'unknown' }),
        })

        await gw.connect()
        expect(gw.error.value).toBe('BLE ゲートウェイへの接続に失敗しました')
      })
    })

    describe('startReadLoop (serial)', () => {
      it('JSON 行の処理', async () => {
        const encoder = new TextEncoder()
        const jsonLine = JSON.stringify({ type: 'temperature', value: 36.5, unit: 'celsius' }) + '\n'
        const { port } = createMockPort({
          readValues: [
            { value: encoder.encode(jsonLine), done: false },
            { value: null, done: true },
          ],
        })
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        await gw.connect()
        // Wait for readLoop to process
        await vi.advanceTimersByTimeAsync(0)
        expect(gw.latestTemperature.value).not.toBeNull()
        expect(gw.latestTemperature.value!.value).toBe(36.5)
      })

      it.skip('複数行まとめて受信', async () => {
        const encoder = new TextEncoder()
        const lines = JSON.stringify({ type: 'temperature', value: 36.5, unit: 'celsius' }) + '\n'
          + JSON.stringify({ type: 'connected', device: 'thermometer' }) + '\n'
        const { port, reader: mockReader } = createMockPort()
        mockReader.read
          .mockResolvedValueOnce({ value: encoder.encode(lines), done: false })
          .mockImplementation(async () => new Promise(() => {})) // block to prevent cleanup
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)
        expect(gw.latestTemperature.value!.value).toBe(36.5)
        expect(gw.thermometerConnected.value).toBe(true)
      })

      it('不正 JSON 行 → console.warn', async () => {
        const encoder = new TextEncoder()
        const { port } = createMockPort({
          readValues: [
            { value: encoder.encode('not json\n'), done: false },
            { value: null, done: true },
          ],
        })
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)
        expect(warnSpy).toHaveBeenCalled()
        warnSpy.mockRestore()
      })

      it('空行はスキップ', async () => {
        const encoder = new TextEncoder()
        const { port } = createMockPort({
          readValues: [
            { value: encoder.encode('\n\n'), done: false },
            { value: null, done: true },
          ],
        })
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        // Should not crash
        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)
      })

      it('value=null (continue) → スキップ', async () => {
        const { port } = createMockPort({
          readValues: [
            { value: null as any, done: false },
            { value: null, done: true },
          ],
        })
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)
        // no crash
      })

      it('read エラー (readLoopActive=true) → error 設定', async () => {
        const { port, reader: mockReader } = createMockPort()
        mockReader.read.mockRejectedValueOnce(new Error('read error'))
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)
        expect(gw.error.value).toBe('BLE ゲートウェイからの受信中にエラーが発生しました')
      })

      it('readLoop 終了時 isConnected → cleanup + scheduleReconnect', async () => {
        const { port } = createMockPort({
          readValues: [{ value: null, done: true }],
        })
        installSerialMock({
          requestPort: vi.fn(async () => port),
          getPorts: vi.fn(async () => []),
        })

        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)
        // readLoop ended with done=true, isConnected was true
        // cleanup sets isConnected=false, scheduleReconnect sets timer
        // After cleanup, isConnected becomes false
        expect(gw.isConnected.value).toBe(false)
      })
    })

    describe('ready message → heartbeat check (serial)', () => {
      it('serial + ready → startHeartbeatCheck', async () => {
        const encoder = new TextEncoder()
        const readyLine = JSON.stringify({ type: 'ready', device: 'gw', version: '2.0' }) + '\n'
        let readCount = 0
        const { port, reader: mockReader } = createMockPort()
        mockReader.read
          .mockResolvedValueOnce({ value: encoder.encode(readyLine), done: false })
          .mockImplementation(async () => {
            readCount++
            // Keep blocking to prevent readLoop from ending
            if (readCount > 100) return { value: null, done: true }
            return new Promise(() => {}) // never resolves (blocks)
          })
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)
        expect(gw.gatewayVersion.value).toBe('2.0')

        // heartbeat timeout (30s), check interval is 10s
        // Advance 31s without heartbeat → should trigger timeout
        vi.advanceTimersByTime(31000)
        // Heartbeat timeout triggers cleanup + scheduleReconnect
        await vi.advanceTimersByTimeAsync(0)
      })
    })

    describe('sendCommand (serial)', () => {
      it('serial writer に書き込み', async () => {
        const encoder = new TextEncoder()
        const readyLine = JSON.stringify({ type: 'ready', device: 'gw', version: '1.0' }) + '\n'
        let readCount = 0
        const { port, writer: mockWriter, reader: mockReader } = createMockPort()
        mockReader.read
          .mockResolvedValueOnce({ value: encoder.encode(readyLine), done: false })
          .mockImplementation(async () => {
            readCount++
            if (readCount > 100) return { value: null, done: true }
            return new Promise(() => {})
          })
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)

        await gw.sendCommand({ cmd: 'scan' })
        expect(mockWriter.write).toHaveBeenCalled()
      })

      it('serial writer.write 失敗 → console.warn', async () => {
        const encoder = new TextEncoder()
        let readCount = 0
        const { port, writer: mockWriter, reader: mockReader } = createMockPort()
        mockReader.read.mockImplementation(async () => {
          readCount++
          if (readCount > 100) return { value: null, done: true }
          return new Promise(() => {})
        })
        mockWriter.write.mockRejectedValueOnce(new Error('write fail'))
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        await gw.sendCommand({ cmd: 'test' })
        expect(warnSpy).toHaveBeenCalled()
        warnSpy.mockRestore()
      })

      it('writer なし → 何もしない', async () => {
        // transport is not websocket, writer is null → just returns
        await gw.sendCommand({ cmd: 'test' })
      })
    })

    describe('resetGateway (serial)', () => {
      it('serial → sendCommand({ cmd: "reset" })', async () => {
        let readCount = 0
        const { port, writer: mockWriter, reader: mockReader } = createMockPort()
        mockReader.read.mockImplementation(async () => {
          readCount++
          if (readCount > 100) return { value: null, done: true }
          return new Promise(() => {})
        })
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)

        await gw.resetGateway()
        expect(mockWriter.write).toHaveBeenCalled()
      })
    })

    describe('autoConnect (serial)', () => {
      it('VID マッチ → 接続成功', async () => {
        const { port } = createMockPort({
          readValues: [{ value: null, done: true }],
          getInfoResult: { usbVendorId: 0x1A86 },
        })
        installSerialMock({
          getPorts: vi.fn(async () => [port]),
        })

        const result = await gw.autoConnect()
        expect(result).toBe(true)
        expect(gw.transport.value).toBe('serial')
      })

      it('VID+PID マッチ (FTDI)', async () => {
        const { port } = createMockPort({
          readValues: [{ value: null, done: true }],
          getInfoResult: { usbVendorId: 0x0403, usbProductId: 0x6001 },
        })
        installSerialMock({
          getPorts: vi.fn(async () => [port]),
        })

        const result = await gw.autoConnect()
        expect(result).toBe(true)
      })

      it('VID 不一致 + ポート1つ → フォールバック', async () => {
        const { port } = createMockPort({
          readValues: [{ value: null, done: true }],
          getInfoResult: { usbVendorId: 0x9999 },
        })
        installSerialMock({
          getPorts: vi.fn(async () => [port]),
        })

        const result = await gw.autoConnect()
        // ports.length === 1 → falls back to ports[0]
        expect(result).toBe(true)
      })

      it('VID undefined → find スキップ、ポート1つ → フォールバック', async () => {
        const { port } = createMockPort({
          readValues: [{ value: null, done: true }],
          getInfoResult: {},
        })
        installSerialMock({
          getPorts: vi.fn(async () => [port]),
        })

        const result = await gw.autoConnect()
        expect(result).toBe(true)
      })

      it('ポート0 → false', async () => {
        installSerialMock({
          getPorts: vi.fn(async () => []),
        })

        const result = await gw.autoConnect()
        expect(result).toBe(false)
      })

      it('ポート2つ + VID 不一致 → null candidate → false', async () => {
        const { port: p1 } = createMockPort({ getInfoResult: { usbVendorId: 0x9999 } })
        const { port: p2 } = createMockPort({ getInfoResult: { usbVendorId: 0x8888 } })
        installSerialMock({
          getPorts: vi.fn(async () => [p1, p2]),
        })

        const result = await gw.autoConnect()
        expect(result).toBe(false)
      })

      it('readable なし → false', async () => {
        const { port } = createMockPort({
          readable: false,
          getInfoResult: { usbVendorId: 0x1A86 },
        })
        installSerialMock({
          getPorts: vi.fn(async () => [port]),
        })

        const result = await gw.autoConnect()
        expect(result).toBe(false)
      })

      it('InvalidStateError → リトライ → 2回目で成功', async () => {
        let attempt = 0
        const { port } = createMockPort({
          readValues: [{ value: null, done: true }],
          getInfoResult: { usbVendorId: 0x1A86 },
        })
        const originalOpen = port.open
        port.open = vi.fn(async () => {
          attempt++
          if (attempt === 1) {
            throw new DOMException('busy', 'InvalidStateError')
          }
          return originalOpen()
        })
        installSerialMock({
          getPorts: vi.fn(async () => [port]),
        })

        const promise = gw.autoConnect()
        // 1st attempt: InvalidStateError → RETRY_DELAY (500ms) wait
        await vi.advanceTimersByTimeAsync(500)
        const result = await promise
        expect(result).toBe(true)
        expect(attempt).toBe(2)
      })

      it('InvalidStateError 全リトライ消費 → cleanup + false', async () => {
        const { port } = createMockPort({
          getInfoResult: { usbVendorId: 0x1A86 },
        })
        port.open = vi.fn(async () => {
          throw new DOMException('busy', 'InvalidStateError')
        })
        installSerialMock({
          getPorts: vi.fn(async () => [port]),
        })

        const promise = gw.autoConnect()
        // 3 attempts: each InvalidStateError → continue (1st, 2nd get RETRY_DELAY wait)
        await vi.advanceTimersByTimeAsync(500) // 1st retry delay
        await vi.advanceTimersByTimeAsync(500) // 2nd retry delay
        // 3rd attempt: InvalidStateError → continue → loop ends → cleanup + return false
        const result = await promise
        expect(result).toBe(false)
      })

      it('一般エラー → cleanup + false', async () => {
        const { port } = createMockPort({
          getInfoResult: { usbVendorId: 0x1A86 },
        })
        port.open = vi.fn(async () => { throw new Error('open fail') })
        installSerialMock({
          getPorts: vi.fn(async () => [port]),
        })

        const result = await gw.autoConnect()
        expect(result).toBe(false)
      })
    })

    describe('scheduleReconnect (serial)', () => {
      it('MAX 超過 → エラー + リセット', async () => {
        // Need to trigger scheduleReconnect via readLoop ending
        // Connect serial, readLoop ends immediately → cleanup + scheduleReconnect
        installSerialMock({
          getPorts: vi.fn(async () => []),
        })

        const { port } = createMockPort({
          readValues: [{ value: null, done: true }],
        })
        installSerialMock({
          requestPort: vi.fn(async () => port),
          getPorts: vi.fn(async () => []),
        })

        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)
        // readLoop ended → cleanup → scheduleReconnect called
        // Each reconnect attempt calls autoConnect which fails (getPorts returns [])
        // then calls scheduleReconnect recursively
        for (let i = 0; i < 10; i++) {
          vi.advanceTimersByTime(30000) // max delay
          await vi.advanceTimersByTimeAsync(0)
        }
        // After 10 attempts, should hit max
        expect(gw.error.value).toBe('BLE ゲートウェイへの再接続に失敗しました')
      })

      it('reconnect 成功 → reconnectAttempt リセット', async () => {
        // First connect serial, readLoop ends → cleanup → scheduleReconnect
        const { port: port1 } = createMockPort({
          readValues: [{ value: null, done: true }],
        })
        installSerialMock({
          requestPort: vi.fn(async () => port1),
          getPorts: vi.fn(async () => []),
        })

        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)
        // readLoop ended, scheduleReconnect called

        // Now install a port that autoConnect can find
        const { port: port2, reader: mockReader2 } = createMockPort({
          getInfoResult: { usbVendorId: 0x1A86 },
        })
        mockReader2.read.mockImplementation(async () => new Promise(() => {})) // block
        installSerialMock({
          getPorts: vi.fn(async () => [port2]),
        })

        // Advance timer to trigger reconnect (RECONNECT_BASE_DELAY=2000)
        await vi.advanceTimersByTimeAsync(2000)
        await vi.advanceTimersByTimeAsync(0)
        // autoConnect succeeds → reconnectAttempt = 0
        expect(gw.isConnected.value).toBe(true)
      })
    })

    describe('heartbeat timeout', () => {
      it('heartbeat タイムアウト → cleanup + scheduleReconnect', async () => {
        const encoder = new TextEncoder()
        const readyLine = JSON.stringify({ type: 'ready', device: 'gw', version: '1.0' }) + '\n'
        let readCount = 0
        const { port, reader: mockReader } = createMockPort()
        mockReader.read
          .mockResolvedValueOnce({ value: encoder.encode(readyLine), done: false })
          .mockImplementation(async () => {
            readCount++
            if (readCount > 100) return { value: null, done: true }
            return new Promise(() => {})
          })
        installSerialMock({
          requestPort: vi.fn(async () => port),
          getPorts: vi.fn(async () => []),
        })

        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)
        expect(gw.isConnected.value).toBe(true)

        // Mock Date.now to simulate time passing beyond HEARTBEAT_TIMEOUT (30s)
        const originalNow = Date.now
        let fakeNow = originalNow()
        vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)

        // Advance past heartbeat timeout
        fakeNow += 31000
        // Trigger the heartbeat check interval (10s)
        vi.advanceTimersByTime(10000)
        await vi.advanceTimersByTimeAsync(0)

        // Heartbeat timeout triggers cleanup → isConnected = false
        expect(gw.isConnected.value).toBe(false)

        vi.spyOn(Date, 'now').mockRestore()
      })
    })

    describe('cleanup (serial)', () => {
      it('writer/reader/port の cleanup', async () => {
        let readCount = 0
        const { port, writer: mockWriter, reader: mockReader } = createMockPort()
        mockReader.read.mockImplementation(async () => {
          readCount++
          if (readCount > 100) return { value: null, done: true }
          return new Promise(() => {})
        })
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)
        expect(gw.isConnected.value).toBe(true)

        await gw.disconnect()
        expect(gw.isConnected.value).toBe(false)
        expect(gw.transport.value).toBeNull()
        expect(mockWriter.releaseLock).toHaveBeenCalled()
        expect(mockReader.cancel).toHaveBeenCalled()
        expect(mockReader.releaseLock).toHaveBeenCalled()
        expect(port.close).toHaveBeenCalled()
      })

      it('releaseLock / cancel / close がエラーでもクラッシュしない', async () => {
        const { port, writer: mockWriter, reader: mockReader } = createMockPort({
          readValues: [{ value: null, done: true }],
        })
        mockWriter.releaseLock.mockImplementation(() => { throw new Error('lock err') })
        mockReader.cancel.mockRejectedValue(new Error('cancel err'))
        mockReader.releaseLock.mockImplementation(() => { throw new Error('lock err') })
        port.close = vi.fn(async () => { throw new Error('close err') })
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)

        // Should not throw
        await gw.disconnect()
        expect(gw.isConnected.value).toBe(false)
      })
    })

    describe('readLoop finally: isConnected=false → no reconnect', () => {
      it('readLoop 終了時に isConnected=false なら reconnect しない', async () => {
        let resolveRead: (v: any) => void
        const { port, reader: mockReader } = createMockPort({
          getInfoResult: { usbVendorId: 0x1A86 },
        })
        // First read blocks, then returns done: true
        mockReader.read
          .mockImplementationOnce(() => new Promise((resolve) => {
            resolveRead = resolve
          }))

        installSerialMock({ requestPort: vi.fn(async () => port) })
        await gw.connect()
        expect(gw.isConnected.value).toBe(true)
        expect(gw.transport.value).toBe('serial')

        // Manually set isConnected to false (simulating external cleanup)
        // Then resolve the read to end the loop
        // We can't directly set isConnected since it's readonly
        // Instead, call cleanup which sets isConnected=false
        await gw.disconnect()
        // Now resolve the blocked read (readLoop catches the cancelled error)
        resolveRead!({ value: null, done: true })
        await vi.advanceTimersByTimeAsync(0)

        // No reconnect should happen since isConnected was false
        expect(gw.isConnected.value).toBe(false)
      })
    })

    describe('autoConnect writable=false', () => {
      it('writable なし → writer=null でも接続成功', async () => {
        const { port } = createMockPort({
          writable: false,
          readValues: [{ value: null, done: true }],
          getInfoResult: { usbVendorId: 0x1A86 },
        })
        installSerialMock({
          getPorts: vi.fn(async () => [port]),
        })

        const result = await gw.autoConnect()
        expect(result).toBe(true)
        expect(gw.isConnected.value).toBe(true)
      })
    })

    describe('startAutoConnect 成功ケース', () => {
      it('1回目で接続成功 → true', async () => {
        const { port } = createMockPort({
          readValues: [{ value: null, done: true }],
        })
        installSerialMock({
          getPorts: vi.fn(async () => [port]),
        })

        const result = await gw.startAutoConnect(3, 100)
        expect(result).toBe(true)
      })
    })

    describe('writable なし serial', () => {
      it('writer なし → cleanup で writer スキップ', async () => {
        const { port } = createMockPort({
          writable: false,
          readValues: [{ value: null, done: true }],
        })
        installSerialMock({
          requestPort: vi.fn(async () => port),
        })

        await gw.connect()
        await vi.advanceTimersByTimeAsync(0)

        // disconnect when writer is null
        await gw.disconnect()
        expect(gw.isConnected.value).toBe(false)
      })
    })
  })
})
