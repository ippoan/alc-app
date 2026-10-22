import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly, nextTick } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import VeinRegistration from '~/components/VeinRegistration.vue'
import { BP_STATION_DEVICE_AUTH_FAILED_MESSAGE } from '~/utils/api'
import { employeeNotFoundByCode, employeeNotFoundByNfc } from '~/utils/employee-lookup-messages'

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

const { putVeinTemplateMock, getEmployeeByNfcIdMock, getEmployeeByCodeMock } = vi.hoisted(() => ({
  putVeinTemplateMock: vi.fn(),
  getEmployeeByNfcIdMock: vi.fn(),
  getEmployeeByCodeMock: vi.fn(),
}))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getEmployeeByNfcId: getEmployeeByNfcIdMock,
  getEmployeeByCode: getEmployeeByCodeMock,
  putVeinTemplate: putVeinTemplateMock,
}))

// サーバー形式 (2 回読んで PUT) の登録を確かめる。今の本番はすべてモジュール経路
// (`usesVeinModule` が真) で、そちらは useVeinEnroll.test.ts で見る (Refs ippoan/alc-app#436)
vi.mock('~/utils/vein-module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/vein-module')>()),
  usesVeinModule: () => false,
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

async function press(wrapper: VueWrapper, ...keys: string[]) {
  for (const k of keys) await wrapper.find(`[data-key="${k}"]`).trigger('click')
}

function display(wrapper: VueWrapper) {
  return wrapper.find('[data-testid="code-display"]').text()
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
    getEmployeeByCodeMock.mockReset().mockResolvedValue({ id: 'emp-test-2', name: 'テスト花子' })
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
    expect(wrapper.text()).toContain('管理者の承認後に使えます')
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

  describe('社員番号のキーパッド (Refs ippoan/alc-app#436)', () => {
    it('カードの枠と並べて出し、入力欄は input 要素にしない (端末のキーボードを出さない)', async () => {
      const wrapper = await mountVein()
      expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
      expect(wrapper.find('[data-testid="code-display"]').exists()).toBe(true)
      expect(wrapper.find('input').exists()).toBe(false)
      expect(button(wrapper, '決定').attributes('disabled')).toBeDefined()
    })

    it('数字を打つ・1 文字消す・全部消す', async () => {
      const wrapper = await mountVein()
      await press(wrapper, '1', '2', '3', '4', '5', '6', '7', '8', '9', '0')
      expect(display(wrapper)).toBe('1234567890')
      await press(wrapper, 'back')
      expect(display(wrapper)).toBe('123456789')
      await press(wrapper, 'clear')
      expect(display(wrapper)).toBe('')
    })

    it('決定で測定台の鍵の口から社員番号を引き、登録へ進む', async () => {
      const wrapper = await mountVein()
      await press(wrapper, '0', '4', '2', 'submit')
      await flushPromises()
      expect(getEmployeeByCodeMock).toHaveBeenCalledWith('042', 'bp-station')
      expect(wrapper.text()).toContain('テスト花子さん')
      await button(wrapper, '指静脈を登録').trigger('click')
      await flushPromises()
      expect(putVeinTemplateMock).toHaveBeenCalledWith('emp-test-2', ['AABBCC', 'AABBCC'])
    })

    it('見つからない (404) ときは番号の未登録を出し、入力は残す', async () => {
      getEmployeeByCodeMock.mockRejectedValueOnce(Object.assign(new Error('API エラー (404): employee_not_found'), { status: 404 }))
      const wrapper = await mountVein()
      await press(wrapper, '9', '9', 'submit')
      await flushPromises()
      expect(wrapper.find('.text-red-600').text()).toBe(employeeNotFoundByCode('99'))
      expect(display(wrapper)).toBe('99')
    })

    it('測定台の鍵が取れなかった失敗は「未登録」にせず、その文言をそのまま出す', async () => {
      getEmployeeByCodeMock.mockRejectedValueOnce(new Error(BP_STATION_DEVICE_AUTH_FAILED_MESSAGE))
      const wrapper = await mountVein()
      await press(wrapper, '1', 'submit')
      await flushPromises()
      expect(wrapper.find('.text-red-600').text()).toBe(BP_STATION_DEVICE_AUTH_FAILED_MESSAGE)
    })

    it('別の人にする で入力も消える', async () => {
      const wrapper = await mountVein()
      await press(wrapper, '7', 'submit')
      await flushPromises()
      await button(wrapper, '別の人にする').trigger('click')
      expect(display(wrapper)).toBe('')
    })
  })
})
