import { describe, expect, it } from 'vitest'
import { formatVeinStat, parseVeinCapLog, summarizeVeinProfile, type VeinProfileShot } from '~/utils/vein-device-profile'

// 2026-11-06 の開発端末の実際の行と同じ形 (記録用の撮影 → XG_Create → 照合用の撮影 → XG_Create)
const CAPLOG = 'VEIN CAPLOG 0-Gray:155 | 2-IrBright:23, 40 | [0]-Ir:23,40 Gray:60 | XG_Create:0,973 | 0-Gray:67 | 2-IrBright:60, 40 | [0]-Ir:60,40 Gray:97 | XG_Create:0,733,126'

describe('parseVeinCapLog', () => {
  it('記録用・照合用それぞれの最後の明るさと撮影の回数を読む', () => {
    expect(parseVeinCapLog(CAPLOG)).toEqual({ recordGray: 60, matchGray: 97, recordTries: 2, matchTries: 2, lineW: false })
  })

  it('行の途中に連結されて届いても読み、線の途切れ (lineW) を拾う', () => {
    const got = parseVeinCapLog(`14:15:08.180 ${CAPLOG} | &&&lineW:12`)
    expect(got?.matchGray).toBe(97)
    expect(got?.lineW).toBe(true)
  })

  it('照合用が無い・CAPLOG でない行', () => {
    expect(parseVeinCapLog('VEIN CAPLOG 0-Gray:30 | XG_Create:0,1')).toEqual({ recordGray: 30, matchGray: null, recordTries: 1, matchTries: 0, lineW: false })
    expect(parseVeinCapLog('VEIN IDENTIFIED 10')).toBeNull()
  })
})

function shot(over: Partial<VeinProfileShot>): VeinProfileShot {
  return { n: 1, module: 'none', server: null, scores: null, rule: null, dx: null, dy: null, overlap: null, cap: null, error: null, ...over }
}

describe('summarizeVeinProfile', () => {
  it('判定の数を数え、ずれ・点数・明るさの平均と散らばりを出す (値の無い回は数えない)', () => {
    const p = summarizeVeinProfile([
      shot({ n: 1, module: 'self', server: 'match', scores: [60, 60, 80], dx: -4, dy: 0, overlap: 700, cap: { recordGray: 60, matchGray: 90, recordTries: 2, matchTries: 2, lineW: false } }),
      shot({ n: 2, module: 'none', server: 'match', scores: [50, 56, 70], dx: -2, dy: 2, overlap: 600, cap: { recordGray: 80, matchGray: null, recordTries: 2, matchTries: 0, lineW: false } }),
      shot({ n: 3, module: 'other', error: 'x' }),
    ])
    expect(p.shots).toBe(3)
    expect(p.moduleSelf).toBe(1)
    expect(p.serverMatch).toBe(2)
    expect(p.dx).toEqual({ n: 2, mean: -3, sd: 1 })
    expect(p.dy).toEqual({ n: 2, mean: 1, sd: 1 })
    expect(p.overlap?.mean).toBe(650)
    expect(p.s0?.mean).toBe(55)
    expect(p.s2?.mean).toBe(75)
    expect(p.recordGray).toEqual({ n: 2, mean: 70, sd: 10 })
    expect(p.matchGray).toEqual({ n: 1, mean: 90, sd: 0 })
  })

  it('1 回も無ければ値は null', () => {
    const p = summarizeVeinProfile([])
    expect(p.shots).toBe(0)
    expect(p.dx).toBeNull()
    expect(p.s1).toBeNull()
  })
})

describe('formatVeinStat', () => {
  it('平均 ± 散らばり (件数)。無ければ —', () => {
    expect(formatVeinStat({ n: 3, mean: -3.25, sd: 1 })).toBe('-3.3 ± 1.0 (3)')
    expect(formatVeinStat({ n: 2, mean: 650, sd: 50 }, 0)).toBe('650 ± 50 (2)')
    expect(formatVeinStat(null)).toBe('—')
  })
})
