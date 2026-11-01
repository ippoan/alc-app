import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { clearVeinLines, recordVeinLine } from '~/utils/vein-line-log'
import {
  isVeinLogTrigger,
  useVeinLogUpload,
  VEIN_LOG_EVENT_DELAY_MS,
  VEIN_LOG_MIN_GAP_MS,
  VEIN_LOG_PERIODIC_MS,
} from '~/composables/useVeinLogUpload'

// Vein Station の行を recorder の POST /device-log へ上げる (Refs ippoan/alc-app-s3#352)
const connected = ref(true)
mockNuxtImport('useVeinSerial', () => () => ({ isConnected: connected }))
const getDeviceJwt = vi.fn(async (): Promise<string | null> => 'kiosk-jwt')
mockNuxtImport('useDeviceToken', () => () => ({ getDeviceJwt }))

const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))

function sentBodies(): Array<{ source: string, reason: string, text: string }> {
  return fetchMock.mock.calls.map(c => JSON.parse((c as unknown as [string, RequestInit])[1].body as string))
}

describe('isVeinLogTrigger', () => {
  it('体温計の値が無かった・失敗した行だけ', () => {
    expect(isVeinLogTrigger('EVT THERMO_RX none')).toBe(true)
    expect(isVeinLogTrigger('EVT THERMO_RX err')).toBe(true)
    expect(isVeinLogTrigger('EVT THERMO_RX ok')).toBe(false)
    expect(isVeinLogTrigger('dev EVT THERMO_RX none')).toBe(false)
  })
})

describe('useVeinLogUpload', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockClear()
    getDeviceJwt.mockClear()
    clearVeinLines()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('upload: 溜めた行を Bearer の端末 token で POST /device-log へ送る', async () => {
    recordVeinLine('EVT THERMO_CONN try', new Date(2026, 10, 1, 22, 0, 0, 0))
    expect(await useVeinLogUpload().upload('periodic')).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/^https:\/\/[^/]+\/device-log$/)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer kiosk-jwt')
    expect(sentBodies()[0]).toEqual({ source: 'vein-station', reason: 'periodic', text: '22:00:00.000 EVT THERMO_CONN try' })
  })

  it('upload: 行が無い・token が取れない・送れないときは false (画面は止めない)', async () => {
    expect(await useVeinLogUpload().upload('periodic')).toBe(false)
    recordVeinLine('x')
    getDeviceJwt.mockResolvedValueOnce(null)
    expect(await useVeinLogUpload().upload('periodic')).toBe(false)
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 502 }))
    expect(await useVeinLogUpload().upload('periodic')).toBe(false)
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect(await useVeinLogUpload().upload('periodic')).toBe(false)
  })

  it('★ start: つながっている間は 10 分ごと、体温計の値が無ければ少し待って上げる (続けて起きても間を空ける)', async () => {
    useVeinLogUpload().start()
    recordVeinLine('EVT THERMO_CONN try')
    recordVeinLine('EVT THERMO_RX none')
    recordVeinLine('EVT THERMO_RX none')
    await vi.advanceTimersByTimeAsync(VEIN_LOG_EVENT_DELAY_MS)
    expect(sentBodies().map(b => b.reason)).toEqual(['thermo_rx_none'])
    // 間を空けるまでは出来事で上げない
    recordVeinLine('EVT THERMO_RX err')
    await vi.advanceTimersByTimeAsync(VEIN_LOG_EVENT_DELAY_MS)
    expect(sentBodies()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(VEIN_LOG_PERIODIC_MS - 2 * VEIN_LOG_EVENT_DELAY_MS)
    expect(sentBodies().map(b => b.reason)).toEqual(['thermo_rx_none', 'periodic'])
    await vi.advanceTimersByTimeAsync(VEIN_LOG_MIN_GAP_MS)
    recordVeinLine('EVT THERMO_RX none')
    await vi.advanceTimersByTimeAsync(VEIN_LOG_EVENT_DELAY_MS)
    expect(sentBodies().map(b => b.reason)).toEqual(['thermo_rx_none', 'periodic', 'thermo_rx_none'])
    // 抜けたら定期の分は止まる
    connected.value = false
    await vi.advanceTimersByTimeAsync(VEIN_LOG_PERIODIC_MS)
    expect(sentBodies()).toHaveLength(3)
  })
})
