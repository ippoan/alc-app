import { describe, it, expect, vi, afterEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import StrayAlcoholModal from '~/components/StrayAlcoholModal.vue'
import type { StrayAlcoholReading, NormalMeasurementStep, Fc1200State } from '~/types'

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

function mountModal(
  reading: StrayAlcoholReading | null,
  step: NormalMeasurementStep = 'nfc',
  stage: Fc1200State | null = null,
) {
  return mountSuspended(StrayAlcoholModal, { props: { reading, step, stage } })
}

const STAGE_TEXT = '[data-testid="stray-alcohol-modal"] .text-lg.font-medium'


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

  it('段が vehicle のときに届けば出す', async () => {
    const wrapper = await mountModal(null, 'vehicle')
    await wrapper.setProps({ reading: readingOf() })
    expect(wrapper.find(MODAL).exists()).toBe(true)
    wrapper.unmount()
  })

  it('段が medical のときに届けば出す', async () => {
    const wrapper = await mountModal(null, 'medical')
    await wrapper.setProps({ reading: readingOf() })
    expect(wrapper.find(MODAL).exists()).toBe(true)
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

  it('吹込不良 (error) — 値は出さず緑バッジ (測れなかっただけでアルコールが出たわけではない、ユーザー判断)', async () => {
    const wrapper = await mountModal(readingOf({ result: 'error', value: 0 }), 'nfc')
    expect(wrapper.find(VALUE).exists()).toBe(false)
    expect(wrapper.find(RESULT).text()).toBe('測定エラー')
    expect(wrapper.find(RESULT).classes()).toContain('bg-green-100')
    wrapper.unmount()
  })

  it('背景の覆いは濃いめ (bg-black/70) — カードが浮いて見える (ユーザー指摘)', async () => {
    const wrapper = await mountModal(readingOf(), 'nfc')
    expect(wrapper.find(MODAL).classes()).toContain('bg-black/70')
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

  // -------------------------------------------------------------------------
  // 段が進んでも出し続ける (ユーザー要望:「アルコールチェックのボタン押した段階で
  // 表示し始めて」)。**段が動いたら無条件に消す**ままだと、ボタンを押した瞬間
  // (choice → vehicle/medical) に消えて要望が成立しない。
  // -------------------------------------------------------------------------

  it('★ choice で出したあと medical へ進んでも消えない (要望の本体)', async () => {
    const wrapper = await mountModal(readingOf(), 'choice')
    expect(wrapper.find(MODAL).exists()).toBe(true)
    await wrapper.setProps({ step: 'medical' })
    expect(wrapper.find(MODAL).exists()).toBe(true)
    wrapper.unmount()
  })

  it('★ nfc → choice → vehicle と進んでも消えない', async () => {
    const wrapper = await mountModal(readingOf(), 'nfc')
    await wrapper.setProps({ step: 'choice' })
    expect(wrapper.find(MODAL).exists()).toBe(true)
    await wrapper.setProps({ step: 'vehicle' })
    expect(wrapper.find(MODAL).exists()).toBe(true)
    wrapper.unmount()
  })

  it('★ measuring に入ったら消える (点呼の測定画面に「点呼には含まれません」を被せない)', async () => {
    const wrapper = await mountModal(readingOf(), 'medical')
    expect(wrapper.find(MODAL).exists()).toBe(true)
    await wrapper.setProps({ step: 'measuring' })
    expect(wrapper.find(MODAL).exists()).toBe(false)
    wrapper.unmount()
  })

  it('60 秒の寿命は段をまたいでも変わらない (medical へ進んでも 60 秒で消える)', async () => {
    const wrapper = await mountModal(null, 'choice')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await wrapper.setProps({ reading: readingOf() })
    await wrapper.setProps({ step: 'medical' })
    expect(wrapper.find(MODAL).exists()).toBe(true)

    vi.advanceTimersByTime(60_000)
    await wrapper.vm.$nextTick()
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

  // -------------------------------------------------------------------------
  // 進み (stage) でも出す (Refs ippoan/rust-alc-api#644)
  //
  // 「結果が出てから」では遅い。**チェッカーが動き出した時点から**見せる、
  // というユーザーの要望。firmware の EVT FC1200 由来の進みで開く。
  // -------------------------------------------------------------------------

  describe('進み (stage) で開く / 閉じる', () => {
    it.each(['connected', 'warming_up', 'blow_waiting', 'measuring'] as Fc1200State[])(
      '★ %s が届いたら開く',
      async (stage) => {
        const wrapper = await mountModal(null, 'nfc')
        expect(wrapper.find(MODAL).exists()).toBe(false)
        await wrapper.setProps({ stage })
        expect(wrapper.find(MODAL).exists()).toBe(true)
        wrapper.unmount()
      },
    )

    it('★ ウォームアップ中は「ウォームアップ中...」を出す (点呼の測定画面と同じ部品)', async () => {
      const wrapper = await mountModal(null, 'nfc')
      await wrapper.setProps({ stage: 'warming_up' })
      expect(wrapper.find(STAGE_TEXT).text()).toBe('ウォームアップ中...')
      wrapper.unmount()
    })

    it('★ blow_waiting では吹きかけプロンプトも出す', async () => {
      const wrapper = await mountModal(null, 'nfc')
      await wrapper.setProps({ stage: 'blow_waiting' })
      expect(wrapper.text()).toContain('FC-1200 のセンサー部に向かって約5秒間')
      wrapper.unmount()
    })

    it.each(['idle', 'waiting_connection'] as Fc1200State[])(
      '★ %s が届いたら閉じる (用が済んだ / 居なくなった)',
      async (stage) => {
        const wrapper = await mountModal(null, 'nfc')
        await wrapper.setProps({ stage: 'warming_up' })
        expect(wrapper.find(MODAL).exists()).toBe(true)
        await wrapper.setProps({ stage })
        expect(wrapper.find(MODAL).exists()).toBe(false)
        wrapper.unmount()
      },
    )

    it('★★ null (BLOW_TIMEOUT) では閉じない — 吹くのが遅れただけでモーダルを消さない', async () => {
      const wrapper = await mountModal(null, 'nfc')
      await wrapper.setProps({ stage: 'blow_waiting' })
      expect(wrapper.find(MODAL).exists()).toBe(true)

      // firmware は BLOW_TIMEOUT を段階なし (null) で流す。計測待ちへ戻るだけ
      await wrapper.setProps({ stage: null })

      expect(wrapper.find(MODAL).exists()).toBe(true)
      wrapper.unmount()
    })

    it('★★ null (BLOW_TIMEOUT) では 60 秒を引き直さない — 知らせることが増えていないので居座らせない', async () => {
      const wrapper = await mountModal(null, 'nfc')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await wrapper.setProps({ stage: 'blow_waiting' })

      vi.advanceTimersByTime(50_000)
      await wrapper.setProps({ stage: null })
      await wrapper.vm.$nextTick()
      expect(wrapper.find(MODAL).exists()).toBe(true)

      // 引き直していれば、ここではまだ出ているはず
      vi.advanceTimersByTime(10_000)
      await wrapper.vm.$nextTick()
      expect(wrapper.find(MODAL).exists()).toBe(false)
      wrapper.unmount()
    })

    it('★ 進みが変わるたびに 60 秒を引き直す', async () => {
      const wrapper = await mountModal(null, 'nfc')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await wrapper.setProps({ stage: 'warming_up' })

      vi.advanceTimersByTime(50_000)
      await wrapper.setProps({ stage: 'blow_waiting' })
      await wrapper.vm.$nextTick()

      // 引き直していなければ、あと 10 秒で消えるはず
      vi.advanceTimersByTime(20_000)
      await wrapper.vm.$nextTick()
      expect(wrapper.find(MODAL).exists()).toBe(true)

      vi.advanceTimersByTime(40_000)
      await wrapper.vm.$nextTick()
      expect(wrapper.find(MODAL).exists()).toBe(false)
      wrapper.unmount()
    })

    it('★ 進みで開いている間は前回の測定値を出さない (前の人の値を見せない)', async () => {
      // 前の測定が reading に残っている状態で、新しいウォームアップが始まる
      const wrapper = await mountModal(readingOf({ value: 0.42 }), 'nfc')
      expect(wrapper.find(VALUE).text()).toBe('0.420 mg/L')

      await wrapper.setProps({ stage: 'warming_up' })

      expect(wrapper.find(MODAL).exists()).toBe(true)
      expect(wrapper.find(VALUE).exists()).toBe(false)
      expect(wrapper.find(STAGE_TEXT).text()).toBe('ウォームアップ中...')
      wrapper.unmount()
    })

    it('★ 結果が届いたら値の表示へ切り替わる (進みの表示は引っ込む)', async () => {
      const wrapper = await mountModal(null, 'nfc')
      await wrapper.setProps({ stage: 'measuring' })
      expect(wrapper.find(VALUE).exists()).toBe(false)

      // result_received と reading はほぼ同時に届く
      await wrapper.setProps({ stage: 'result_received', reading: readingOf({ value: 0.05 }) })

      expect(wrapper.find(VALUE).text()).toBe('0.050 mg/L')
      expect(wrapper.find(STAGE_TEXT).exists()).toBe(false)
      expect(wrapper.text()).toContain('この記録は点呼には含まれません')
      wrapper.unmount()
    })

    it('result_received だけでは開かない (値は reading 側が出す)', async () => {
      const wrapper = await mountModal(null, 'nfc')
      await wrapper.setProps({ stage: 'result_received' })
      expect(wrapper.find(MODAL).exists()).toBe(false)
      wrapper.unmount()
    })

    it.each(['measuring', 'result'] as NormalMeasurementStep[])(
      '★ 段が %s のときは進みが届いても開かない (点呼の測定と混ざらない)',
      async (step) => {
        const wrapper = await mountModal(null, step)
        await wrapper.setProps({ stage: 'warming_up' })
        expect(wrapper.find(MODAL).exists()).toBe(false)
        wrapper.unmount()
      },
    )

    it('進みで開いた後、段が measuring に入れば閉じる', async () => {
      const wrapper = await mountModal(null, 'medical')
      await wrapper.setProps({ stage: 'warming_up' })
      expect(wrapper.find(MODAL).exists()).toBe(true)
      await wrapper.setProps({ step: 'measuring' })
      expect(wrapper.find(MODAL).exists()).toBe(false)
      wrapper.unmount()
    })

    it('進みで開いたモーダルも手で閉じられる', async () => {
      const wrapper = await mountModal(null, 'nfc')
      await wrapper.setProps({ stage: 'warming_up' })
      await wrapper.find(CLOSE).trigger('click')
      expect(wrapper.find(MODAL).exists()).toBe(false)
      wrapper.unmount()
    })
  })
})
