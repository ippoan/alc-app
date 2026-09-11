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

// --- Mock SerialPort (useCoreS3Serial.test.ts と同型) ---

interface MockPortHandle {
  port: any
  writes: string[]
  /** デバイスからの受信行を流す (未読なら queue に積まれる) */
  emit: (text: string) => void
  /** 抜線・クラッシュ (read が done で終わる) */
  end: () => void
  setWriteError: (v: boolean) => void
}

function createMockPort(options?: { vid?: number }): MockPortHandle {
  const queue: Array<{ value?: Uint8Array; done: boolean }> = []
  let pending: ((chunk: { value?: Uint8Array; done: boolean }) => void) | null = null
  let cancelled = false
  let writeError = false

  const reader = {
    read: vi.fn(() => {
      const next = queue.shift()
      if (next) return Promise.resolve(next)
      if (cancelled) return Promise.resolve({ value: undefined, done: true })
      return new Promise<{ value?: Uint8Array; done: boolean }>((resolve) => {
        pending = resolve
      })
    }),
    cancel: vi.fn(async () => {
      cancelled = true
      if (pending) {
        pending({ value: undefined, done: true })
        pending = null
      }
    }),
    releaseLock: vi.fn(),
  }

  function push(chunk: { value?: Uint8Array; done: boolean }) {
    if (pending) {
      pending(chunk)
      pending = null
    }
    else {
      queue.push(chunk)
    }
  }

  const writes: string[] = []
  const writer = {
    write: vi.fn(async (data: Uint8Array) => {
      if (writeError) throw new Error('write failed')
      writes.push(new TextDecoder().decode(data))
    }),
    releaseLock: vi.fn(),
  }

  const port = {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    // 掴み直しでも同じ reader を使い回す (前回の cancel を持ち越さない)
    readable: { getReader: vi.fn(() => { cancelled = false; return reader }) },
    writable: { getWriter: vi.fn(() => writer) },
    getInfo: vi.fn(() => ({ usbVendorId: options?.vid ?? 0x303A, usbProductId: 0x1001 })),
  }

  return {
    port,
    writes,
    emit: (text: string) => push({ value: new TextEncoder().encode(text), done: false }),
    end: () => push({ value: undefined, done: true }),
    setWriteError: (v: boolean) => { writeError = v },
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

// --- Tests ---

describe('useBleGateway', () => {
  let useBleGateway: typeof import('~/composables/useBleGateway').useBleGateway
  let gw: ReturnType<typeof useBleGateway>

  /**
   * composable を作り直す。serial の対応判定は setup 直下で 1 度だけ評価されるので、
   * serial のテストは installSerialMock のあとに呼ぶこと (SSR で navigator を
   * top-level で触らないための形。#182)
   */
  async function load() {
    vi.resetModules()
    const mod = await import('~/composables/useBleGateway')
    useBleGateway = mod.useBleGateway
    gw = useBleGateway()
  }

  /** JSON 行を先着させて arbiter に claim させる (実機の BLE ゲートウェイと同じ形) */
  async function connectSerial(dev: MockPortHandle, ready = true) {
    installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
    await load()
    if (ready) dev.emit('{"type":"ready","version":"1.0.0"}\n')
    else dev.emit('{"type":"reset"}\n')
    expect(await autoConnect()).toBe(true)
  }

  /** autoConnect は arbiter の setTimeout(0) 越しに走るのでタイマーを進めながら待つ */
  async function autoConnect(): Promise<boolean> {
    const p = gw.autoConnect()
    await vi.advanceTimersByTimeAsync(0)
    return await p
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    // 見送ったポートの再訪判定が Date.now() を見るので Date も止める
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    MockWebSocket.instances = []
    delete (navigator as any).serial

    await load()
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
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      dev.emit('{"type":"ready","version":"1.0.0"}\n')
      const promise = gw.startAutoConnect(2, 10)
      await vi.advanceTimersByTimeAsync(0)
      expect(await promise).toBe(true)
      expect(gw.transport.value).toBe('serial')
      expect(MockWebSocket.instances).toHaveLength(0)
    })

    it('serial ポート 0 件が続く → 2 回目以降 WS ブリッジへフォールバック (#123)', async () => {
      installSerialMock({ getPorts: vi.fn(async () => []) })
      await load()
      const promise = gw.startAutoConnect(3, 10)
      // 1 回目の失敗 (claim の待ち 3 秒) ではまだ WS を試さない
      await vi.advanceTimersByTimeAsync(3000)
      expect(MockWebSocket.instances).toHaveLength(0)
      // interval → 2 回目の serial 失敗 → WS フォールバック開始
      await vi.advanceTimersByTimeAsync(10 + 3000)
      expect(MockWebSocket.instances).toHaveLength(1)
      expect(MockWebSocket.instances[0]!.url).toBe('ws://127.0.0.1:9877')
      MockWebSocket.instances[0]!.simulateOpen()
      await vi.advanceTimersByTimeAsync(500)
      expect(await promise).toBe(true)
      expect(gw.transport.value).toBe('websocket')
    })

    it('serial 0 件 + WS ブリッジも不在 → WS を後始末して false (#123)', async () => {
      installSerialMock({ getPorts: vi.fn(async () => []) })
      await load()
      const promise = gw.startAutoConnect(2, 10)
      await vi.advanceTimersByTimeAsync(3000 + 10 + 3000) // 1 回目失敗 + interval → 2 回目失敗 → WS フォールバック
      await vi.advanceTimersByTimeAsync(500) // WS 未接続 → disconnect
      expect(await promise).toBe(false)
      expect(gw.isConnected.value).toBe(false)
      expect(MockWebSocket.instances).toHaveLength(1)
      expect(MockWebSocket.instances[0]!.readyState).toBe(MockWebSocket.CLOSED)
    })
  })


  // =============================================
  // Serial transport
  //
  // ポートの探索・open・機種判定は useSerialArbiter → useCoreS3Serial に移った (#182)。
  // ここで見るのは「BLE ゲートウェイとして外から見える挙動」が不変であること。
  // =============================================

  describe('Serial transport', () => {
    describe('connect (serial / 手動ポートピッカー)', () => {
      it('許可 → arbiter が open する (自前で open しないので二重 open にならない)', async () => {
        const dev = createMockPort()
        const requestPort = vi.fn(async () => dev.port)
        installSerialMock({ getPorts: vi.fn(async () => [dev.port]), requestPort })
        await load()
        dev.emit('{"type":"ready","version":"1.0.0"}\n')

        const p = gw.connect()
        await vi.advanceTimersByTimeAsync(0)
        await p

        expect(requestPort).toHaveBeenCalledTimes(1)
        // 許可のあと開くのは arbiter の 1 回だけ
        expect(dev.port.open).toHaveBeenCalledTimes(1)
        expect(gw.isConnected.value).toBe(true)
        expect(gw.transport.value).toBe('serial')
        expect(gw.error.value).toBeNull()
      })

      it('ポートピッカーをキャンセル → 未接続 / エラーなし', async () => {
        const getPorts = vi.fn(async () => [])
        installSerialMock({
          getPorts,
          requestPort: vi.fn(async () => { throw new DOMException('cancel', 'NotFoundError') }),
        })
        await load()

        await gw.connect()
        expect(gw.isConnected.value).toBe(false)
        expect(gw.error.value).toBeNull()
        expect(getPorts).not.toHaveBeenCalled()
      })
    })

    describe('autoConnect (serial)', () => {
      it('JSON 行が先着 → 接続 (STATUS の応答を待たない)', async () => {
        const dev = createMockPort()
        await connectSerial(dev)

        expect(gw.transport.value).toBe('serial')
        expect(gw.gatewayVersion.value).toBe('1.0.0')
        // 自前の列挙をしないので open は arbiter の 1 回だけ
        expect(dev.port.open).toHaveBeenCalledTimes(1)
      })

      it('ポートが 1 つも無い → 3 秒待って false', async () => {
        installSerialMock({ getPorts: vi.fn(async () => []) })
        await load()

        const p = gw.autoConnect()
        await vi.advanceTimersByTimeAsync(3000)
        expect(await p).toBe(false)
        expect(gw.isConnected.value).toBe(false)
      })

      it('既に接続済み → 探索せず true', async () => {
        const dev = createMockPort()
        await connectSerial(dev)

        expect(await gw.autoConnect()).toBe(true)
      })

      it('CoreS3 が先に (起動時の探索で) 繋がっていても、あとから wire すれば isConnected が立つ (Refs #238)', async () => {
        const dev = createMockPort()
        dev.emit('{"type":"ready","version":"1.0.0"}\n')
        installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
        await load()

        const { useCoreS3Serial } = await import('~/composables/useCoreS3Serial')
        const probe = useCoreS3Serial().startupProbe()
        await vi.advanceTimersByTimeAsync(0)
        expect(await probe).toBe(true)
        // まだ wire していない
        expect(gw.isConnected.value).toBe(false)

        expect(await autoConnect()).toBe(true)
        expect(gw.isConnected.value).toBe(true)
        expect(gw.transport.value).toBe('serial')
      })

      it('警告デバイス (VoiceS3R) のポートは掴まない (#135)', async () => {
        const alarm = createMockPort()
        alarm.emit('EVT ALARM state=alarming cause=silence\n')
        installSerialMock({ getPorts: vi.fn(async () => [alarm.port]) })
        await load()

        const p = gw.autoConnect()
        await vi.advanceTimersByTimeAsync(3000)
        expect(await p).toBe(false)
        expect(gw.isConnected.value).toBe(false)
        // reject が確定した時点で手放している
        expect(alarm.port.close).toHaveBeenCalledTimes(1)
      })
    })

    describe('processMessage (serial)', () => {
      it('ready → gatewayVersion + heartbeat 監視開始 (serial のみ)', async () => {
        const dev = createMockPort()
        await connectSerial(dev)

        expect(gw.gatewayVersion.value).toBe('1.0.0')

        // 30 秒 heartbeat が来なければ掴み直しへ (点検は 10 秒ごとなので 40 秒目に気づく)
        await vi.advanceTimersByTimeAsync(40000)
        expect(gw.isConnected.value).toBe(false)
        expect(gw.transport.value).toBeNull()
        expect(dev.port.close).toHaveBeenCalledTimes(1)
      })

      it('heartbeat が来ている間は掴み直さない', async () => {
        const dev = createMockPort()
        await connectSerial(dev)

        for (let i = 0; i < 4; i++) {
          await vi.advanceTimersByTimeAsync(10000)
          dev.emit('{"type":"heartbeat","thermo":true,"bp":false}\n')
          await vi.advanceTimersByTimeAsync(0)
        }

        expect(gw.isConnected.value).toBe(true)
        expect(gw.thermometerConnected.value).toBe(true)
        expect(gw.bloodPressureConnected.value).toBe(false)
      })

      it('ready 以外で始まる serial 接続では heartbeat 監視を始めない', async () => {
        const dev = createMockPort()
        await connectSerial(dev, false)

        await vi.advanceTimersByTimeAsync(60000)
        expect(gw.isConnected.value).toBe(true)
      })

      it('serial でも WebSocket と同じ分岐を通る (温度・血圧・機器・エラー)', async () => {
        const dev = createMockPort()
        await connectSerial(dev)

        dev.emit('{"type":"connected","device":"thermometer"}\n')
        dev.emit('{"type":"connected","device":"blood_pressure"}\n')
        dev.emit('{"type":"temperature","value":36.7}\n')
        dev.emit('{"type":"blood_pressure","systolic":120,"diastolic":80,"pulse":66}\n')
        await vi.advanceTimersByTimeAsync(0)

        expect(gw.thermometerConnected.value).toBe(true)
        expect(gw.bloodPressureConnected.value).toBe(true)
        expect(gw.latestTemperature.value?.value).toBe(36.7)
        expect(gw.latestBloodPressure.value?.pulse).toBe(66)
        expect(gw.hasMedicalData.value).toBe(true)

        dev.emit('{"type":"disconnected","device":"thermometer"}\n')
        dev.emit('{"type":"disconnected","device":"blood_pressure"}\n')
        dev.emit('{"type":"error","message":"BLE スキャンに失敗しました"}\n')
        await vi.advanceTimersByTimeAsync(0)

        expect(gw.thermometerConnected.value).toBe(false)
        expect(gw.bloodPressureConnected.value).toBe(false)
        expect(gw.error.value).toBe('BLE スキャンに失敗しました')
      })
    })

    describe('sendCommand / resetGateway (serial)', () => {
      it('JSON 1 行として書く', async () => {
        const dev = createMockPort()
        await connectSerial(dev)

        await gw.sendCommand({ cmd: 'scan' })
        expect(dev.writes).toContain('{"cmd":"scan"}\n')
      })

      it('resetGateway → { cmd: "reset" } を送る (ポートは手放さない)', async () => {
        const dev = createMockPort()
        await connectSerial(dev)

        await gw.resetGateway()
        expect(dev.writes).toContain('{"cmd":"reset"}\n')
        expect(gw.isConnected.value).toBe(true)
        expect(gw.transport.value).toBe('serial')
      })

      it('書けなくなったら warn してポートを返す', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const dev = createMockPort()
        await connectSerial(dev)
        dev.setWriteError(true)

        await gw.sendCommand({ cmd: 'scan' })
        expect(warn).toHaveBeenCalledWith('[BLE-GW] sendCommand failed:', { cmd: 'scan' })
        expect(gw.isConnected.value).toBe(false)
        warn.mockRestore()
      })

      it('未接続なら何も書かない', async () => {
        installSerialMock({ getPorts: vi.fn(async () => []) })
        await load()

        await gw.sendCommand({ cmd: 'scan' })
        expect(gw.isConnected.value).toBe(false)
      })
    })

    describe('ポートを失ったとき', () => {
      it('抜線 → serial の state を畳み、arbiter が掴み直す', async () => {
        const dev = createMockPort()
        await connectSerial(dev)
        dev.emit('{"type":"heartbeat","thermo":true,"bp":true}\n')
        await vi.advanceTimersByTimeAsync(0)
        expect(gw.thermometerConnected.value).toBe(true)

        dev.end()
        await vi.advanceTimersByTimeAsync(0)

        expect(gw.isConnected.value).toBe(false)
        expect(gw.transport.value).toBeNull()
        expect(gw.thermometerConnected.value).toBe(false)
        expect(gw.bloodPressureConnected.value).toBe(false)

        // 登録は残っている → 10 秒後の再スキャンで開き直す
        await vi.advanceTimersByTimeAsync(10000)
        expect(dev.port.open).toHaveBeenCalledTimes(2)
      })

      it('disconnect → 登録ごと降りるので探索しない', async () => {
        const dev = createMockPort()
        await connectSerial(dev)

        await gw.disconnect()
        expect(gw.isConnected.value).toBe(false)
        expect(gw.transport.value).toBeNull()

        await vi.advanceTimersByTimeAsync(30000)
        expect(dev.port.open).toHaveBeenCalledTimes(1)
      })
    })

    describe('scheduleReconnect (serial)', () => {
      it('heartbeat タイムアウトのあと掴み直せれば元に戻る', async () => {
        const dev = createMockPort()
        await connectSerial(dev)

        // heartbeat 断 → 掴み直しへ
        await vi.advanceTimersByTimeAsync(40000)
        expect(gw.isConnected.value).toBe(false)

        // arbiter の再スキャン + backoff 越しに復帰する
        dev.emit('{"type":"ready","version":"1.0.0"}\n')
        await vi.advanceTimersByTimeAsync(20000)
        expect(gw.isConnected.value).toBe(true)
        expect(gw.transport.value).toBe('serial')
      })

      it('掴み直せないまま上限に達したらエラーを出して諦める', async () => {
        const dev = createMockPort()
        await connectSerial(dev)
        installSerialMock({ getPorts: vi.fn(async () => []) })

        await vi.advanceTimersByTimeAsync(40000)
        // 2s, 4s, 8s ... と 10 回分の backoff (各回 claim の待ち 3 秒つき)
        await vi.advanceTimersByTimeAsync(300000)

        expect(gw.error.value).toBe('BLE ゲートウェイへの再接続に失敗しました')
        expect(gw.isConnected.value).toBe(false)
      })
    })

    describe('公開 API', () => {
      it('返すキーは #182 の前後で変わらない (呼び出し元は触らない)', () => {
        expect(Object.keys(gw).sort()).toEqual([
          'autoConnect',
          'bloodPressureConnected',
          'clearReadings',
          'connect',
          'disconnect',
          'error',
          'gatewayVersion',
          'hasMedicalData',
          'isConnected',
          'latestBloodPressure',
          'latestTemperature',
          'resetGateway',
          'sendCommand',
          'startAutoConnect',
          'thermometerConnected',
          'transport',
        ])
      })

      it('navigator.serial は直接列挙しない (探索は arbiter 経由の 1 回)', async () => {
        const dev = createMockPort()
        const getPorts = vi.fn(async () => [dev.port])
        installSerialMock({ getPorts })
        await load()
        dev.emit('{"type":"ready","version":"1.0.0"}\n')
        await autoConnect()

        expect(getPorts).toHaveBeenCalledTimes(1)
      })
    })
  })
})
