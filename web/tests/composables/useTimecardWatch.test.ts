import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withSetup } from '../helpers/with-setup'

/**
 * 打刻更新の購読 (Refs ippoan/alc-app-s3#134)。
 *
 * ここで固定したい不変条件は 3 つ:
 *   - `onopen` で無条件に 1 回引き直す (切断中の打刻は合図が来ない)
 *   - WS が繋がっていない間だけポーリングする (繋がったら止める = 二重取得しない)
 *   - トークンが無くても壊れない (未ペアリングのキオスク)
 */

let wsInstances: MockWebSocket[] = []

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  url: string
  protocols: string | string[] | undefined
  sent: string[] = []
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    wsInstances.push(this)
  }

  open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  message(data: string) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
}

function lastWs(): MockWebSocket {
  return wsInstances[wsInstances.length - 1]!
}

const envMock = vi.hoisted(() => ({ isClient: true }))
vi.mock('~/utils/env', () => envMock)

type Mod = typeof import('~/composables/useTimecardWatch')

/** 既定の runtime config (nuxt.config.ts) から組まれる購読 URL。 */
const WATCH_URL = 'wss://alc-recorder.m-tama-ramu.workers.dev/watch-timecard'

describe('useTimecardWatch', () => {
  let mod: Mod
  let originalWebSocket: typeof WebSocket

  beforeEach(async () => {
    wsInstances = []
    envMock.isClient = true
    originalWebSocket = globalThis.WebSocket
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.useFakeTimers()
    vi.resetModules()
    mod = await import('~/composables/useTimecardWatch')
  })

  afterEach(() => {
    vi.stubGlobal('WebSocket', originalWebSocket)
    vi.useRealTimers()
  })

  function make(overrides: Partial<Parameters<Mod['useTimecardWatch']>[0]> = {}) {
    const onChange = vi.fn()
    const watch = mod.useTimecardWatch({
      getToken: () => 'jwt-1',
      onChange,
      ...overrides,
    })
    return { watch, onChange }
  }

  describe('toTimecardWatchUrl', () => {
    it('https → wss、末尾スラッシュは落とす', () => {
      expect(mod.toTimecardWatchUrl('https://rec.example.com')).toBe('wss://rec.example.com/watch-timecard')
      expect(mod.toTimecardWatchUrl('https://rec.example.com/')).toBe('wss://rec.example.com/watch-timecard')
      expect(mod.toTimecardWatchUrl('http://localhost:8788')).toBe('ws://localhost:8788/watch-timecard')
    })

    it('未設定 (空文字 / スラッシュだけ) なら空文字', () => {
      expect(mod.toTimecardWatchUrl('')).toBe('')
      expect(mod.toTimecardWatchUrl('/')).toBe('')
    })
  })

  it('トークンを Sec-WebSocket-Protocol の 2 つ目に載せて繋ぐ', async () => {
    const { watch } = make()
    await watch.connect()
    expect(lastWs().url).toBe(WATCH_URL)
    expect(lastWs().protocols).toEqual(['alc.timecard.v1', 'jwt-1'])
    expect(watch.isConnected.value).toBe(false)
    lastWs().open()
    expect(watch.isConnected.value).toBe(true)
  })

  it('★ onopen で無条件に 1 回引き直す (切断中の打刻を取りこぼさない)', async () => {
    const { watch, onChange } = make()
    await watch.connect()
    expect(onChange).not.toHaveBeenCalled()
    lastWs().open()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('timecard_punch を受けたら引き直す。他の type / 非 JSON は無視する', async () => {
    const { watch, onChange } = make()
    await watch.connect()
    lastWs().open()
    onChange.mockClear()

    lastWs().message(JSON.stringify({ type: 'timecard_punch' }))
    expect(onChange).toHaveBeenCalledTimes(1)

    lastWs().message(JSON.stringify({ type: 'pong' }))
    lastWs().message('not-json')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('★ 繋がっている間はポーリングしない / 切れたら再開する', async () => {
    const { watch, onChange } = make()
    await watch.connect()
    // 接続前はポーリングが回る
    await vi.advanceTimersByTimeAsync(30_000)
    expect(onChange).toHaveBeenCalledTimes(1)

    lastWs().open()
    onChange.mockClear()
    // 接続中は WS だけ (ポーリングは止まっている)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onChange).not.toHaveBeenCalled()

    lastWs().close()
    onChange.mockClear()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('接続中は keepalive の ping を送る (DO の auto-response と完全一致する文字列)', async () => {
    // ずれると購読 WS が「上りを送った」と見なされて 1011 で切られる
    const { watch } = make()
    await watch.connect()
    const sock = lastWs()
    sock.open()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sock.sent).toEqual(['{"type":"ping"}'])
  })

  it('切断されたら再接続する (待ち時間は 2 倍ずつ伸びる)', async () => {
    const { watch } = make()
    await watch.connect()
    lastWs().open()
    lastWs().close()
    expect(wsInstances.length).toBe(1)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(wsInstances.length).toBe(2)

    // 2 本目も繋がる前に落ちると、次は 6 秒後
    lastWs().close()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(wsInstances.length).toBe(2)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(wsInstances.length).toBe(3)

    // 繋がったら待ち時間は初期値に戻る
    lastWs().open()
    lastWs().close()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(wsInstances.length).toBe(4)
  })

  it('★ トークンが無ければ WS を張らず、ポーリングだけで動く (未ペアリングのキオスク)', async () => {
    const { watch, onChange } = make({ getToken: () => null })
    await watch.connect()
    expect(wsInstances.length).toBe(0)
    expect(watch.isConnected.value).toBe(false)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('トークン取得が失敗 (reject) しても落ちない', async () => {
    const { watch } = make({ getToken: () => Promise.reject(new Error('mint failed')) })
    await expect(watch.connect()).resolves.toBeUndefined()
    expect(wsInstances.length).toBe(0)
  })

  it('後からトークンが取れれば再接続で繋がる (ペアリングは後からされることがある)', async () => {
    let token: string | null = null
    const { watch } = make({ getToken: () => token })
    await watch.connect()
    expect(wsInstances.length).toBe(0)

    token = 'jwt-late'
    await vi.advanceTimersByTimeAsync(3_000)
    expect(wsInstances.length).toBe(1)
    expect(lastWs().protocols).toEqual(['alc.timecard.v1', 'jwt-late'])
  })

  it('WebSocket の生成が例外を投げても落ちず、再接続に回る', async () => {
    vi.stubGlobal('WebSocket', class { constructor() { throw new Error('blocked') } })
    const { watch } = make()
    await watch.connect()
    expect(watch.isConnected.value).toBe(false)

    vi.stubGlobal('WebSocket', MockWebSocket)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(wsInstances.length).toBe(1)
  })

  it('二重に connect しても WS は 1 本 (ポーリングも 1 本)', async () => {
    let resolveToken: (v: string) => void = () => {}
    const { watch, onChange } = make({
      getToken: () => new Promise<string>((r) => { resolveToken = r }),
    })
    // token 待ちの最中にもう 1 回呼ぶ
    const first = watch.connect()
    const second = watch.connect()
    resolveToken('jwt-1')
    await first
    await second
    expect(wsInstances.length).toBe(1)

    // 接続済みで呼んでも増えない
    lastWs().open()
    await watch.connect()
    expect(wsInstances.length).toBe(1)

    onChange.mockClear()
    lastWs().close()
    await vi.advanceTimersByTimeAsync(30_000)
    // ポーリングが二重に回っていれば 2 回以上呼ばれる
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('トークンが無いまま connect を繰り返しても再接続タイマーは 1 本', async () => {
    const { watch } = make({ getToken: () => null })
    await watch.connect()
    await watch.connect()
    await vi.advanceTimersByTimeAsync(3_000)
    // 予約が二重なら 2 本張られる
    expect(wsInstances.length).toBe(0)
  })

  it('stop() で WS もポーリングも再接続も止まる', async () => {
    const { watch, onChange } = make()
    await watch.connect()
    lastWs().open()
    onChange.mockClear()

    watch.stop()
    expect(watch.isConnected.value).toBe(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(onChange).not.toHaveBeenCalled()
    expect(wsInstances.length).toBe(1)
  })

  it('stop() 後の connect は何もしない (WS を張らない)', async () => {
    const { watch } = make()
    watch.stop()
    await watch.connect()
    expect(wsInstances.length).toBe(0)
  })

  it('再接続待ちの最中に stop() しても再接続しない', async () => {
    const { watch } = make({ getToken: () => null })
    await watch.connect()
    watch.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(wsInstances.length).toBe(0)
  })

  it('token 待ちの最中に stop() されたら WS を張らない', async () => {
    let resolveToken: (v: string) => void = () => {}
    const { watch } = make({
      getToken: () => new Promise<string>((r) => { resolveToken = r }),
    })
    const pending = watch.connect()
    watch.stop()
    resolveToken('jwt-1')
    await pending
    expect(wsInstances.length).toBe(0)
  })

  it('SSR (client でない) では何もしない', async () => {
    envMock.isClient = false
    const { watch, onChange } = make()
    await watch.connect()
    expect(wsInstances.length).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('unmount で購読を止める', async () => {
    const onChange = vi.fn()
    const [watch, app] = withSetup(() =>
      mod.useTimecardWatch({ getToken: () => 'jwt-1', onChange }),
    )
    await watch.connect()
    lastWs().open()
    onChange.mockClear()

    app.unmount()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(onChange).not.toHaveBeenCalled()
  })
})
