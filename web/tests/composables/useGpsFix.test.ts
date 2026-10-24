import { describe, it, expect, beforeEach } from 'vitest'
import { onGpsLine, currentLocation, resetGpsFix } from '~/composables/useGpsFix'

const FIX = 'EVT GPS FIX lat=35.681237 lon=139.767125 sats=8 hdop=0.9 alt=40.1 utc=2026-10-24T06:30:00Z'
const NOFIX = 'EVT GPS NOFIX sats=3 utc=2026-10-24T06:30:00Z'

/** Unit GPS の最新の位置 (Refs ippoan/alc-app#514) */
describe('useGpsFix', () => {
  beforeEach(() => resetGpsFix())

  it('一度も受けていなければ undefined', () => {
    expect(currentLocation()).toBeUndefined()
  })

  it('FIX 行は EVT GPS を外した形で保持する', () => {
    expect(onGpsLine(FIX)).toBe(true)
    expect(currentLocation()).toBe('FIX lat=35.681237 lon=139.767125 sats=8 hdop=0.9 alt=40.1 utc=2026-10-24T06:30:00Z')
  })

  it('NOFIX 行も保持する (不明な欄は - のまま)', () => {
    expect(onGpsLine('EVT GPS NOFIX sats=- utc=-')).toBe(true)
    expect(currentLocation()).toBe('NOFIX sats=- utc=-')
    expect(onGpsLine(NOFIX)).toBe(true)
    expect(currentLocation()).toBe('NOFIX sats=3 utc=2026-10-24T06:30:00Z')
  })

  it('受信から 120 秒までは保持した値、超えたら NOFIX stale', () => {
    onGpsLine(FIX)
    const now = Date.now()
    expect(currentLocation(now + 120_000)).toMatch(/^FIX /)
    expect(currentLocation(now + 120_001 + 1000)).toBe('NOFIX stale')
  })

  it('無関係な行は false で、保持を変えない', () => {
    onGpsLine(FIX)
    expect(onGpsLine('EVT NFC_READY')).toBe(false)
    expect(onGpsLine('EVT GPS')).toBe(false)
    expect(onGpsLine('')).toBe(false)
    expect(currentLocation()).toMatch(/^FIX /)
  })
})
