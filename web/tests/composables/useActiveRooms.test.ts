import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { devDeviceJwt } from '../helpers/dummy-jwt'

// 運行管理者席の鍵のトークン (dev端末だけが使う。Refs ippoan/alc-app#387)
const tokenMocks = vi.hoisted(() => ({
  useManagerDeviceToken: vi.fn(),
  getManagerJwt: vi.fn(),
}))
mockNuxtImport('useManagerDeviceToken', () => tokenMocks.useManagerDeviceToken)

const MANAGER_TOKEN = devDeviceJwt('dev-manager')
const TOKEN_QUERY = `?token=${encodeURIComponent(MANAGER_TOKEN)}`
/** 運行管理者席の鍵の dev の印の保存先 (`~/utils/token-selection`) */
const MANAGER_MARK_KEY = 'alc_dev_device_manager-device'

// 生成された MockWebSocket をすべて記録する
let wsInstances: MockWebSocket[] = []

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  url: string
  sent: string[] = []
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    wsInstances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) return
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  simulateMessage(data: string) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  simulateError() {
    this.onerror?.(new Event('error'))
  }
}

function lastWs(): MockWebSocket {
  return wsInstances[wsInstances.length - 1]!
}

/** open まで済んだ購読を 1 本張る */
function startOpened(useActiveRooms: () => any) {
  const rooms = useActiveRooms()
  rooms.start()
  lastWs().simulateOpen()
  return rooms
}

