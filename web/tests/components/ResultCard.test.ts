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

describe('ResultCard — IT点呼 / 終了 (Refs ippoan/alc-app#436)', () => {
  it('itOffer を渡さなければ「次の測定へ」だけで、押すと reset を出す (今までと同一)', async () => {
    const wrapper = await mountCard({})
    expect(wrapper.find('[data-testid="result-it"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="result-finish"]').exists()).toBe(false)
    const next = wrapper.find('[data-testid="result-reset"]')
    expect(next.text()).toBe('次の測定へ')
    await next.trigger('click')
    expect(wrapper.emitted('reset')).toHaveLength(1)
  })

  it('itOffer を渡すと「次の測定へ」の代わりに 2 つのボタンと残り秒数を出し、押すと it / finish を出す', async () => {
    const wrapper = await mountSuspended(ResultCard, {
      props: { result: resultOf(), itOffer: { secondsLeft: 12, busy: false } },
    })
    expect(wrapper.find('[data-testid="result-reset"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="result-countdown"]').text()).toBe('あと 12 秒で終了します')
    await wrapper.find('[data-testid="result-it"]').trigger('click')
    await wrapper.find('[data-testid="result-finish"]').trigger('click')
    expect(wrapper.emitted('it')).toHaveLength(1)
    expect(wrapper.emitted('finish')).toHaveLength(1)
    expect(wrapper.emitted('reset')).toBeUndefined()
  })

  it('busy のあいだは 2 つのボタンを押せない', async () => {
    const wrapper = await mountSuspended(ResultCard, {
      props: { result: resultOf(), itOffer: { secondsLeft: 30, busy: true } },
    })
    expect(wrapper.find('[data-testid="result-it"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="result-finish"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-testid="result-it"]').trigger('click')
    expect(wrapper.emitted('it')).toBeUndefined()
  })
})
