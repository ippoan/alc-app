import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly, nextTick } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import RegisterPage from '~/pages/register.vue'

/**
 * register.vue の指静脈登録手順 (Refs ippoan/vein-match#20)。
 * 顔登録 (FaceAuth 実物は使わない) やドロップダウンの列挙は最小限に留め、
 * 「乗務員を選んだ後の指静脈ボタン」だけを見る。
 */

mockNuxtImport('useAuth', () => () => ({
  isAuthenticated: ref(true),
  isLoading: ref(false),
  accessToken: ref('admin-jwt'),
  deviceTenantId: ref('tenant-1'),
  refreshAccessToken: vi.fn(async () => {}),
}))

const veinIsConnected = ref(false)
const veinCapture = vi.fn(async () => 'AABBCC')
const veinSay = vi.fn(async () => {})
const veinConnect = vi.fn(async () => true)
let veinIsSupported = true

mockNuxtImport('useVeinSerial', () => () => ({
  get isSupported() { return veinIsSupported },
  isConnected: readonly(veinIsConnected),
  connect: veinConnect,
  disconnect: vi.fn(async () => {}),
  capture: veinCapture,
  say: veinSay,
}))

const putVeinTemplateMock = vi.fn(async () => ({ employee_id: 'emp-1', updated_at: '2026-09-25T00:00:00Z' }))

vi.mock('~/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/utils/api')>()
  return {
    ...actual,
    getEmployees: vi.fn(async () => [{ id: 'emp-1', name: '山田太郎', code: 'D001' }]),
    putVeinTemplate: (...args: unknown[]) => putVeinTemplateMock(...(args as [string, string[]])),
  }
})

async function mountRegister(): Promise<VueWrapper> {
  const wrapper = await mountSuspended(RegisterPage, { shallow: true })
  await nextTick()
  await nextTick()
  return wrapper as VueWrapper
}

async function selectEmployee(wrapper: VueWrapper) {
  await wrapper.find('select').setValue('emp-1')
  await nextTick()
}

function veinButton(wrapper: VueWrapper) {
  const button = wrapper.findAll('button').find(b => b.text().includes('指静脈'))
  if (!button) throw new Error('指静脈ボタンが見つかりません')
  return button
}

describe('pages/register — 指静脈登録', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    veinIsConnected.value = false
    veinIsSupported = true
    veinCapture.mockReset().mockResolvedValue('AABBCC')
    veinSay.mockReset().mockResolvedValue(undefined)
    veinConnect.mockReset().mockResolvedValue(true)
    putVeinTemplateMock.mockReset().mockResolvedValue({ employee_id: 'emp-1', updated_at: '2026-09-25T00:00:00Z' })
  })

  it('マウント時に veinSerial.connect() を呼ぶ', async () => {
    await mountRegister()
    expect(veinConnect).toHaveBeenCalled()
  })

  it('端末が未接続だとボタンが押せず、理由が出る', async () => {
    const wrapper = await mountRegister()
    await selectEmployee(wrapper)

    const button = veinButton(wrapper)
    expect(button.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Vein Station (指静脈読み取り端末) が接続されていません')
  })

  it('WebSerial 非対応でもボタンが押せず、理由が出る', async () => {
    veinIsSupported = false
    const wrapper = await mountRegister()
    await selectEmployee(wrapper)

    const button = veinButton(wrapper)
    expect(button.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('WebSerial に対応していません')
  })

  it('接続済みなら押せる。2 回読んで PUT が呼ばれ、案内は PLACE→AGAIN→ENROLLED の順', async () => {
    veinIsConnected.value = true
    const wrapper = await mountRegister()
    await selectEmployee(wrapper)

    const button = veinButton(wrapper)
    expect(button.attributes('disabled')).toBeUndefined()

    veinCapture.mockResolvedValueOnce('HEX-FIRST').mockResolvedValueOnce('HEX-SECOND')
    await button.trigger('click')
    await flushPromises()

    expect(veinCapture).toHaveBeenCalledTimes(2)
    expect(putVeinTemplateMock).toHaveBeenCalledWith('emp-1', ['HEX-FIRST', 'HEX-SECOND'])
    expect(veinSay.mock.calls.map(c => c[0])).toEqual(['PLACE', 'AGAIN', 'ENROLLED'])
    expect(wrapper.text()).toContain('指静脈を登録しました')
  })

  it('1 回目の capture が失敗したら FAILED を案内し、理由を表示する (PUT は呼ばない)', async () => {
    veinIsConnected.value = true
    const wrapper = await mountRegister()
    await selectEmployee(wrapper)

    veinCapture.mockRejectedValueOnce(new Error('NO_FINGER'))
    await veinButton(wrapper).trigger('click')
    await flushPromises()

    expect(putVeinTemplateMock).not.toHaveBeenCalled()
    expect(veinSay.mock.calls.map(c => c[0])).toEqual(['PLACE', 'FAILED'])
    expect(wrapper.text()).toContain('NO_FINGER')
  })

  it('2 回目の capture が失敗したら FAILED を案内し、理由を表示する (PUT は呼ばない)', async () => {
    veinIsConnected.value = true
    const wrapper = await mountRegister()
    await selectEmployee(wrapper)

    veinCapture.mockResolvedValueOnce('HEX-FIRST').mockRejectedValueOnce(new Error('READ_FAIL'))
    await veinButton(wrapper).trigger('click')
    await flushPromises()

    expect(putVeinTemplateMock).not.toHaveBeenCalled()
    expect(veinSay.mock.calls.map(c => c[0])).toEqual(['PLACE', 'AGAIN', 'FAILED'])
    expect(wrapper.text()).toContain('READ_FAIL')
  })

  it('422 なら putVeinTemplate の message を表示する (FAILED も案内する)', async () => {
    veinIsConnected.value = true
    const wrapper = await mountRegister()
    await selectEmployee(wrapper)

    putVeinTemplateMock.mockRejectedValueOnce(
      new Error('API エラー (422): {"error":"invalid_chara_hex","message":"特徴量が16進数ではありません"}'),
    )
    await veinButton(wrapper).trigger('click')
    await flushPromises()

    expect(veinSay.mock.calls.map(c => c[0])).toEqual(['PLACE', 'AGAIN', 'FAILED'])
    expect(wrapper.text()).toContain('特徴量が16進数ではありません')
    expect(wrapper.text()).not.toContain('指静脈を登録しました')
  })
})
