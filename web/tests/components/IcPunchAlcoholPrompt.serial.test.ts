import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import IcPunchAlcoholPrompt from '~/components/IcPunchAlcoholPrompt.vue'
import type { LatestPunch } from '~/types'
import type { UsbHubKind } from '~/composables/useUsbHub'

// `index.vue` と同じ配線 (`useHubTimecardPunch` → `IcPunchAlcoholPrompt`) で、
// **この端末の機体で読んだカードはボタンに出ず (すぐ測定へ進む)、ボタンは別の端末の打刻だけ**
// であることを確かめる (Refs ippoan/rust-alc-api#644, ippoan/alc-app#436)。
//
// component 単体のテストでは `punch` を props で渡すので、機体で読んだ同じタップの
// サーバ由来の行がボタンに出ないこと (`fromSerial` の印) が配線を通って見えない。

const { onEventMock, emitEvent } = vi.hoisted(() => {
  const handlers: Array<(name: string, args: string[], source: UsbHubKind) => void> = []
  return {
    onEventMock: vi.fn((cb: (name: string, args: string[], source: UsbHubKind) => void) => {
      handlers.push(cb)
      return vi.fn()
    }),
    emitEvent: (name: string, args: string[]) => handlers.forEach(h2 => h2(name, args, 'cores3')),
  }
})
mockNuxtImport('useUsbHub', () => () => ({ nfc: { onEvent: onEventMock } }))
mockNuxtImport('useVeinSerial', () => () => ({ deviceInfo: { value: null } }))
mockNuxtImport('useTimecardCardIndex', () => () => ({
  resolve: () => 'emp-1',
  isFresh: () => true,
  restore: async () => {},
  refresh: async () => {},
  startPeriodicRefresh: () => {},
  stopPeriodicRefresh: () => {},
}))

// オンラインの側: サーバーへの持ち主の照会 (`lookupEmployeeByCard`) と端末の鍵
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }))
vi.mock('~/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/utils/api')>()
  return { ...actual, lookupEmployeeByCard: lookupMock }
})
mockNuxtImport('useDeviceToken', () => () => ({ getDeviceJwt: async () => 'device-jwt' }))

const BUTTON = '[data-testid="ic-punch-alcohol"]'

const startIcMock = vi.fn(async () => true)

/** `index.vue` と同じ配線 */
const Harness = defineComponent({
  setup() {
    const { latest, setFromServer } = useHubTimecardPunch(() => '山田太郎', startIcMock)
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

describe('IcPunchAlcoholPrompt — 機体で読んだカードはボタンに出さない', () => {
  beforeEach(() => {
    onEventMock.mockClear()
    startIcMock.mockClear()
    // 手元の写しで引く側 (同期で測定を始める) の配線を見る。オンラインだとサーバーへの照会が
    // 先に入る (`useHubTimecardPunch` の doc。そちらは composable のテストが固定する)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('★ 機体で読んだカードはボタンを出さず、すぐ測定を始める', async () => {
    const wrapper = await mountSuspended(Harness)

    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])
    await wrapper.vm.$nextTick()

    expect(startIcMock).toHaveBeenCalledWith('emp-1', '山田太郎', null)
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  it('★★ 機体が送った同じタップのサーバ由来の行が後から届いても、ボタンに出ない', async () => {
    const wrapper = await mountSuspended(Harness)
    vi.useFakeTimers()

    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])
    await wrapper.vm.$nextTick()

    // 5 秒後に一覧の引き直しでサーバ由来の行が届く (= 同じタップ)
    vi.advanceTimersByTime(5_000)
    ;(wrapper.vm as unknown as HarnessVm).setFromServer(serverRow())
    await wrapper.vm.$nextTick()
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  it('★★ オンライン: EVT → サーバーに照会 → 測定を始める (ボタンは出ない)', async () => {
    // 本番の主経路。手元の写しではなく照会の応答で始める
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    lookupMock.mockReset()
    lookupMock.mockResolvedValue({ id: 'emp-1', name: '山田太郎' })
    const wrapper = await mountSuspended(Harness)
    vi.useFakeTimers()

    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])
    await wrapper.vm.$nextTick()
    expect(startIcMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(0)
    await wrapper.vm.$nextTick()
    expect(lookupMock).toHaveBeenCalledWith('AAAA', 'default')
    expect(startIcMock).toHaveBeenCalledWith('emp-1', '山田太郎', null)
    expect(wrapper.find(BUTTON).exists()).toBe(false)
    wrapper.unmount()
  })

  it('★ 別の端末の打刻 (サーバ由来だけ) はボタンが出て、10 秒で消える', async () => {
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
