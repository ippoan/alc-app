import { describe, it, expect, vi, afterEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import IcPunchAlcoholPrompt from '~/components/IcPunchAlcoholPrompt.vue'
import type { LatestPunch } from '~/types'

// IC カードの打刻から アルコールチェックへ進む導線 (Refs ippoan/rust-alc-api#644)。
// **誰のためのボタンか**と**出さない条件** (免許証 / 種別不明 / 未登録カード /
// 60 秒より古い / 測定中 / 押した後) を固定する。

function punchOf(over: Partial<LatestPunch> = {}): LatestPunch {
  return {
    id: 'punch-1',
    employeeId: 'emp-1',
    name: '山田太郎',
    cardKind: 'other',
    punchedAt: new Date().toISOString(),
    ...over,
  }
}

const BUTTON = '[data-testid="ic-punch-alcohol"]'

function mountPrompt(punch: LatestPunch | null, idle = true) {
  return mountSuspended(IcPunchAlcoholPrompt, { props: { punch, idle } })
}

describe('IcPunchAlcoholPrompt — IC カードの打刻からアルコールチェックへ', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('最新の打刻が IC カード (felica_idm / nfca_uid = other) なら社員名入りのボタンを出す', async () => {
    const wrapper = await mountPrompt(punchOf())
    const button = wrapper.find(BUTTON)
    expect(button.exists()).toBe(true)
    expect(button.text()).toBe('山田太郎さんのアルコールチェックへ')
    wrapper.unmount()
  })

  it('最新の打刻が免許証なら出さない — 免許証は従来どおりタッチで選択画面に入る', async () => {
    const wrapper = await mountPrompt(punchOf({ cardKind: 'license' }))
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  it('カード種別が不明 (card_kind が null の行) なら出さない — 誰の操作か確証が無い', async () => {
    const wrapper = await mountPrompt(punchOf({ cardKind: 'unknown' }))
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  it('打刻がまだ 1 件も無ければ出さない', async () => {
    const wrapper = await mountPrompt(null)
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  it('社員が解決できていない打刻 (未登録カード) では出さない — 測定を始めようがない', async () => {
    const wrapper = await mountPrompt(punchOf({ employeeId: null, name: '未登録カード 0123' }))
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  it('60 秒より古い打刻では出さない — 立ち去った人のボタンを次の人が押さないため', async () => {
    const wrapper = await mountPrompt(punchOf({ punchedAt: new Date(Date.now() - 61_000).toISOString() }))
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  it('打刻時刻が読めない行でも出さない (鮮度を判定できない)', async () => {
    const wrapper = await mountPrompt(punchOf({ punchedAt: 'not-a-date' }))
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  it('通常点呼が待機中でない (測定中) なら出さない', async () => {
    const wrapper = await mountPrompt(punchOf(), false)
    expect(wrapper.find(BUTTON).exists()).toBe(false)

    // 待機に戻れば (60 秒以内なら) 出る
    await wrapper.setProps({ idle: true })
    expect(wrapper.find(BUTTON).exists()).toBe(true)
    wrapper.unmount()
  })

  it('出したまま 60 秒が経てば消える', async () => {
    const wrapper = await mountPrompt(null)
    // 打刻を渡した瞬間からの 60 秒を測るので、タイマーを差し替えてから渡す
    vi.useFakeTimers()
    await wrapper.setProps({ punch: punchOf() })
    expect(wrapper.find(BUTTON).exists()).toBe(true)

    vi.advanceTimersByTime(59_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.find(BUTTON).exists()).toBe(true)

    vi.advanceTimersByTime(1_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  it('一覧を引き直して同じ行が来ても 60 秒は伸びない (ポーリングで出っぱなしにしない)', async () => {
    const wrapper = await mountPrompt(null)
    vi.useFakeTimers()
    const punch = punchOf()
    await wrapper.setProps({ punch })

    vi.advanceTimersByTime(59_000)
    // 同じ ID の行を渡し直す (WS の合図やポーリングでの引き直し)
    await wrapper.setProps({ punch: { ...punch } })
    vi.advanceTimersByTime(1_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  it('次の打刻が来たらボタンの対象が入れ替わる', async () => {
    const wrapper = await mountPrompt(punchOf())
    expect(wrapper.find(BUTTON).text()).toBe('山田太郎さんのアルコールチェックへ')

    await wrapper.setProps({ punch: punchOf({ id: 'punch-2', employeeId: 'emp-2', name: '佐藤花子' }) })
    expect(wrapper.find(BUTTON).text()).toBe('佐藤花子さんのアルコールチェックへ')
    wrapper.unmount()
  })

  it('次の打刻が免許証なら、前の人のボタンは消える (別人の名前で測定に入らない)', async () => {
    const wrapper = await mountPrompt(punchOf())
    expect(wrapper.find(BUTTON).exists()).toBe(true)

    await wrapper.setProps({ punch: punchOf({ id: 'punch-2', employeeId: 'emp-2', name: '佐藤花子', cardKind: 'license' }) })
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  it('押すとその打刻を載せて start を emit し、ボタンは消える (同じ行で 2 度始めない)', async () => {
    const punch = punchOf()
    const wrapper = await mountPrompt(punch)

    await wrapper.find(BUTTON).trigger('click')
    expect(wrapper.emitted('start')).toHaveLength(1)
    expect(wrapper.emitted('start')![0]![0]).toMatchObject({ id: 'punch-1', employeeId: 'emp-1', name: '山田太郎' })
    expect(wrapper.find(BUTTON).exists()).toBe(false)

    // 引き直しで同じ行が来ても戻らない
    await wrapper.setProps({ punch: { ...punch } })
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  // `active` emit — 表示中かどうかを呼び出し元 (NfcStatus) へ伝える (Refs #644)
  it('表示になったら active を true で emit する', async () => {
    const wrapper = await mountPrompt(punchOf())
    expect(wrapper.emitted('active')).toBeTruthy()
    expect(wrapper.emitted('active')!.at(-1)).toEqual([true])
    wrapper.unmount()
  })

  it('消えたら active を false で emit する', async () => {
    const wrapper = await mountPrompt(punchOf())
    expect(wrapper.emitted('active')!.at(-1)).toEqual([true])

    // 免許証の打刻に入れ替わる = target が null になる = 消える
    await wrapper.setProps({ punch: punchOf({ id: 'punch-2', cardKind: 'license' }) })
    expect(wrapper.emitted('active')!.at(-1)).toEqual([false])
    wrapper.unmount()
  })

  it('初期値を 1 回流す (打刻が無い = false)', async () => {
    const wrapper = await mountPrompt(null)
    expect(wrapper.emitted('active')).toHaveLength(1)
    expect(wrapper.emitted('active')![0]).toEqual([false])
    wrapper.unmount()
  })
})
