import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { appendDiag, readDiag } from '~/utils/serialDiagLog'

const KEY = 'alc_serial_diag'

describe('serialDiagLog', () => {
  beforeEach(() => {
    localStorage.removeItem(KEY)
    vi.useFakeTimers({ toFake: ['Date'] })
    // ローカル時刻 09:05:07.042
    vi.setSystemTime(new Date(2026, 8, 10, 9, 5, 7, 42))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    localStorage.removeItem(KEY)
  })

  it('1 行 = `HH:MM:SS.mmm <msg>` (ローカル時刻) で、古い順に読める', () => {
    appendDiag('scan start: candidates=1')
    vi.setSystemTime(new Date(2026, 8, 10, 23, 59, 58, 7))
    appendDiag('connect event')

    expect(readDiag()).toEqual([
      '09:05:07.042 scan start: candidates=1',
      '23:59:58.007 connect event',
    ])
  })

  it('直前と同じ本文が続いたら 1 件にまとめ、回数と最後の時刻を付ける', () => {
    appendDiag('scan start: candidates=0')
    vi.setSystemTime(new Date(2026, 8, 10, 9, 5, 17, 100))
    appendDiag('scan start: candidates=0')
    vi.setSystemTime(new Date(2026, 8, 10, 9, 38, 27, 900))
    appendDiag('scan start: candidates=0')

    expect(readDiag()).toEqual(['09:05:07.042 scan start: candidates=0 (×3 最後 09:38:27)'])
  })

  it('間に別の行が入ったらまとめない', () => {
    appendDiag('scan start: candidates=0')
    appendDiag('dev EVT BOOT reset=poweron')
    appendDiag('scan start: candidates=0')

    expect(readDiag()).toEqual([
      '09:05:07.042 scan start: candidates=0',
      '09:05:07.042 dev EVT BOOT reset=poweron',
      '09:05:07.042 scan start: candidates=0',
    ])
  })

  it('まとめた件も 160 文字に収め、回数の表示は削らない', () => {
    appendDiag('x'.repeat(300))
    appendDiag('x'.repeat(300))

    const [line] = readDiag()
    expect(line).toHaveLength(160)
    expect(line!.endsWith('xxx (×2 最後 09:05:07)')).toBe(true)
  })

  it('本文は 160 文字に切った後で比べる (切った先だけ違う行はまとめる)', () => {
    appendDiag(`${'x'.repeat(200)}a`)
    appendDiag(`${'x'.repeat(200)}b`)

    expect(readDiag()).toHaveLength(1)
    expect(readDiag()[0]!.endsWith('(×2 最後 09:05:07)')).toBe(true)
  })

  it('古い形 (整形済みの文字列の要素) も読め、その後ろに追記できる', () => {
    localStorage.setItem(KEY, JSON.stringify(['08:00:00.000 scan start: candidates=0']))

    expect(readDiag()).toEqual(['08:00:00.000 scan start: candidates=0'])

    // 古い形の件にはまとめない (n = 1 として扱う)
    appendDiag('scan start: candidates=0')
    appendDiag('scan start: candidates=0')
    expect(readDiag()).toEqual([
      '08:00:00.000 scan start: candidates=0',
      '09:05:07.042 scan start: candidates=0 (×2 最後 09:05:07)',
    ])
  })

  it('文字列でも置き場の形でもない要素は捨てる', () => {
    localStorage.setItem(KEY, JSON.stringify([null, 1, { t: 'x' }, '08:00:00.000 ok']))

    expect(readDiag()).toEqual(['08:00:00.000 ok'])
  })

  it('\\r \\n は空白に置き換える', () => {
    appendDiag('a\r\nb\nc')
    expect(readDiag()).toEqual(['09:05:07.042 a  b c'])
  })

  it('160 文字 (時刻込み) で切る', () => {
    appendDiag('x'.repeat(300))
    const [line] = readDiag()
    expect(line).toHaveLength(160)
    expect(line!.startsWith('09:05:07.042 xxx')).toBe(true)
  })

  it('200 行を超えたら古い行から捨てる', () => {
    for (let i = 0; i < 205; i++) appendDiag(`m${i}`)
    const lines = readDiag()
    expect(lines).toHaveLength(200)
    expect(lines[0]).toBe('09:05:07.042 m5')
    expect(lines.at(-1)).toBe('09:05:07.042 m204')
  })

  it('何も無ければ空配列', () => {
    expect(readDiag()).toEqual([])
  })

  it.each([
    ['壊れた JSON', '{not json'],
    ['配列でない JSON', '{"a":1}'],
  ])('%s は空配列として読み、追記で置き直す', (_label, raw) => {
    localStorage.setItem(KEY, raw)
    expect(readDiag()).toEqual([])

    appendDiag('after')
    expect(readDiag()).toEqual(['09:05:07.042 after'])
  })

  // happy-dom の localStorage は Storage.prototype を経由しないので、spyOn ではなく差し替える

  it('localStorage が例外を投げても落ちない (読めない端末の設定)', () => {
    const getItem = vi.fn(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem, setItem })

    expect(readDiag()).toEqual([])
    expect(() => appendDiag('x')).not.toThrow()
    expect(getItem).toHaveBeenCalled()
  })

  it('容量超過 (setItem が投げる) でも落ちない', () => {
    const stored = JSON.stringify(['09:05:07.042 before'])
    const setItem = vi.fn(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => stored), setItem })

    expect(() => appendDiag('x')).not.toThrow()
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(readDiag()).toEqual(['09:05:07.042 before'])
  })

  it('localStorage が無い (SSR) でも落ちない', () => {
    vi.stubGlobal('localStorage', undefined)

    expect(readDiag()).toEqual([])
    expect(() => appendDiag('x')).not.toThrow()
  })
})
