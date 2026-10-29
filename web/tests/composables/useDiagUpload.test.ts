import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

// 診断ログの送り待ちを signaling の /device-log へ送る (Cloudflare のログに 7 日残す)
const deviceToken = vi.hoisted(() => ({ getDeviceJwt: vi.fn() }))
mockNuxtImport('useDeviceToken', () => () => deviceToken)

const OUTBOX = 'alc_serial_diag_outbox'

/** 署名はダミー (sub を読むだけ) */
function jwtWithSub(sub: unknown): string {
  const seg = (v: unknown) => btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${seg({ alg: 'none' })}.${seg({ sub })}.sig`
}

async function load() {
  vi.resetModules()
  return await import('~/composables/useDiagUpload')
}

describe('useDiagUpload', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorage.removeItem(OUTBOX)
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetchMock)
    deviceToken.getDeviceJwt.mockReset().mockResolvedValue(jwtWithSub('alarm:0123456789abcdef'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    localStorage.removeItem(OUTBOX)
  })

  it('送り待ちが空なら何も送らない', async () => {
    const { flushDiagOutbox } = await load()
    await flushDiagOutbox('https://signal.example')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('端末の sub で名乗って /device-log へ送り、送り待ちを空にする (ws の URL は https に直す)', async () => {
    localStorage.setItem(OUTBOX, JSON.stringify(['09:00:00.000 dev EVT THERMO_CONN try']))
    const { flushDiagOutbox } = await load()
    await flushDiagOutbox('wss://signal.example/')

    expect(fetchMock).toHaveBeenCalledWith('https://signal.example/device-log', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      device_id: 'alarm:0123456789abcdef',
      tag: 'pwa-diag',
      lines: ['09:00:00.000 dev EVT THERMO_CONN try'],
    })
    expect(localStorage.getItem(OUTBOX)).toBeNull()

    await flushDiagOutbox('ws://localhost:8787')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('200 行ずつに分けて送る', async () => {
    localStorage.setItem(OUTBOX, JSON.stringify(Array.from({ length: 250 }, (_, i) => `dev ${i}`)))
    const { flushDiagOutbox } = await load()
    await flushDiagOutbox('http://localhost:8787')
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:8787/device-log')
    expect(fetchMock.mock.calls.map(c => JSON.parse(c[1].body).lines.length)).toEqual([200, 50])
  })

  it('送れなかった塊から後ろを送り待ちへ戻す (HTTP エラー / 例外)', async () => {
    localStorage.setItem(OUTBOX, JSON.stringify(Array.from({ length: 250 }, (_, i) => `dev ${i}`)))
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 }).mockResolvedValueOnce({ ok: false, status: 500 })
    const { flushDiagOutbox } = await load()
    await flushDiagOutbox('https://signal.example')
    expect(JSON.parse(localStorage.getItem(OUTBOX)!)).toHaveLength(50)

    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    await flushDiagOutbox('https://signal.example')
    expect(JSON.parse(localStorage.getItem(OUTBOX)!)).toEqual(Array.from({ length: 50 }, (_, i) => `dev ${i + 200}`))
  })

  it('端末の鍵が無い・sub が文字列でない・取得が投げるときは (none) で名乗る', async () => {
    const { flushDiagOutbox } = await load()
    for (const setup of [
      () => deviceToken.getDeviceJwt.mockResolvedValueOnce(null),
      () => deviceToken.getDeviceJwt.mockResolvedValueOnce(jwtWithSub(1)),
      () => deviceToken.getDeviceJwt.mockRejectedValueOnce(new Error('no device')),
    ]) {
      setup()
      localStorage.setItem(OUTBOX, JSON.stringify(['dev x']))
      await flushDiagOutbox('https://signal.example')
    }
    expect(fetchMock.mock.calls.map(c => JSON.parse(c[1].body).device_id)).toEqual(['(none)', '(none)', '(none)'])
  })

  it('useDiagUpload は 1 分ごとに送り、2 回呼んでも周期は 1 つ', async () => {
    vi.useFakeTimers()
    const { useDiagUpload, DIAG_UPLOAD_INTERVAL_MS } = await load()
    useDiagUpload()
    useDiagUpload()
    localStorage.setItem(OUTBOX, JSON.stringify(['dev x']))
    await vi.advanceTimersByTimeAsync(DIAG_UPLOAD_INTERVAL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // テストの環境の signalingUrl (nuxt.config の既定)
    expect(fetchMock.mock.calls[0]![0]).toBe(`${String(useRuntimeConfig().public.signalingUrl).replace(/\/$/, '')}/device-log`)
  })
})
