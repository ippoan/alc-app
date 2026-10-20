import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly, nextTick } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import VeinRegistration from '~/components/VeinRegistration.vue'
import { BP_STATION_DEVICE_AUTH_FAILED_MESSAGE } from '~/utils/api'
import { employeeNotFoundByNfc } from '~/utils/employee-lookup-messages'

/**
 * 血圧測定タブの指静脈登録 (Refs ippoan/vein-match#20)。
 * カードをかざす → 指を 2 回読ませる → 登録。従業員はすべて合成値。
 */

const veinIsConnected = ref(true)
const veinCapture = vi.fn(async () => 'AABBCC')
const veinSay = vi.fn(async () => {})
const veinConnect = vi.fn(async () => true)

mockNuxtImport('useVeinSerial', () => () => ({
  isSupported: true,
  isConnected: readonly(veinIsConnected),
  connect: veinConnect,
  disconnect: vi.fn(async () => {}),
  capture: veinCapture,
  say: veinSay,
}))

const { putVeinTemplateMock, getEmployeeByNfcIdMock } = vi.hoisted(() => ({
  putVeinTemplateMock: vi.fn(),
  getEmployeeByNfcIdMock: vi.fn(),
}))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getEmployeeByNfcId: getEmployeeByNfcIdMock,
  putVeinTemplate: putVeinTemplateMock,
}))

const NfcStatusStub = { name: 'NfcStatus', template: '<div class="nfc-stub" />', emits: ['read'] }

async function mountVein(): Promise<VueWrapper> {
  const wrapper = await mountSuspended(VeinRegistration, {
    shallow: true,
    global: { stubs: { NfcStatus: NfcStatusStub } },
  })
  await nextTick()
  return wrapper as VueWrapper
}

async function tapCard(wrapper: VueWrapper, nfcId = 'test-card-0001') {
  await wrapper.findComponent(NfcStatusStub).vm.$emit('read', nfcId)
  await flushPromises()
}

function button(wrapper: VueWrapper, text: string) {
  const b = wrapper.findAll('button').find(x => x.text().includes(text))
  if (!b) throw new Error(`${text} のボタンが見つかりません`)
  return b
}

describe('VeinRegistration (Refs ippoan/vein-match#20)', () => {
  beforeEach(() => {
    veinIsConnected.value = true
    veinCapture.mockReset().mockResolvedValue('AABBCC')
    veinSay.mockReset().mockResolvedValue(undefined)
    veinConnect.mockReset().mockResolvedValue(true)
    putVeinTemplateMock.mockReset().mockResolvedValue({ employee_id: 'emp-test-1', updated_at: '2026-10-18T00:00:00Z' })
    getEmployeeByNfcIdMock.mockReset().mockResolvedValue({ id: 'emp-test-1', name: 'テスト太郎' })
  })

  it('マウント時に接続し、最初はカード待ち', async () => {
    const wrapper = await mountVein()
    expect(veinConnect).toHaveBeenCalled()
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
  })

  it('カードが見つからなければ理由を出し、カード待ちに残る', async () => {
    getEmployeeByNfcIdMock.mockRejectedValueOnce(Object.assign(new Error('API エラー (404): employee_not_found'), { status: 404 }))
    const wrapper = await mountVein()
    await tapCard(wrapper)
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(wrapper.find('.text-red-600').text()).toBe(employeeNotFoundByNfc('test-card-0001'))
  })

  it('測定台の鍵が取れなかった失敗は「未登録」にせず、その文言をそのまま出す (Refs #436)', async () => {
    getEmployeeByNfcIdMock.mockRejectedValueOnce(new Error(BP_STATION_DEVICE_AUTH_FAILED_MESSAGE))
    const wrapper = await mountVein()
    await tapCard(wrapper)
    expect(wrapper.find('.text-red-600').text()).toBe(BP_STATION_DEVICE_AUTH_FAILED_MESSAGE)
    expect(wrapper.text()).not.toContain('登録されていません')
  })

  it('カードで乗務員を特定 → 2 回読んで登録 → 次の人へでカード待ちに戻る', async () => {
    veinCapture.mockResolvedValueOnce('HEX-FIRST').mockResolvedValueOnce('HEX-SECOND')
    const wrapper = await mountVein()
    await tapCard(wrapper)
    expect(wrapper.text()).toContain('テスト太郎さん')
    await button(wrapper, '指静脈を登録').trigger('click')
    await flushPromises()
    expect(putVeinTemplateMock).toHaveBeenCalledWith('emp-test-1', ['HEX-FIRST', 'HEX-SECOND'])
    expect(veinSay.mock.calls.map(c => c[0])).toEqual(['PLACE', 'AGAIN', 'ENROLLED'])
    expect(wrapper.text()).toContain('指静脈を登録しました')
    await button(wrapper, '次の人へ').trigger('click')
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
  })

  it('読み取り中は「読み取り中」を出し、戻るボタンを隠す', async () => {
    let finish!: (hex: string) => void
    veinCapture.mockImplementationOnce(() => new Promise<string>((r) => { finish = r }))
    const wrapper = await mountVein()
    await tapCard(wrapper)
    await button(wrapper, '指静脈を登録').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('読み取り中')
    expect(wrapper.text()).not.toContain('血圧測定に戻る')
    expect(wrapper.text()).not.toContain('別の人にする')
    finish('HEX-FIRST')
    await flushPromises()
    expect(wrapper.text()).toContain('指静脈を登録しました')
  })

  it('読み取りに失敗したら理由を出す', async () => {
    veinCapture.mockRejectedValueOnce(new Error('NO_FINGER'))
    const wrapper = await mountVein()
    await tapCard(wrapper)
    await button(wrapper, '指静脈を登録').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('NO_FINGER')
    expect(putVeinTemplateMock).not.toHaveBeenCalled()
  })

  it('端末が外れていたら押せず、理由を出す', async () => {
    veinIsConnected.value = false
    const wrapper = await mountVein()
    await tapCard(wrapper)
    expect(button(wrapper, '指静脈を登録').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Vein Station (指静脈読み取り端末) が接続されていません')
  })

  it('別の人にする でカード待ちに戻る', async () => {
    const wrapper = await mountVein()
    await tapCard(wrapper)
    await button(wrapper, '別の人にする').trigger('click')
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
  })

  it('血圧測定に戻る で close を出す', async () => {
    const wrapper = await mountVein()
    await button(wrapper, '血圧測定に戻る').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
