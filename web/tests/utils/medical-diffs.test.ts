import { describe, expect, it } from 'vitest'
import { medicalDiffRows } from '~/utils/medical-diffs'

describe('medicalDiffRows — 通常の値との差の表示 (業務前 二十三 ヌ)', () => {
  it('体温・最高・最低の順に符号付きで出す (0 は符号なし)', () => {
    expect(medicalDiffRows({ temperature_diff: 0.6, systolic_diff: -5, diastolic_diff: 0 })).toEqual([
      { label: '体温の差', text: '+0.6 ℃' },
      { label: '最高血圧の差', text: '-5 mmHg' },
      { label: '最低血圧の差', text: '0 mmHg' },
    ])
  })

  it('null の項目は出さない。差が無ければ空', () => {
    expect(medicalDiffRows({ temperature_diff: null, systolic_diff: 12, diastolic_diff: null })).toEqual([
      { label: '最高血圧の差', text: '+12 mmHg' },
    ])
    expect(medicalDiffRows(null)).toEqual([])
    expect(medicalDiffRows(undefined)).toEqual([])
  })
})
