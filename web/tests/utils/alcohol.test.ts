import { describe, it, expect } from 'vitest'
import { readAlcohol, toAlcoholReading, alcoholResultLabel, alcoholResultClass, alcoholTone } from '~/utils/alcohol'

describe('readAlcohol', () => {
  it('CoreS3 の payload (正常) を読む', () => {
    expect(readAlcohol({ type: 'alcohol', value: 0.15, unit: 'mg/L', result: 'normal', use_count: 42 }))
      .toEqual({ value: 0.15, result: 'normal', useCount: 42 })
  })

  it('超過 (over) も読む', () => {
    expect(readAlcohol({ value: 0.5, result: 'over', use_count: 1 }))
      .toEqual({ value: 0.5, result: 'over', useCount: 1 })
  })

  it('吹込不良 (error) — value は 0.000 固定でもそのまま返す (呼び出し側が result で判定する)', () => {
    expect(readAlcohol({ value: 0, result: 'error', use_count: 3 }))
      .toEqual({ value: 0, result: 'error', useCount: 3 })
  })

  it('use_count が無い → useCount は null', () => {
    expect(readAlcohol({ value: 0.1, result: 'normal' }))
      .toEqual({ value: 0.1, result: 'normal', useCount: null })
  })

  it('value も result も無い → null', () => {
    expect(readAlcohol({ use_count: 1 })).toBeNull()
  })

  it('payload が object でない → null', () => {
    expect(readAlcohol('not an object')).toBeNull()
    expect(readAlcohol(123)).toBeNull()
    expect(readAlcohol(null)).toBeNull()
    expect(readAlcohol(undefined)).toBeNull()
  })

  it('value / result の型が違う → null 扱い (壊れた行を測定値として拾わない)', () => {
    expect(readAlcohol({ value: 'not a number', result: 123 })).toBeNull()
  })
})

describe('toAlcoholReading', () => {
  it('readAlcohol の戻りから AlcoholReading を組む', () => {
    const reading = toAlcoholReading({ value: 0.15, result: 'normal', useCount: 42 })
    expect(reading).not.toBeNull()
    expect(reading!.value).toBe(0.15)
    expect(reading!.unit).toBe('mg/L')
    expect(reading!.result).toBe('normal')
    expect(reading!.useCount).toBe(42)
    expect(reading!.measuredAt).toBeInstanceOf(Date)
  })

  it('吹込不良 (error) — value 欠落は 0 に倒す', () => {
    const reading = toAlcoholReading({ value: null, result: 'error', useCount: 3 })
    expect(reading).toEqual(expect.objectContaining({ value: 0, result: 'error', useCount: 3 }))
  })

  it('use_count 欠落 (useCount: null) は 0 に倒す', () => {
    const reading = toAlcoholReading({ value: 0.1, result: 'normal', useCount: null })
    expect(reading!.useCount).toBe(0)
  })

  it('result が無い (null) → null', () => {
    expect(toAlcoholReading(null)).toBeNull()
    expect(toAlcoholReading({ value: 0.1, result: null, useCount: 1 })).toBeNull()
  })
})

describe('alcoholTone', () => {
  it('normal は値 0 で緑、0 より上で赤 (検知)', () => {
    expect(alcoholTone('normal', 0)).toBe('green')
    expect(alcoholTone('normal', 0.01)).toBe('red')
  })

  it('over は赤、error は黄、未知の値は赤', () => {
    expect(alcoholTone('over', 0.5)).toBe('red')
    expect(alcoholTone('error', 0)).toBe('yellow')
    expect(alcoholTone('pass', 0)).toBe('red')
  })
})

describe('alcoholResultLabel', () => {
  it('normal は値 0 なら「正常」、0 より上なら「検知」', () => {
    expect(alcoholResultLabel('normal', 0)).toBe('正常')
    expect(alcoholResultLabel('normal', 0.12)).toBe('検知')
  })

  it('over / error は値によらず固定', () => {
    expect(alcoholResultLabel('over', 0.5)).toBe('超過')
    expect(alcoholResultLabel('error', 0)).toBe('測定エラー')
  })

  it('未知の値はそのまま返す', () => {
    expect(alcoholResultLabel('pass', 0)).toBe('pass')
  })
})

describe('alcoholResultClass', () => {
  it('normal は値 0 で緑、0 より上で赤', () => {
    expect(alcoholResultClass('normal', 0)).toBe('bg-green-100 text-green-800')
    expect(alcoholResultClass('normal', 0.01)).toBe('bg-red-100 text-red-800')
  })

  it('error は黄、over は赤', () => {
    expect(alcoholResultClass('error', 0)).toBe('bg-yellow-100 text-yellow-800')
    expect(alcoholResultClass('over', 0.5)).toBe('bg-red-100 text-red-800')
  })

  it('未知の値は赤', () => {
    expect(alcoholResultClass('pass', 0)).toBe('bg-red-100 text-red-800')
  })
})
