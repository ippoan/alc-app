import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useGwStatus } from '~/composables/useGwStatus'

// --- Mock WebSocket ---

type WsHandler = ((ev: any) => void) | null

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  static instances: MockWebSocket[] = []
  static throwOnConstruct = false

  readyState = MockWebSocket.CONNECTING
  url: string
  onopen: WsHandler = null
  onmessage: WsHandler = null
  onclose: WsHandler = null
  onerror: WsHandler = null
  closed = false

  constructor(url: string) {
    if (MockWebSocket.throwOnConstruct) {
      throw new Error('construct failed')
    }
    this.url = url
    MockWebSocket.instances.push(this)
  }

  close() {
    this.closed = true
    this.readyState = MockWebSocket.CLOSED
    if (this.onclose) this.onclose({})
  }

  // test helpers
  simulateMessage(data: any) {
    if (this.onmessage) this.onmessage({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }

  simulateError() {
    if (this.onerror) this.onerror({})
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED
    if (this.onclose) this.onclose({})
  }

  static byUrl(url: string): MockWebSocket | undefined {
    return MockWebSocket.instances.find(w => w.url === url)
  }
}

vi.stubGlobal('WebSocket', MockWebSocket)

// --- Mock fetch ---

function mockFetchHubOk(devices: string[] = []) {
  return vi.fn(async (url: string) => {
    if (String(url).includes('/api/hub/status')) {
      return { ok: true, json: async () => ({ devices }) } as Response
    }
    return { ok: true, json: async () => ({}) } as Response
  })
}

/** hub 到達 → 3 ブリッジすべて疎通 OK の応答を返す checkAll 完走ヘルパー */
async function checkAllWithBridges(gw: ReturnType<typeof useGwStatus>) {
  const promise = gw.checkAll()
  await vi.advanceTimersByTimeAsync(0) // fetch 解決 → probe 3 本開始
  MockWebSocket.byUrl('ws://127.0.0.1:9876')!.simulateMessage({ type: 'status', readers: ['cores3-01'], version: '0.1.5' })
  MockWebSocket.byUrl('ws://127.0.0.1:9877')!.simulateMessage({ type: 'ready', version: '0.1.5' })
  MockWebSocket.byUrl('ws://127.0.0.1:9877')!.simulateMessage({ type: 'heartbeat', thermo: true, bp: false })
  MockWebSocket.byUrl('ws://127.0.0.1:9878')!.simulateMessage({ type: 'connected' })
  await promise
}

describe('useGwStatus', () => {
  let gw: ReturnType<typeof useGwStatus>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    MockWebSocket.instances = []
    MockWebSocket.throwOnConstruct = false
    gw = useGwStatus()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.useRealTimers()
  })

  it('初期値が正しい', () => {
    expect(gw.checking.value).toBe(false)
    expect(gw.gwDetected.value).toBeNull()
    expect(gw.coreS3Devices.value).toEqual([])
    expect(gw.nfcBridge.value).toBeNull()
    expect(gw.bleBridge.value).toBeNull()
    expect(gw.fc1200Bridge.value).toBeNull()
    expect(gw.injecting.value).toBe(false)
    expect(gw.injectResult.value).toBeNull()
  })

  describe('checkAll — GW 未検出', () => {
    it('fetch 例外 → gwDetected=false、ブリッジ probe はしない', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unreachable') }))
      await gw.checkAll()
      expect(gw.gwDetected.value).toBe(false)
      expect(gw.coreS3Devices.value).toEqual([])
      expect(MockWebSocket.instances).toHaveLength(0)
    })

    it('fetch 非 2xx → gwDetected=false', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response))
      await gw.checkAll()
      expect(gw.gwDetected.value).toBe(false)
    })

    it('タイムアウト → abort されて gwDetected=false', async () => {
      vi.stubGlobal('fetch', vi.fn((_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
      ))
      const promise = gw.checkAll()
      await vi.advanceTimersByTimeAsync(3000)
      await promise
      expect(gw.gwDetected.value).toBe(false)
    })

    it('未検出後に再検出 → ブリッジ状態がリセットされてから再確認できる', async () => {
      vi.stubGlobal('fetch', mockFetchHubOk(['AS0D']))
      await checkAllWithBridges(gw)
      expect(gw.nfcBridge.value?.ok).toBe(true)

      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('gone') }))
      await gw.checkAll()
      expect(gw.gwDetected.value).toBe(false)
      expect(gw.nfcBridge.value).toBeNull()
      expect(gw.bleBridge.value).toBeNull()
      expect(gw.fc1200Bridge.value).toBeNull()
    })
  })

  describe('checkAll — GW 稼働中', () => {
    it('3 ブリッジ疎通 OK → 各 probe と CoreS3 デバイス名が入る', async () => {
      vi.stubGlobal('fetch', mockFetchHubOk(['AS0D3eqeb1E']))
      await checkAllWithBridges(gw)

      expect(gw.gwDetected.value).toBe(true)
      expect(gw.coreS3Devices.value).toEqual(['AS0D3eqeb1E'])
      expect(gw.nfcBridge.value).toEqual({ ok: true, detail: 'readers: cores3-01 / v0.1.5' })
      expect(gw.bleBridge.value).toEqual({ ok: true, detail: '体温計 ○ / 血圧計 × / v0.1.5' })
      expect(gw.fc1200Bridge.value).toEqual({ ok: true, detail: null })
      expect(gw.checking.value).toBe(false)
      // 使い捨て WS は全て閉じられている
      expect(MockWebSocket.instances.every(w => w.closed)).toBe(true)
    })

    it('devices 欠落レスポンス → 空配列として稼働中扱い', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response))
      const promise = gw.checkAll()
      await vi.advanceTimersByTimeAsync(0)
      for (const ws of MockWebSocket.instances) ws.simulateError()
      await promise
      expect(gw.gwDetected.value).toBe(true)
      expect(gw.coreS3Devices.value).toEqual([])
    })

    it('checkAll 中の再呼び出しは no-op', async () => {
      vi.stubGlobal('fetch', mockFetchHubOk())
      const promise = gw.checkAll()
      await vi.advanceTimersByTimeAsync(0)
      const before = MockWebSocket.instances.length
      await gw.checkAll() // checking=true 中 → 即 return
      expect(MockWebSocket.instances.length).toBe(before)
      for (const ws of MockWebSocket.instances) ws.simulateError()
      await promise
    })

    it('NFC: readers 0 件 → リーダー 0 件 / version なし → 表示は readers のみ', async () => {
      vi.stubGlobal('fetch', mockFetchHubOk())
      const promise = gw.checkAll()
      await vi.advanceTimersByTimeAsync(0)
      MockWebSocket.byUrl('ws://127.0.0.1:9876')!.simulateMessage({ type: 'status', readers: [] })
      MockWebSocket.byUrl('ws://127.0.0.1:9877')!.simulateError()
      MockWebSocket.byUrl('ws://127.0.0.1:9878')!.simulateError()
      await promise
      expect(gw.nfcBridge.value).toEqual({ ok: true, detail: 'リーダー 0 件' })
    })

    it('NFC: readers が配列でない → 0 件扱い', async () => {
      vi.stubGlobal('fetch', mockFetchHubOk())
      const promise = gw.checkAll()
      await vi.advanceTimersByTimeAsync(0)
      MockWebSocket.byUrl('ws://127.0.0.1:9876')!.simulateMessage({ type: 'status', readers: 'bogus', version: '1.0.0' })
      MockWebSocket.byUrl('ws://127.0.0.1:9877')!.simulateError()
      MockWebSocket.byUrl('ws://127.0.0.1:9878')!.simulateError()
      await promise
      expect(gw.nfcBridge.value).toEqual({ ok: true, detail: 'リーダー 0 件 / v1.0.0' })
    })

    it('BLE: heartbeat のみ (ready 欠落) でも OK になる', async () => {
      vi.stubGlobal('fetch', mockFetchHubOk())
      const promise = gw.checkAll()
      await vi.advanceTimersByTimeAsync(0)
      MockWebSocket.byUrl('ws://127.0.0.1:9876')!.simulateError()
      MockWebSocket.byUrl('ws://127.0.0.1:9877')!.simulateMessage({ type: 'heartbeat', thermo: false, bp: true })
      MockWebSocket.byUrl('ws://127.0.0.1:9878')!.simulateError()
      await promise
      expect(gw.bleBridge.value).toEqual({ ok: true, detail: '体温計 × / 血圧計 ○' })
    })

    it('対象外メッセージ / 不正 JSON は無視して待ち続ける → タイムアウトで NG', async () => {
      vi.stubGlobal('fetch', mockFetchHubOk())
      const promise = gw.checkAll()
      await vi.advanceTimersByTimeAsync(0)
      MockWebSocket.byUrl('ws://127.0.0.1:9876')!.simulateMessage({ type: 'unknown' })
      MockWebSocket.byUrl('ws://127.0.0.1:9876')!.simulateMessage('not-json{')
      MockWebSocket.byUrl('ws://127.0.0.1:9877')!.simulateMessage({ type: 'ready' }) // version なし → 無視
      MockWebSocket.byUrl('ws://127.0.0.1:9878')!.simulateMessage({ type: 'status' })
      await vi.advanceTimersByTimeAsync(3000)
      await promise
      expect(gw.nfcBridge.value).toEqual({ ok: false, detail: null })
      expect(gw.bleBridge.value).toEqual({ ok: false, detail: null })
      expect(gw.fc1200Bridge.value).toEqual({ ok: false, detail: null })
    })

    it('WS が拒否 (onclose) → NG', async () => {
      vi.stubGlobal('fetch', mockFetchHubOk())
      const promise = gw.checkAll()
      await vi.advanceTimersByTimeAsync(0)
      for (const ws of MockWebSocket.instances) ws.simulateClose()
      await promise
      expect(gw.nfcBridge.value).toEqual({ ok: false, detail: null })
      expect(gw.bleBridge.value).toEqual({ ok: false, detail: null })
      expect(gw.fc1200Bridge.value).toEqual({ ok: false, detail: null })
    })

    it('WS コンストラクタが throw → NG', async () => {
      vi.stubGlobal('fetch', mockFetchHubOk())
      const promise = gw.checkAll()
      MockWebSocket.throwOnConstruct = true
      await vi.advanceTimersByTimeAsync(0)
      await promise
      expect(gw.nfcBridge.value).toEqual({ ok: false, detail: null })
    })
  })

  describe('injectTemperature', () => {
    it('成功 → injectResult=success、既定値 36.5 を送る', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true }) as Response)
      vi.stubGlobal('fetch', fetchMock)
      await gw.injectTemperature()
      expect(gw.injectResult.value).toBe('success')
      const [url, opts] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
      expect(url).toBe('http://127.0.0.1:11984/api/hub/inject')
      expect(JSON.parse(String(opts.body))).toEqual({
        src: 'cores3',
        type: 'measurement',
        kind: 'temperature',
        payload: { type: 'temperature', value: 36.5, unit: 'celsius' },
      })
    })

    it('非 2xx → failure', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response))
      await gw.injectTemperature(37.0)
      expect(gw.injectResult.value).toBe('failure')
    })

    it('fetch 例外 → failure', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unreachable') }))
      await gw.injectTemperature()
      expect(gw.injectResult.value).toBe('failure')
    })

    it('注入中の再呼び出しは no-op', async () => {
      let resolveFetch: (v: Response) => void
      const fetchMock = vi.fn(() => new Promise<Response>((r) => { resolveFetch = r }))
      vi.stubGlobal('fetch', fetchMock)
      const first = gw.injectTemperature()
      await gw.injectTemperature() // injecting=true 中 → 即 return
      expect(fetchMock).toHaveBeenCalledTimes(1)
      resolveFetch!({ ok: true } as Response)
      await first
      expect(gw.injectResult.value).toBe('success')
    })

    it('checkAll で injectResult がクリアされる', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ devices: [] }) }) as Response))
      await gw.injectTemperature()
      expect(gw.injectResult.value).toBe('success')
      const promise = gw.checkAll()
      expect(gw.injectResult.value).toBeNull()
      await vi.advanceTimersByTimeAsync(0)
      for (const ws of MockWebSocket.instances) ws.simulateError()
      await promise
    })
  })
})
