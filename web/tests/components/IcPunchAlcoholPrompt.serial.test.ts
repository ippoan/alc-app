import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import IcPunchAlcoholPrompt from '~/components/IcPunchAlcoholPrompt.vue'
import type { LatestPunch } from '~/types'

// シリアル由来 (`#298`) とサーバ由来の**両方**でボタンの寿命が同じであることを、
// `index.vue` と同じ配線 (`useHubTimecardPunch` → `IcPunchAlcoholPrompt`) で確かめる
// (Refs ippoan/rust-alc-api#644)。
//
// **片方だけ消える形にしない**のが目的。component 単体のテストでは
// `punch` を props で渡すので、シリアル由来の経路がその仕掛けを通っているかが見えない。

const { onEventMock, emitEvent } = vi.hoisted(() => {
  const handlers: Array<(name: string, args: string[]) => void> = []
  return {
    onEventMock: vi.fn((cb: (name: string, args: string[]) => void) => {
      handlers.push(cb)
      return vi.fn()
    }),
    emitEvent: (name: string, args: string[]) => handlers.forEach(h2 => h2(name, args)),
  }
})
mockNuxtImport('useCoreS3Serial', () => () => ({ onEvent: onEventMock }))
mockNuxtImport('useTimecardCardIndex', () => () => ({
  resolve: () => 'emp-1',
  restore: async () => {},
  refresh: async () => {},
  startPeriodicRefresh: () => {},
  stopPeriodicRefresh: () => {},
}))

const BUTTON = '[data-testid="ic-punch-alcohol"]'

/** `index.vue` と同じ配線 */
const Harness = defineComponent({
  setup() {
    const { latest, setFromServer } = useHubTimecardPunch(() => '山田太郎')
    const idle = ref(true)
    return { latest, setFromServer, idle }
  },
  render() {
    return h(IcPunchAlcoholPrompt, { punch: this.latest, idle: this.idle })
  },
})

type HarnessVm = { setFromServer: (p: LatestPunch | null) => void }

function serverRow(over: Partial<LatestPunch> = {}): LatestPunch {
  return {
    id: 'row-1',
    employeeId: 'emp-1',
    name: '山田太郎',
    cardKind: 'other',
    punchedAt: new Date().toISOString(),
    ...over,
  }
}

describe('IcPunchAlcoholPrompt — シリアル由来でも寿命は同じ', () => {
  beforeEach(() => { onEventMock.mockClear() })
  afterEach(() => { vi.useRealTimers() })

  it('★ シリアル由来で出したボタンも 10 秒で消える', async () => {
    const wrapper = await mountSuspended(Harness)
    vi.useFakeTimers()

    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])
    await wrapper.vm.$nextTick()
    expect(wrapper.find(BUTTON).exists()).toBe(true)

    vi.advanceTimersByTime(9_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.find(BUTTON).exists()).toBe(true)

    vi.advanceTimersByTime(1_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  it('★★ 同じタップのサーバ由来が後から届いても寿命が延びない', async () => {
    const wrapper = await mountSuspended(Harness)
    vi.useFakeTimers()

    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])
    await wrapper.vm.$nextTick()

    // 5 秒後に一覧の引き直しでサーバ由来の行が届く (= 同じタップ)
    vi.advanceTimersByTime(5_000)
    ;(wrapper.vm as unknown as HarnessVm).setFromServer(serverRow())
    await wrapper.vm.$nextTick()
    expect(wrapper.find(BUTTON).exists()).toBe(true)

    // タップから 10 秒でちゃんと消える (5 秒地点から数え直さない)
    vi.advanceTimersByTime(5_500)
    await wrapper.vm.$nextTick()
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  it('★ 消えた後にポーリングで同じ行が届いても復活しない', async () => {
    const wrapper = await mountSuspended(Harness)
    vi.useFakeTimers()

    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])
    await wrapper.vm.$nextTick()
    const punchedAt = new Date().toISOString()

    vi.advanceTimersByTime(11_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.find(BUTTON).exists()).toBe(false)

    // 30 秒ポーリングで届く。**同じタップの時刻**なので、通っても寿命は尽きている
    vi.advanceTimersByTime(20_000)
    ;(wrapper.vm as unknown as HarnessVm).setFromServer(serverRow({ id: 'row-9', punchedAt }))
    await wrapper.vm.$nextTick()

    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  it('サーバ由来だけで出たボタンも 10 秒で消える (シリアルが無い台)', async () => {
    const wrapper = await mountSuspended(Harness)
    vi.useFakeTimers()

    ;(wrapper.vm as unknown as HarnessVm).setFromServer(serverRow())
    await wrapper.vm.$nextTick()
    expect(wrapper.find(BUTTON).exists()).toBe(true)

    vi.advanceTimersByTime(10_500)
    await wrapper.vm.$nextTick()
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })
})
