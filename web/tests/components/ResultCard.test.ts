import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ResultCard from '~/components/ResultCard.vue'
import type { MeasurementResult } from '~/types'

function resultOf(over: Partial<MeasurementResult> = {}): MeasurementResult {
  return {
    employeeId: 'emp-1',
    alcoholValue: 0,
    resultType: 'normal',
    deviceUseCount: 1,
    measuredAt: new Date('2026-10-20T10:00:00'),
    ...over,
  }
}

async function mountCard(over: Partial<MeasurementResult>) {
  return await mountSuspended(ResultCard, { props: { result: resultOf(over) } })
}

describe('ResultCard — 判定の色 (Refs ippoan/alc-app#436)', () => {
  it('normal で値 0 — 「正常」で緑の枠', async () => {
    const wrapper = await mountCard({ resultType: 'normal', alcoholValue: 0 })
    expect(wrapper.text()).toContain('正常')
    expect(wrapper.html()).toContain('border-green-300')
    expect(wrapper.html()).not.toContain('border-red-300')
  })

  it('normal でも値が 0 より上 — 「検知」で赤の枠とバッジ', async () => {
    const wrapper = await mountCard({ resultType: 'normal', alcoholValue: 0.12 })
    expect(wrapper.text()).toContain('検知')
    expect(wrapper.html()).toContain('border-red-300')
    expect(wrapper.html()).toContain('bg-red-100')
  })

  it('over — 「超過」で赤の枠', async () => {
    const wrapper = await mountCard({ resultType: 'over', alcoholValue: 0.5 })
    expect(wrapper.text()).toContain('超過')
    expect(wrapper.html()).toContain('border-red-300')
  })

  it('error — 黄の枠', async () => {
    const wrapper = await mountCard({ resultType: 'error', alcoholValue: 0 })
    expect(wrapper.html()).toContain('border-yellow-300')
  })
})
