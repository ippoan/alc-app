import { describe, it, expect, vi, afterEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import StrayAlcoholModal from '~/components/StrayAlcoholModal.vue'
import type { StrayAlcoholReading, NormalMeasurementStep } from '~/types'

// 本人確認の前に届いたアルコール測定を知らせるモーダル (Refs ippoan/rust-alc-api#644)。
// 「出す条件 (段が nfc/choice)」「消える条件 (手動/60 秒/段の変化)」「保存・紐付けをしない」
// を固定する。

function readingOf(over: Partial<StrayAlcoholReading> = {}): StrayAlcoholReading {
  return {
    seq: 1,
    value: 0.15,
    unit: 'mg/L',
    result: 'normal',
    useCount: 5,
    measuredAt: new Date('2026-09-17T10:30:00'),
    ...over,
  }
}

const MODAL = '[data-testid="stray-alcohol-modal"]'
const VALUE = '[data-testid="stray-alcohol-modal-value"]'
const RESULT = '[data-testid="stray-alcohol-modal-result"]'
const CLOSE = '[data-testid="stray-alcohol-modal-close"]'

function mountModal(reading: StrayAlcoholReading | null, step: NormalMeasurementStep = 'nfc') {
  return mountSuspended(StrayAlcoholModal, { props: { reading, step } })
}

describe('StrayAlcoholModal — 本人確認前のアルコール測定通知', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reading が無ければ何も出さない', async () => {
    const wrapper = await mountModal(null)
    expect(wrapper.find(MODAL).exists()).toBe(false)
    wrapper.unmount()
  })

  it('段が nfc のときに届けば出す', async () => {
    const wrapper = await mountModal(null, 'nfc')
    await wrapper.setProps({ reading: readingOf() })
    expect(wrapper.find(MODAL).exists()).toBe(true)
    wrapper.unmount()
  })

  it('段が choice のときに届けば出す', async () => {
    const wrapper = await mountModal(null, 'choice')
    await wrapper.setProps({ reading: readingOf() })
    expect(wrapper.find(MODAL).exists()).toBe(true)
    wrapper.unmount()
  })

  it('段が vehicle のときに届いても出さない', async () => {
    const wrapper = await mountModal(null, 'vehicle')
    await wrapper.setProps({ reading: readingOf() })
    expect(wrapper.find(MODAL).exists()).toBe(false)
    wrapper.unmount()
  })

  it('段が medical のときに届いても出さない', async () => {
    const wrapper = await mountModal(null, 'medical')
    await wrapper.setProps({ reading: readingOf() })
    expect(wrapper.find(MODAL).exists()).toBe(false)
    wrapper.unmount()
  })

  it('段が measuring のときに届いても出さない (点呼の測定そのもの、AlcMeasurement が扱う)', async () => {
    const wrapper = await mountModal(null, 'measuring')
    await wrapper.setProps({ reading: readingOf() })
    expect(wrapper.find(MODAL).exists()).toBe(false)
    wrapper.unmount()
  })

  it('段が result のときに届いても出さない', async () => {
    const wrapper = await mountModal(null, 'result')
    await wrapper.setProps({ reading: readingOf() })
    expect(wrapper.find(MODAL).exists()).toBe(false)
    wrapper.unmount()
  })

  it('正常判定 — 値と緑バッジを出す', async () => {
    const wrapper = await mountModal(readingOf({ result: 'normal', value: 0.15 }), 'nfc')
    expect(wrapper.find(VALUE).text()).toBe('0.150 mg/L')
    expect(wrapper.find(RESULT).text()).toBe('正常')
    expect(wrapper.find(RESULT).classes()).toContain('bg-green-100')
    wrapper.unmount()
  })

  it('超過判定 — 値と赤バッジを出す', async () => {
    const wrapper = await mountModal(readingOf({ result: 'over', value: 0.5 }), 'nfc')
    expect(wrapper.find(VALUE).text()).toBe('0.500 mg/L')
    expect(wrapper.find(RESULT).text()).toBe('超過')
    expect(wrapper.find(RESULT).classes()).toContain('bg-red-100')
    wrapper.unmount()
  })

  it('吹込不良 (error) — 値は出さず赤バッジのみ (value は 0.000 固定で測定値ではない)', async () => {
    const wrapper = await mountModal(readingOf({ result: 'error', value: 0 }), 'nfc')
    expect(wrapper.find(VALUE).exists()).toBe(false)
    expect(wrapper.find(RESULT).text()).toBe('測定エラー')
    expect(wrapper.find(RESULT).classes()).toContain('bg-red-100')
    wrapper.unmount()
  })

  it('点呼には含まれない旨の文言を出す', async () => {
    const wrapper = await mountModal(readingOf(), 'nfc')
    expect(wrapper.text()).toContain('この記録は点呼には含まれません')
    expect(wrapper.text()).toContain('本人確認なしの測定です')
    wrapper.unmount()
  })

  it('[閉じる] を押すと消える', async () => {
    const wrapper = await mountModal(readingOf(), 'nfc')
    expect(wrapper.find(MODAL).exists()).toBe(true)
    await wrapper.find(CLOSE).trigger('click')
    expect(wrapper.find(MODAL).exists()).toBe(false)
    wrapper.unmount()
  })

  it('背景をタップすると消える', async () => {
    const wrapper = await mountModal(readingOf(), 'nfc')
    await wrapper.find(MODAL).trigger('click')
    expect(wrapper.find(MODAL).exists()).toBe(false)
    wrapper.unmount()
  })

  it('出したまま 60 秒が経てば消える', async () => {
    const wrapper = await mountModal(null, 'nfc')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await wrapper.setProps({ reading: readingOf() })
    expect(wrapper.find(MODAL).exists()).toBe(true)

    vi.advanceTimersByTime(59_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.find(MODAL).exists()).toBe(true)

    vi.advanceTimersByTime(1_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.find(MODAL).exists()).toBe(false)
    wrapper.unmount()
  })

  it('段が動くと消える (nfc → choice)', async () => {
    const wrapper = await mountModal(readingOf(), 'nfc')
    expect(wrapper.find(MODAL).exists()).toBe(true)
    await wrapper.setProps({ step: 'choice' })
    expect(wrapper.find(MODAL).exists()).toBe(false)
    wrapper.unmount()
  })

  it('新しい測定 (seq が変わる) が届くと前の表示を畳んで出し直す', async () => {
    const wrapper = await mountModal(readingOf({ seq: 1, result: 'normal' }), 'nfc')
    expect(wrapper.find(RESULT).text()).toBe('正常')
    await wrapper.setProps({ reading: readingOf({ seq: 2, result: 'over' }) })
    expect(wrapper.find(MODAL).exists()).toBe(true)
    expect(wrapper.find(RESULT).text()).toBe('超過')
    wrapper.unmount()
  })

  it('閉じたあとタイマーは残らない (vi.getTimerCount が 0)', async () => {
    const wrapper = await mountModal(null, 'nfc')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await wrapper.setProps({ reading: readingOf() })
    expect(vi.getTimerCount()).toBe(1)
    await wrapper.find(CLOSE).trigger('click')
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  it('unmount してもタイマーは残らない', async () => {
    const wrapper = await mountModal(null, 'nfc')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await wrapper.setProps({ reading: readingOf() })
    expect(vi.getTimerCount()).toBe(1)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