describe('useActiveRooms', () => {
  let originalWebSocket: typeof WebSocket
  let useActiveRooms: typeof import('~/composables/useActiveRooms').useActiveRooms

  beforeEach(async () => {
    wsInstances = []
    originalWebSocket = globalThis.WebSocket
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.useFakeTimers()

    tokenMocks.useManagerDeviceToken.mockReset()
    tokenMocks.getManagerJwt.mockReset()
    tokenMocks.useManagerDeviceToken.mockReturnValue({ getManagerJwt: tokenMocks.getManagerJwt })
    localStorage.clear()

    // module スコープの参照カウント / socket を test ごとにリセットする
    vi.resetModules()
    const mod = await import('~/composables/useActiveRooms')
    useActiveRooms = mod.useActiveRooms

    // useState は Nuxt の payload に載るので module のリセットでは消えない
    useState<string[]>('active-rooms').value = []
    useState<boolean>('active-rooms-watching').value = false
    useState<string | null>('active-rooms-joined').value = null
  })

  afterEach(() => {
    localStorage.clear()
    vi.stubGlobal('WebSocket', originalWebSocket)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('初期状態は未購読で room 一覧は空', () => {
    const { activeRooms, isWatching, joinedRoomId } = useActiveRooms()
    expect(activeRooms.value).toEqual([])
    expect(isWatching.value).toBe(false)
    expect(joinedRoomId.value).toBeNull()
  })

  it('start で signaling の /watch-rooms へ繋ぐ', () => {
    const { start } = useActiveRooms()
    start()
    expect(wsInstances).toHaveLength(1)
    expect(lastWs().url).toBe('ws://localhost:8787/watch-rooms')
  })

  it('open で isWatching が true になる', () => {
    const { isWatching } = startOpened(useActiveRooms)
    expect(isWatching.value).toBe(true)
  })

  it('rooms_updated で room 一覧を更新する', () => {
    const { activeRooms } = startOpened(useActiveRooms)
    lastWs().simulateMessage(JSON.stringify({ type: 'rooms_updated', rooms: ['dev-1', 'screen-dev-1'] }))
    expect(activeRooms.value).toEqual(['dev-1', 'screen-dev-1'])
  })

  it('rooms_updated 以外の frame は無視する', () => {
    const { activeRooms } = startOpened(useActiveRooms)
    lastWs().simulateMessage(JSON.stringify({ type: 'pong' }))
    expect(activeRooms.value).toEqual([])
  })

  it('壊れた frame は捨てる', () => {
    const { activeRooms } = startOpened(useActiveRooms)
    expect(() => lastWs().simulateMessage('not json')).not.toThrow()
    expect(activeRooms.value).toEqual([])
  })

  it('30 秒ごとに ping を送る', () => {
    startOpened(useActiveRooms)
    const ws = lastWs()
    vi.advanceTimersByTime(30000)
    expect(ws.sent).toEqual(['ping'])
    vi.advanceTimersByTime(30000)
    expect(ws.sent).toEqual(['ping', 'ping'])
  })

  it('close で isWatching が false になり 3 秒後に再接続する', () => {
    const { isWatching } = startOpened(useActiveRooms)
    lastWs().close()
    expect(isWatching.value).toBe(false)
    expect(wsInstances).toHaveLength(1)

    vi.advanceTimersByTime(3000)
    expect(wsInstances).toHaveLength(2)
    lastWs().simulateOpen()
    expect(isWatching.value).toBe(true)
  })

  it('再接続後も ping は 1 本だけ (前の socket の timer は止まっている)', () => {
    startOpened(useActiveRooms)
    const first = lastWs()
    first.close()
    vi.advanceTimersByTime(3000)
    const second = lastWs()
    second.simulateOpen()

    vi.advanceTimersByTime(30000)
    expect(first.sent).toEqual([])
    expect(second.sent).toEqual(['ping'])
  })

  it('error で socket を閉じる (open 前なので ping timer は無い)', () => {
    const { start, isWatching } = useActiveRooms()
    start()
    lastWs().simulateError()
    expect(lastWs().readyState).toBe(MockWebSocket.CLOSED)
    expect(isWatching.value).toBe(false)
  })

  it('start 2 回 → stop 1 回では閉じず、2 回目で閉じる', () => {
    const { start, stop, isWatching } = useActiveRooms()
    start()
    start()
    expect(wsInstances).toHaveLength(1)
    lastWs().simulateOpen()

    stop()
    expect(lastWs().readyState).toBe(MockWebSocket.OPEN)
    expect(isWatching.value).toBe(true)

    stop()
    expect(lastWs().readyState).toBe(MockWebSocket.CLOSED)
    expect(isWatching.value).toBe(false)
  })

  it('stop 後は ping も再接続もしない', () => {
    const { start, stop } = startOpened(useActiveRooms) as any
    void start
    const ws = lastWs()
    stop()
    vi.advanceTimersByTime(60000)
    expect(ws.sent).toEqual([])
    expect(wsInstances).toHaveLength(1)
  })

  it('再接続待ちのあいだに stop すると再接続タイマーを止める', () => {
    const { stop } = startOpened(useActiveRooms)
    lastWs().close()
    stop()
    vi.advanceTimersByTime(10000)
    expect(wsInstances).toHaveLength(1)
  })

  it('参照カウントは負にならない (余分な stop は無視)', () => {
    const { start, stop } = useActiveRooms()
    stop()
    stop()
    start()
    expect(wsInstances).toHaveLength(1)
    stop()
    expect(lastWs().readyState).toBe(MockWebSocket.CLOSED)
  })

  it('別の呼び出しでも同じ購読を共有する (singleton)', () => {
    const a = useActiveRooms()
    const b = useActiveRooms()
    a.start()
    b.start()
    expect(wsInstances).toHaveLength(1)
    lastWs().simulateMessage(JSON.stringify({ type: 'rooms_updated', rooms: ['dev-1'] }))
    expect(b.activeRooms.value).toEqual(['dev-1'])
  })

  it('setJoined で joinedRoomId を出し入れできる', () => {
    const { setJoined, joinedRoomId } = useActiveRooms()
    setJoined('dev-1')
    expect(joinedRoomId.value).toBe('dev-1')
    setJoined(null)
    expect(joinedRoomId.value).toBeNull()
  })

  it('reload 成功で room 一覧を差し替え true を返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rooms: ['dev-1'] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { reload, activeRooms } = useActiveRooms()
    await expect(reload()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8787/active-rooms')
    expect(activeRooms.value).toEqual(['dev-1'])
  })

  it('reload が HTTP エラーなら false を返し一覧は変えない', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))

    const { reload, activeRooms } = useActiveRooms()
    await expect(reload()).resolves.toBe(false)
    expect(activeRooms.value).toEqual([])
  })

  it('reload が通信エラーなら false を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    const { reload } = useActiveRooms()
    await expect(reload()).resolves.toBe(false)
  })

  // --- dev端末の区別 (Refs ippoan/alc-app#387) ---

  describe('dev の印が無い席は今までどおり', () => {
    it('★ start() の同期の流れの中で、token なしの WebSocket ができている', () => {
      const { start } = useActiveRooms()

      start()

      // microtask を 1 つも流していない (変更前と同じ)
      expect(wsInstances).toHaveLength(1)
      expect(lastWs().url).toBe('ws://localhost:8787/watch-rooms')
      expect(tokenMocks.useManagerDeviceToken).not.toHaveBeenCalled()
    })

    it('★ reload() を待たずに呼んだ直後に、token なしの fetch が出ている', () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rooms: [] }) })
      vi.stubGlobal('fetch', fetchMock)
      const { reload } = useActiveRooms()

      void reload()

      expect(fetchMock.mock.calls).toEqual([['http://localhost:8787/active-rooms']])
      expect(tokenMocks.useManagerDeviceToken).not.toHaveBeenCalled()
    })

    it('キオスク・測定台の印は見ない (運行管理者席の鍵だけ)', async () => {
      localStorage.setItem('alc_dev_device_kiosk', '1')
      localStorage.setItem('alc_dev_device_bp-station', '1')
      vi.resetModules()
      const { start } = (await import('~/composables/useActiveRooms')).useActiveRooms()

      start()

      expect(lastWs().url).toBe('ws://localhost:8787/watch-rooms')
      expect(tokenMocks.useManagerDeviceToken).not.toHaveBeenCalled()
    })
  })

  describe('運行管理者席の鍵に dev の印がある席', () => {
    /** 印を保存した状態で module を読み直す (起動時に同期で読まれる) */
    async function loadAsDev() {
      localStorage.setItem(MANAGER_MARK_KEY, '1')
      vi.resetModules()
      return (await import('~/composables/useActiveRooms')).useActiveRooms()
    }

    /** 外から解決できる getter (トークンを待っている途中の状態を作る) */
    function deferToken() {
      let resolve!: (token: string | null) => void
      tokenMocks.getManagerJwt.mockImplementationOnce(() => new Promise<string | null>((r) => { resolve = r }))
      return (token: string | null) => resolve(token)
    }

    /** 待っている promise を流す (fake timers のままなので timer は進めない) */
    const flush = () => vi.advanceTimersByTimeAsync(0)

    it('/watch-rooms に ?token= を付けて繋ぐ', async () => {
      tokenMocks.getManagerJwt.mockResolvedValue(MANAGER_TOKEN)
      const { start, isWatching } = await loadAsDev()

      start()
      expect(wsInstances).toHaveLength(0)
      await flush()

      expect(wsInstances).toHaveLength(1)
      expect(lastWs().url).toBe(`ws://localhost:8787/watch-rooms${TOKEN_QUERY}`)
      lastWs().simulateOpen()
      expect(isWatching.value).toBe(true)
    })

    it('/active-rooms に ?token= を付けて読む', async () => {
      tokenMocks.getManagerJwt.mockResolvedValue(MANAGER_TOKEN)
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rooms: ['dev-1'] }) })
      vi.stubGlobal('fetch', fetchMock)
      const { reload, activeRooms } = await loadAsDev()

      await expect(reload()).resolves.toBe(true)

      expect(fetchMock.mock.calls).toEqual([[`http://localhost:8787/active-rooms${TOKEN_QUERY}`]])
      expect(activeRooms.value).toEqual(['dev-1'])
    })

    it('★ トークンが取れなければ fetch を出さず false を返す', async () => {
      tokenMocks.getManagerJwt.mockResolvedValue(null)
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const { reload } = await loadAsDev()

      await expect(reload()).resolves.toBe(false)

      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('★ トークンが取れなければ WebSocket を作らず、3 秒ごとに試し直す', async () => {
      tokenMocks.getManagerJwt.mockResolvedValue(null)
      const { start } = await loadAsDev()

      start()
      await flush()
      expect(wsInstances).toHaveLength(0)
      expect(tokenMocks.getManagerJwt).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(2999)
      expect(tokenMocks.getManagerJwt).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(tokenMocks.getManagerJwt).toHaveBeenCalledTimes(2)
      expect(wsInstances).toHaveLength(0)

      // 取れるようになったら次の回で繋がる
      tokenMocks.getManagerJwt.mockResolvedValue(MANAGER_TOKEN)
      await vi.advanceTimersByTimeAsync(3000)
      expect(wsInstances).toHaveLength(1)
      expect(lastWs().url).toBe(`ws://localhost:8787/watch-rooms${TOKEN_QUERY}`)
    })

    it('試し直しを待つあいだに stop すると、試し直さない', async () => {
      tokenMocks.getManagerJwt.mockResolvedValue(null)
      const { start, stop } = await loadAsDev()
      start()
      await flush()

      stop()
      await vi.advanceTimersByTimeAsync(10000)

      expect(tokenMocks.getManagerJwt).toHaveBeenCalledTimes(1)
      expect(wsInstances).toHaveLength(0)
    })

    it.each([[MANAGER_TOKEN], [null]])('トークンを待つあいだに stop されたら WebSocket を作らず、試し直しもしない (結果 %s)', async (token) => {
      const resolveToken = deferToken()
      const { start, stop } = await loadAsDev()

      start()
      stop()
      resolveToken(token)
      await vi.advanceTimersByTimeAsync(10000)

      expect(wsInstances).toHaveLength(0)
      expect(tokenMocks.getManagerJwt).toHaveBeenCalledTimes(1)
    })

    it('待つあいだに stop → start されても WebSocket は 1 本だけ', async () => {
      const resolveFirst = deferToken()
      const resolveSecond = deferToken()
      const { start, stop } = await loadAsDev()

      start()
      stop()
      start()
      resolveFirst(MANAGER_TOKEN)
      resolveSecond(MANAGER_TOKEN)
      await flush()

      expect(wsInstances).toHaveLength(1)
    })

    it('切断後の張り直しでも ?token= を付ける (間隔は 3 秒のまま)', async () => {
      tokenMocks.getManagerJwt.mockResolvedValue(MANAGER_TOKEN)
      const { start } = await loadAsDev()
      start()
      await flush()
      lastWs().simulateOpen()

      lastWs().close()
      await vi.advanceTimersByTimeAsync(2999)
      expect(wsInstances).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)

      expect(wsInstances).toHaveLength(2)
      expect(lastWs().url).toBe(`ws://localhost:8787/watch-rooms${TOKEN_QUERY}`)
    })
  })
})
