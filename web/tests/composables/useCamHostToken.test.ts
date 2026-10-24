import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

// useCamHostToken は module スコープに登録済みの印・タイマー・世代を持つので、
// テスト毎に resetModules + dynamic import で分離する (useManagerDeviceToken.test.ts と同じ流儀)。
async function load() {
  return (await import('~/composables/useCamHostToken'))
}

const AUTH_BASE = 'https://auth.ippoan.org'
const EXT_ID = 'icmmpdjddlphkbokdalofdjpkcgfiggd'

const coreS3 = vi.hoisted(() => ({
  isConnected: false,
  open: [] as Array<() => void>,
  close: [] as Array<() => void>,
  request: vi.fn(),
}))
mockNuxtImport('useCoreS3Serial', () => () => ({
  request: coreS3.request,
  onOpen: (cb: () => void) => {
    coreS3.open.push(cb)
    if (coreS3.isConnected) cb()
  },
  onClose: (cb: () => void) => { coreS3.close.push(cb) },
}))

const getDeviceJwt = vi.hoisted(() => vi.fn())
mockNuxtImport('useDeviceToken', () => () => ({ getDeviceJwt }))

const signMock = vi.hoisted(() => vi.fn())
vi.mock('~/utils/alarm-sign', () => ({ signAlarmDeviceNonce: signMock }))

let sendMessage: ReturnType<typeof vi.fn>

function connect() {
  coreS3.isConnected = true
  for (const cb of coreS3.open) cb()
}
function disconnect() {
  coreS3.isConnected = false
  for (const cb of coreS3.close) cb()
}

/** nonce → token を n 回ぶん返す fetch */
function stubFetch(times = 1, tokenBody: Record<string, unknown> = { access_token: 'a.b.c', expires_in: 900 }) {
  const fetchMock = vi.fn()
  for (let i = 0; i < times; i++) {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: `n${i}` }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => tokenBody })
  }
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-24T00:00:00Z'))
  coreS3.isConnected = false
  coreS3.open = []
  coreS3.close = []
  coreS3.request.mockReset()
  getDeviceJwt.mockReset().mockResolvedValue('kiosk.jwt.x')
  signMock.mockReset().mockResolvedValue({ pubkey: 'pk', sig: 'sg' })
  sendMessage = vi.fn((_id: string, _msg: unknown, cb: () => void) => cb())
  vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useCamHostToken', () => {
  it('CoreS3 が繋がったら CoreS3 の署名で cam-host の鍵を取り、拡張へ渡す', async () => {
    const fetchMock = stubFetch()
    const { useCamHostToken } = await load()
    useCamHostToken()
    expect(fetchMock).not.toHaveBeenCalled()

    connect()
    await vi.runOnlyPendingTimersAsync()
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))

    expect(getDeviceJwt).toHaveBeenCalled()
    expect(fetchMock.mock.calls[0]![0]).toBe(`${AUTH_BASE}/device/alarm-nonce?usage=cam-host`)
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe(`${AUTH_BASE}/device/alarm-token`)
    expect(JSON.parse(init.body as string)).toEqual({ nonce: 'n0', pubkey: 'pk', sig: 'sg', usage: 'cam-host' })
    expect(signMock).toHaveBeenCalledWith('n0', coreS3.request)
    const [id, msg] = sendMessage.mock.calls[0]!
    expect(id).toBe(EXT_ID)
    expect(msg).toEqual({ type: 'cam_host_token', token: 'a.b.c', exp: Date.parse('2026-10-24T00:00:00Z') / 1000 + 900 })
  })

  it('期限の 60 秒前に取り直して渡し直す / 2 回呼んでも登録は 1 回', async () => {
    stubFetch(2, { access_token: 'a.b.c' }) // expires_in 欠落 → 900 秒
    const { useCamHostToken, REFRESH_BEFORE_MS } = await load()
    useCamHostToken()
    useCamHostToken()
    connect()
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(coreS3.open).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(900_000 - REFRESH_BEFORE_MS - 1000)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))
  })

  it('失敗したら段と status だけ warn し、RETRY_MS 後に試し直す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: 'n0' }) })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: 'n1' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'x.y.z', expires_in: 900 }) })
    vi.stubGlobal('fetch', fetchMock)
    const { useCamHostToken, RETRY_MS } = await load()
    useCamHostToken()
    connect()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[useCamHostToken] 拡張の鍵の取得に失敗 stage=token-exchange status=401'))
    expect(sendMessage).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(RETRY_MS)
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect((sendMessage.mock.calls[0]![1] as { token: string }).token).toBe('x.y.z')
  })

  it.each([
    ['nonce の http 失敗', [{ ok: false, status: 503, json: async () => ({}) }], 'stage=nonce status=503'],
    ['nonce 欠落', [{ ok: true, status: 200, json: async () => ({}) }], 'stage=nonce status=-'],
    ['access_token 欠落', [
      { ok: true, status: 200, json: async () => ({ nonce: 'n' }) },
      { ok: true, status: 200, json: async () => ({}) },
    ], 'stage=token-exchange status=-'],
  ])('%s', async (_label, responses, expected) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn()
    for (const r of responses) fetchMock.mockResolvedValueOnce(r)
    vi.stubGlobal('fetch', fetchMock)
    const { useCamHostToken } = await load()
    useCamHostToken()
    connect()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(`[useCamHostToken] 拡張の鍵の取得に失敗 ${expected}`))
  })

  it('署名の parse に失敗 / 署名要求が reject しても warn して止まらない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch()
    signMock.mockResolvedValueOnce(null)
    const { useCamHostToken } = await load()
    useCamHostToken()
    connect()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[useCamHostToken] 拡張の鍵の取得に失敗 stage=sign status=-'))
  })

  it('キオスクの鍵の取得が throw しても cam-host の鍵は取りに行く', async () => {
    getDeviceJwt.mockRejectedValueOnce(new Error('x'))
    stubFetch()
    const { useCamHostToken } = await load()
    useCamHostToken()
    connect()
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
  })

  it('chrome.runtime.sendMessage が無ければ鍵を取りにも行かない', async () => {
    vi.stubGlobal('chrome', undefined)
    const fetchMock = stubFetch()
    const { useCamHostToken } = await load()
    useCamHostToken()
    connect()
    await vi.advanceTimersByTimeAsync(1000)
    expect(getDeviceJwt).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('拡張が無くて sendMessage が throw しても静かに次の取り直しを予約する', async () => {
    sendMessage.mockImplementation(() => { throw new Error('Could not establish connection') })
    stubFetch(2)
    const { useCamHostToken } = await load()
    useCamHostToken()
    connect()
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(900_000)
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))
  })

  it('CoreS3 が切れたら取り直しをやめ、取得中に切れた結果は渡さない', async () => {
    stubFetch(3)
    const { useCamHostToken } = await load()
    useCamHostToken()
    connect()
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    disconnect()
    await vi.advanceTimersByTimeAsync(900_000)
    expect(sendMessage).toHaveBeenCalledTimes(1)

    // 取得中 (キオスクの鍵待ち・署名待ち) に切れたら渡さない
    let releaseKiosk!: () => void
    getDeviceJwt.mockImplementationOnce(() => new Promise<void>((r) => { releaseKiosk = r }))
    connect()
    disconnect()
    releaseKiosk()
    let releaseSign!: (v: unknown) => void
    signMock.mockImplementationOnce(() => new Promise((r) => { releaseSign = r }))
    connect()
    await vi.waitFor(() => expect(signMock).toHaveBeenCalledTimes(2))
    disconnect()
    releaseSign({ pubkey: 'pk', sig: 'sg' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
