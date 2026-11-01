import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  clearVeinLines,
  onVeinLine,
  persistVeinLines,
  recordVeinLine,
  redactVeinLine,
  restoreVeinLines,
  snapshotVeinLines,
  VEIN_LINE_LOG_MAX_LINES,
  VEIN_LINE_LOG_MAX_TEXT,
} from '~/utils/vein-line-log'

// Vein Station の行を時刻付きで溜める (Refs ippoan/alc-app-s3#352)
describe('vein-line-log', () => {
  beforeEach(() => {
    clearVeinLines()
    sessionStorage.clear()
  })

  it('受けた時刻 (HH:MM:SS.mmm) を付けて溜め、改行でつないで返す', () => {
    recordVeinLine('EVT THERMO_CONN try', new Date(2026, 10, 1, 22, 16, 53, 7))
    recordVeinLine('I (248362) NimBLE: GATT procedure initiated: write', new Date(2026, 10, 1, 22, 16, 53, 120))
    expect(snapshotVeinLines()).toBe(
      '22:16:53.007 EVT THERMO_CONN try\n22:16:53.120 I (248362) NimBLE: GATT procedure initiated: write',
    )
  })

  it('★ 閉じる直前に退避した行を、開き直したら今の行の前へ戻す (戻したら退避先は消す)', () => {
    recordVeinLine('VEIN IDENTIFIED 10', new Date(2026, 10, 2, 2, 10, 0, 0))
    persistVeinLines()
    clearVeinLines()
    recordVeinLine('STATUS VER=x', new Date(2026, 10, 2, 2, 13, 0, 0))
    expect(restoreVeinLines()).toBe(1)
    expect(snapshotVeinLines()).toBe('02:10:00.000 VEIN IDENTIFIED 10\n02:13:00.000 STATUS VER=x')
    expect(sessionStorage.getItem('alc-vein-lines-pending')).toBeNull()
    expect(restoreVeinLines()).toBe(0)
  })

  it('溜めた行が無ければ退避しない。戻しても行数の上限を守る', () => {
    persistVeinLines()
    expect(sessionStorage.getItem('alc-vein-lines-pending')).toBeNull()
    for (let i = 0; i < VEIN_LINE_LOG_MAX_LINES; i++) recordVeinLine(`L${i}`, new Date(0))
    persistVeinLines()
    recordVeinLine('new', new Date(0))
    restoreVeinLines()
    const out = snapshotVeinLines().split('\n')
    expect(out).toHaveLength(VEIN_LINE_LOG_MAX_LINES)
    expect(out.at(-1)).toMatch(/ new$/)
  })

  it('sessionStorage が使えなくても投げない', () => {
    recordVeinLine('x', new Date(0))
    const set = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => persistVeinLines()).not.toThrow()
    set.mockRestore()
    const get = vi.spyOn(sessionStorage, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(restoreVeinLines()).toBe(0)
    get.mockRestore()
  })

  it('★ 生体の中身 (登録の記録・特徴量の 16 進の塊) は溜める写しで伏せ、購読者には元の行を渡す', () => {
    const hex = 'DEEDDEED'.repeat(64)
    const got: string[] = []
    const off = onVeinLine(l => got.push(l))
    recordVeinLine(`VEIN RECORD 10 0 ${hex}`, new Date(2026, 10, 2, 2, 18, 9, 645))
    recordVeinLine('VEIN RECORD 10 END 8156', new Date(2026, 10, 2, 2, 18, 9, 800))
    off()
    expect(snapshotVeinLines()).toBe('02:18:09.645 VEIN RECORD 10 0 <hex 256 B>\n02:18:09.800 VEIN RECORD 10 END 8156')
    expect(got[0]).toBe(`VEIN RECORD 10 0 ${hex}`)
  })

  it('redactVeinLine: 32 文字以上の 16 進だけを伏せ、照合の行・短い 16 進は残す', () => {
    expect(redactVeinLine(`VEIN CHARA ${'ab'.repeat(16)}`)).toBe('VEIN CHARA <hex 16 B>')
    expect(redactVeinLine(`VEIN CHARA ${'ab'.repeat(15)}`)).toBe(`VEIN CHARA ${'ab'.repeat(15)}`)
    expect(redactVeinLine('VEIN IDENTIFIED 10 SCORE=78 TH=71 VIA=FV THS=63,71,81')).toBe('VEIN IDENTIFIED 10 SCORE=78 TH=71 VIA=FV THS=63,71,81')
    expect(redactVeinLine('VEIN TEST VERIFY 2 RC=00 DATA=0012')).toBe('VEIN TEST VERIFY 2 RC=00 DATA=0012')
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
