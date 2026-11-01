import { describe, it, expect, beforeEach } from 'vitest'
import {
  clearVeinLines,
  onVeinLine,
  recordVeinLine,
  snapshotVeinLines,
  VEIN_LINE_LOG_MAX_LINES,
  VEIN_LINE_LOG_MAX_TEXT,
} from '~/utils/vein-line-log'

// Vein Station の行を時刻付きで溜める (Refs ippoan/alc-app-s3#352)
describe('vein-line-log', () => {
  beforeEach(() => clearVeinLines())

  it('受けた時刻 (HH:MM:SS.mmm) を付けて溜め、改行でつないで返す', () => {
    recordVeinLine('EVT THERMO_CONN try', new Date(2026, 10, 1, 22, 16, 53, 7))
    recordVeinLine('I (248362) NimBLE: GATT procedure initiated: write', new Date(2026, 10, 1, 22, 16, 53, 120))
    expect(snapshotVeinLines()).toBe(
      '22:16:53.007 EVT THERMO_CONN try\n22:16:53.120 I (248362) NimBLE: GATT procedure initiated: write',
    )
  })

  it('行数の上限を超えたら古い方から捨てる', () => {
    for (let i = 0; i < VEIN_LINE_LOG_MAX_LINES + 5; i++) recordVeinLine(`L${i}`, new Date(0))
    const out = snapshotVeinLines().split('\n')
    expect(out).toHaveLength(VEIN_LINE_LOG_MAX_LINES)
    expect(out[0]).toMatch(/ L5$/)
  })

  it('本文の上限を超えたら古い方を行の切れ目で落とす', () => {
    const long = 'x'.repeat(1000)
    for (let i = 0; i < 400; i++) recordVeinLine(`${i} ${long}`, new Date(0))
    const text = snapshotVeinLines()
    expect(text.length).toBeLessThanOrEqual(VEIN_LINE_LOG_MAX_TEXT)
    expect(text.split('\n')[0]).toMatch(/^\d\d:\d\d:\d\d\.\d{3} \d+ x+$/)
    expect(text.endsWith(`399 ${long}`)).toBe(true)
  })

  it('購読者に行をそのまま渡し、外したら渡さない', () => {
    const got: string[] = []
    const off = onVeinLine(l => got.push(l))
    recordVeinLine('EVT THERMO_RX none')
    off()
    recordVeinLine('EVT THERMO_RX ok')
    expect(got).toEqual(['EVT THERMO_RX none'])
  })
})
