import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { clearVeinLines, recordVeinLine } from '~/utils/vein-line-log'
import { setKioskDeviceKeyRequired } from '~/utils/token-selection'
import {
  veinLogTriggerReason,
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
const getManagerJwt = vi.fn(async (): Promise<string | null> => 'manager-jwt')
mockNuxtImport('useManagerDeviceToken', () => () => ({ getManagerJwt }))

const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))

function sentBodies(): Array<{ source: string, reason: string, text: string }> {
  return fetchMock.mock.calls.map(c => JSON.parse((c as unknown as [string, RequestInit])[1].body as string))
}

describe('veinLogTriggerReason', () => {
  it('体温計の値が無かった・失敗した行', () => {
    expect(veinLogTriggerReason('EVT THERMO_RX none')).toBe('thermo_rx_none')
    expect(veinLogTriggerReason('EVT THERMO_RX err')).toBe('thermo_rx_none')
    expect(veinLogTriggerReason('EVT THERMO_RX ok')).toBeNull()
    expect(veinLogTriggerReason('dev EVT THERMO_RX none')).toBeNull()
  })

  it('指静脈の不一致・指紋互換の層でだけ当たった行 (静脈で当たった行は上げない)', () => {
    expect(veinLogTriggerReason('VEIN NOMATCH')).toBe('vein_nomatch')
    expect(veinLogTriggerReason('VEIN NOMATCH BEST=10 SCORE=58 THS=60,66,79')).toBe('vein_nomatch')
    expect(veinLogTriggerReason('VEIN IDENTIFIED 10 SCORE=0 TH=58 VIA=FP THS=69,58,80')).toBe('vein_fp')
    expect(veinLogTriggerReason('VEIN VERIFIED 10 SCORE=80 TH=85 VIA=FP THS=61,85,83')).toBe('vein_fp')
    expect(veinLogTriggerReason('VEIN IDENTIFIED 10 SCORE=78 TH=71 VIA=FV THS=63,71,81')).toBeNull()
    expect(veinLogTriggerReason('VEIN IDENTIFIED 10')).toBeNull()
  })
})

describe('useVeinLogUpload', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockClear()
    getDeviceJwt.mockClear()
    getManagerJwt.mockClear()
    setKioskDeviceKeyRequired(true)
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

  it('★ upload: キオスクの鍵でない Vein (運行管理者席) は運行管理者席の鍵で送る', async () => {
    recordVeinLine('VEIN NOMATCH')
    getDeviceJwt.mockResolvedValueOnce(null)
    setKioskDeviceKeyRequired(false)
    expect(await useVeinLogUpload().upload('vein_nomatch')).toBe(true)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer manager-jwt')
  })

  it('upload: キオスクの Vein Station でキオスクの鍵が取れないときは、運行管理者席の鍵を頼まない', async () => {
    recordVeinLine('VEIN NOMATCH')
    getDeviceJwt.mockResolvedValueOnce(null)
    expect(await useVeinLogUpload().upload('vein_nomatch')).toBe(false)
    expect(getManagerJwt).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('★ start: つながっている間は 10 分ごと、体温計の値が無い・指静脈が不一致なら少し待って上げる (続けて起きても間を空ける)', async () => {
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
    // 指静脈の不一致でも上げる (続けて落ちた分は同じ 1 回の本文に載る)
    recordVeinLine('VEIN NOMATCH')
    recordVeinLine('VEIN NOMATCH')
    await vi.advanceTimersByTimeAsync(VEIN_LOG_EVENT_DELAY_MS)
    expect(sentBodies().map(b => b.reason)).toEqual(['thermo_rx_none', 'periodic', 'vein_nomatch'])
    // 抜けたら定期の分は止まる
    connected.value = false
    await vi.advanceTimersByTimeAsync(VEIN_LOG_PERIODIC_MS)
    expect(sentBodies()).toHaveLength(3)
  })
})
