import { describe, it, expect } from 'vitest'
import { readAlcohol } from '~/utils/alcohol'

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
