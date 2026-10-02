import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { devDeviceJwt, plainDeviceJwt } from '../helpers/dummy-jwt'

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
    useState<string[]>('active-rooms-handled').value = []
  })

  afterEach(() => {
    localStorage.clear()
    vi.stubGlobal('WebSocket', originalWebSocket)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('初期状態は未購読で room 一覧は空', () => {
    const { activeRooms, isWatching, joinedRoomId, callingRooms } = useActiveRooms()
    expect(activeRooms.value).toEqual([])
    expect(callingRooms.value).toEqual([])
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

  // --- 着信として数える部屋 (Refs ippoan/alc-app#387) ---

  describe('着信として数える部屋 (callingRooms)', () => {
    /** 購読を張って一覧を流す */
    function startWithRooms(rooms: string[]) {
      const api = startOpened(useActiveRooms)
      pushRooms(rooms)
      return api
    }

    function pushRooms(rooms: string[]) {
      lastWs().simulateMessage(JSON.stringify({ type: 'rooms_updated', rooms }))
    }

    it('★ 回帰: 部屋が立っていて未参加なら全部を数え、どれかに入っている間は 0', () => {
      const { callingRooms, setJoined } = startWithRooms(['room-a', 'it-s1'])
      expect(callingRooms.value).toEqual(['room-a', 'it-s1'])

      setJoined('room-a')
      expect(callingRooms.value).toEqual([])
    })

    it.each([['遠隔点呼', 'room-a'], ['IT点呼', 'it-s1']])('★ 判定を保存した %s の部屋は、通話を抜けて一覧に残っていても数えない', (_label, roomId) => {
      const { callingRooms, setJoined, markHandled } = startWithRooms([roomId])

      setJoined(roomId)
      markHandled(roomId)
      setJoined(null)

      expect(callingRooms.value).toEqual([])
    })

    it.each([['遠隔点呼', 'room-a'], ['IT点呼', 'it-s1']])('★ 判定を保存せずに通話を抜けた %s の部屋 (自分で閉じた・通信が切れて落ちた) は数える', (_label, roomId) => {
      const { callingRooms, setJoined } = startWithRooms([roomId])

      setJoined(roomId)
      setJoined(null)

      expect(callingRooms.value).toEqual([roomId])
      expect(useState<string[]>('active-rooms-handled').value).toEqual([])
    })

    it('通話なしで判定を保存した部屋 (入らないままの markHandled) も数えない', () => {
      const { callingRooms, markHandled } = startWithRooms(['it-s1'])

      markHandled('it-s1')

      expect(callingRooms.value).toEqual([])
    })

    it('判定を保存した部屋が在っても、別の部屋が待っていれば数える', () => {
      const { callingRooms, markHandled } = startWithRooms(['room-a'])
      markHandled('room-a')

      pushRooms(['room-a', 'room-b'])

      expect(callingRooms.value).toEqual(['room-b'])
    })

    it('判定を保存した部屋が一覧から消え、同じ id が再び現れたら新しい着信として数える', () => {
      const { callingRooms, markHandled } = startWithRooms(['room-a'])
      markHandled('room-a')

      pushRooms([])
      expect(callingRooms.value).toEqual([])
      pushRooms(['room-a'])

      expect(callingRooms.value).toEqual(['room-a'])
    })

    it('reload で取り直した一覧から消えていても、印は消える', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rooms: [] }) })
      vi.stubGlobal('fetch', fetchMock)
      const { callingRooms, markHandled, reload } = startWithRooms(['room-a'])
      markHandled('room-a')
      expect(callingRooms.value).toEqual([])

      await reload()
      pushRooms(['room-a'])

      expect(callingRooms.value).toEqual(['room-a'])
    })

    it('一覧に無い部屋は印にしない (後で同じ id が現れたら数える)', () => {
      const { callingRooms, markHandled } = startWithRooms([])

      markHandled('room-a')
      expect(useState<string[]>('active-rooms-handled').value).toEqual([])
      pushRooms(['room-a'])

      expect(callingRooms.value).toEqual(['room-a'])
    })

    // 画面共有の部屋は「視聴を始めた」で印にする (setJoined は使わない)。見ている間も
    // 点呼の着信は数え続ける
    it('★ 画面共有の部屋を印にしても、ほかの着信 (IT点呼・遠隔点呼) は数え続ける', () => {
      const { callingRooms, markHandled, joinedRoomId } = startWithRooms(['screen-a', 'it-s1', 'room-a'])

      markHandled('screen-a')

      expect(callingRooms.value).toEqual(['it-s1', 'room-a'])
      expect(joinedRoomId.value).toBeNull()

      // 見ている間に新しい着信が来ても数える。画面共有が終わって部屋が消えても変わらない
      pushRooms(['screen-a', 'it-s1', 'room-a', 'it-s2'])
      expect(callingRooms.value).toEqual(['it-s1', 'room-a', 'it-s2'])
      pushRooms(['it-s1', 'room-a', 'it-s2'])
      expect(callingRooms.value).toEqual(['it-s1', 'room-a', 'it-s2'])
    })

    it('印にした画面共有の部屋だけが在るあいだは着信なし。別の画面共有が始まれば数える', () => {
      const { callingRooms, markHandled } = startWithRooms(['screen-a'])
      markHandled('screen-a')
      expect(callingRooms.value).toEqual([])

      pushRooms(['screen-a', 'screen-b'])
      expect(callingRooms.value).toEqual(['screen-b'])
    })

    it('同じ部屋の判定を押し直しても、印は 1 つだけ', () => {
      const { markHandled } = startWithRooms(['room-a'])

      markHandled('room-a')
      markHandled('room-a')

      expect(useState<string[]>('active-rooms-handled').value).toEqual(['room-a'])
    })
  })

  // --- 購読を張った後に dev の印が変わる (Refs ippoan/alc-app#387) ---

  describe('購読を張った後に印が変わる', () => {
    const flush = () => vi.advanceTimersByTimeAsync(0)
    /** 印を書き換える口 (useActiveRooms と同じ module の実体を使う) */
    const marks = () => import('~/utils/token-selection')

    let fetchMock: ReturnType<typeof vi.fn>
    let fetchedRooms: string[]

    beforeEach(() => {
      fetchedRooms = []
      fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ rooms: fetchedRooms }) }))
      vi.stubGlobal('fetch', fetchMock)
      tokenMocks.getManagerJwt.mockResolvedValue(MANAGER_TOKEN)
    })

    async function loadAsDev() {
      localStorage.setItem(MANAGER_MARK_KEY, '1')
      vi.resetModules()
      return (await import('~/composables/useActiveRooms')).useActiveRooms()
    }

    it('★ 印なしで張った購読は、印が立ったら token 付きで張り直し、古い一覧を着信として数えない', async () => {
      const { activeRooms, callingRooms, isWatching, stop } = startOpened(useActiveRooms)
      const first = lastWs()
      first.simulateMessage(JSON.stringify({ type: 'rooms_updated', rooms: ['prod-room'] }))
      expect(callingRooms.value).toEqual(['prod-room'])
      fetchedRooms = ['it-dev-1']

      ;(await marks()).noteDeviceToken('manager-device', MANAGER_TOKEN)

      // その場で古い購読を閉じ、一覧を空にする (トークンを待つ前)
      expect(first.readyState).toBe(MockWebSocket.CLOSED)
      expect(activeRooms.value).toEqual([])
      expect(callingRooms.value).toEqual([])
      expect(isWatching.value).toBe(false)

      await flush()
      expect(wsInstances).toHaveLength(2)
      expect(lastWs().url).toBe(`ws://localhost:8787/watch-rooms${TOKEN_QUERY}`)
      expect(fetchMock.mock.calls).toEqual([[`http://localhost:8787/active-rooms${TOKEN_QUERY}`]])
      expect(activeRooms.value).toEqual(['it-dev-1'])

      // 閉じた古い購読に遅れて届く frame では一覧を変えず、張り直しも重ねない
      first.simulateMessage(JSON.stringify({ type: 'rooms_updated', rooms: ['prod-room'] }))
      first.onclose?.(new CloseEvent('close'))
      await vi.advanceTimersByTimeAsync(10000)
      expect(activeRooms.value).toEqual(['it-dev-1'])
      expect(wsInstances).toHaveLength(2)
      stop()
    })

    it('★ 印ありで張った購読は、印が外れたら token なしで張り直す', async () => {
      const { start, stop, activeRooms } = await loadAsDev()
      start()
      await flush()
      const first = lastWs()
      first.simulateOpen()
      first.simulateMessage(JSON.stringify({ type: 'rooms_updated', rooms: ['it-dev-1'] }))
      fetchMock.mockClear()

      ;(await marks()).clearDevDeviceMark('manager-device')

      expect(first.readyState).toBe(MockWebSocket.CLOSED)
      expect(activeRooms.value).toEqual([])
      // 印が無い側は同期の流れの中で張る
      expect(wsInstances).toHaveLength(2)
      expect(lastWs().url).toBe('ws://localhost:8787/watch-rooms')
      expect(fetchMock.mock.calls).toEqual([['http://localhost:8787/active-rooms']])
      stop()
    })

    it('トークンを待っている途中で印が外れたら、待っていた token 付きの購読は作らない', async () => {
      let resolveToken!: (token: string) => void
      tokenMocks.getManagerJwt.mockImplementationOnce(() => new Promise<string>((r) => { resolveToken = r }))
      const { start, stop } = await loadAsDev()
      start()

      ;(await marks()).clearDevDeviceMark('manager-device')
      resolveToken(MANAGER_TOKEN)
      await flush()

      expect(wsInstances.map(w => w.url)).toEqual(['ws://localhost:8787/watch-rooms'])
      stop()
    })

    it('張り直しを待つ timer が残っていても、張り直しは 1 本だけ', async () => {
      const { stop } = startOpened(useActiveRooms)
      lastWs().close() // 3 秒後の張り直しを待っている

      ;(await marks()).noteDeviceToken('manager-device', MANAGER_TOKEN)
      await vi.advanceTimersByTimeAsync(10000)

      expect(wsInstances.map(w => w.url)).toEqual([
        'ws://localhost:8787/watch-rooms',
        `ws://localhost:8787/watch-rooms${TOKEN_QUERY}`,
      ])
      stop()
    })

    it('張り直した後も ping は新しい購読にだけ送る', async () => {
      const { stop } = startOpened(useActiveRooms)
      const first = lastWs()

      ;(await marks()).noteDeviceToken('manager-device', MANAGER_TOKEN)
      await flush()
      lastWs().simulateOpen()
      await vi.advanceTimersByTimeAsync(30000)

      expect(first.sent).toEqual([])
      expect(lastWs().sent).toEqual(['ping'])
      stop()
    })

    it('★ 参照カウントは変えない (張り直しの後も start 2 回 → stop 2 回で閉じる)', async () => {
      const { start, stop } = useActiveRooms()
      start()
      start()

      ;(await marks()).noteDeviceToken('manager-device', MANAGER_TOKEN)
      await flush()
      lastWs().simulateOpen()

      stop()
      expect(lastWs().readyState).toBe(MockWebSocket.OPEN)
      stop()
      expect(lastWs().readyState).toBe(MockWebSocket.CLOSED)
    })

    it('軸が同じなら張り直さない (キオスク・測定台の印が変わっただけ)', async () => {
      const { activeRooms, stop } = startOpened(useActiveRooms)
      lastWs().simulateMessage(JSON.stringify({ type: 'rooms_updated', rooms: ['room-a'] }))
      const { noteDeviceToken, clearDevDeviceMark } = await marks()

      noteDeviceToken('kiosk', devDeviceJwt('dev-kiosk'))
      noteDeviceToken('bp-station', devDeviceJwt('dev-bp'))
      clearDevDeviceMark('kiosk')
      await flush()

      expect(wsInstances).toHaveLength(1)
      expect(lastWs().readyState).toBe(MockWebSocket.OPEN)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(activeRooms.value).toEqual(['room-a'])
      stop()
    })

    it('★ 印の無い席では張り直しが 1 度も走らない (dev でない鍵のトークンを取っても同じ)', async () => {
      const listen = vi.spyOn(window, 'dispatchEvent')
      const { activeRooms, callingRooms, stop } = startOpened(useActiveRooms)
      lastWs().simulateMessage(JSON.stringify({ type: 'rooms_updated', rooms: ['room-a'] }))

      ;(await marks()).noteDeviceToken('manager-device', plainDeviceJwt('plain-manager'))
      await vi.advanceTimersByTimeAsync(60000)

      expect(listen).not.toHaveBeenCalled()
      expect(wsInstances).toHaveLength(1)
      expect(lastWs().url).toBe('ws://localhost:8787/watch-rooms')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(tokenMocks.useManagerDeviceToken).not.toHaveBeenCalled()
      expect(activeRooms.value).toEqual(['room-a'])
      expect(callingRooms.value).toEqual(['room-a'])
      listen.mockRestore()
      stop()
    })

    it('最後の stop の後は、印が変わっても張り直さない', async () => {
      const { stop } = startOpened(useActiveRooms)
      stop()

      ;(await marks()).noteDeviceToken('manager-device', MANAGER_TOKEN)
      await vi.advanceTimersByTimeAsync(10000)

      expect(wsInstances).toHaveLength(1)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('reload を待つあいだに印が変わったら、古い軸の一覧は捨てて false を返す', async () => {
      let resolveFetch!: (res: unknown) => void
      fetchMock.mockImplementationOnce(() => new Promise((r) => { resolveFetch = r }))
      const { reload, activeRooms } = useActiveRooms()

      const pending = reload()
      ;(await marks()).noteDeviceToken('manager-device', MANAGER_TOKEN)
      resolveFetch({ ok: true, json: async () => ({ rooms: ['prod-room'] }) })

      await expect(pending).resolves.toBe(false)
      expect(activeRooms.value).toEqual([])
    })
  })
})
