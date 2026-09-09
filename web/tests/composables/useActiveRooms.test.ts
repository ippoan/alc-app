import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
})
