import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import RoleAuthGate from '~/components/RoleAuthGate.vue'

// 運行管理者の入口は顔認証が必須。顔が未登録でもスキップは認めない
// (認めると顔写真を一切出さずに管理画面へ入れてしまう。Refs ippoan/alc-app-s3#135)。
// 乗務員の点呼側 (TenkoKiosk) は未登録なら通す — 方針は入口ごとに分かれる。

// 従業員はすべて合成値 (実在の乗務員名・カード番号は書かない)
const employee = ref<{ id: string, name: string, role: string[], face_approval_status?: string }>({
  id: 'emp-test-1',
  name: 'テスト太郎',
  role: ['manager'],
  face_approval_status: 'none',
})
const getEmployeeByCodeMock = vi.fn(async () => employee.value)
const updateDeviceLastLoginMock = vi.fn(async () => {})

vi.mock('~/utils/api', () => ({
  getEmployeeByNfcId: vi.fn(async () => employee.value),
  getEmployeeByCode: (...args: unknown[]) => getEmployeeByCodeMock(...args as []),
  getEmployeeById: vi.fn(async () => { throw new Error('not registered') }),
  updateDeviceLastLogin: (...args: unknown[]) => updateDeviceLastLoginMock(...args as []),
}))

const faceSyncMock = vi.fn(async () => {})
mockNuxtImport('useFaceSync', () => () => ({
  sync: faceSyncMock,
  isSyncing: ref(false),
}))

mockNuxtImport('useAuth', () => () => ({
  isAuthenticated: ref(false),
  deviceId: ref('device-test-1'),
}))

const setManagerIdMock = vi.fn()
mockNuxtImport('useManagerAuth', () => () => ({
  setManagerId: setManagerIdMock,
  loadFromDevice: vi.fn(),
  authenticatedManagerId: ref(null),
}))

mockNuxtImport('useFingerprint', () => () => ({
  isFingerprintAvailable: ref(false),
  isEmployeeAuthorized: vi.fn(() => false),
  authorizeEmployee: vi.fn(),
  requestFingerprint: vi.fn(),
}))

/** 社員番号を入れて「次へ」を押す (step 'nfc' は既定で手動入力) */
async function submitCode(wrapper: Awaited<ReturnType<typeof mountSuspended>>, code: string) {
  await wrapper.find('input[type="text"]').setValue(code)
  const btn = wrapper.findAll('button').find(b => b.text() === '次へ')
  await btn!.trigger('click')
  await new Promise(resolve => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
}

describe('RoleAuthGate — 管理者の入口は顔認証が必須 (Refs ippoan/alc-app-s3#135)', () => {
  beforeEach(() => {
    faceSyncMock.mockClear()
    setManagerIdMock.mockClear()
    employee.value = { id: 'emp-test-1', name: 'テスト太郎', role: ['manager'], face_approval_status: 'none' }
  })

  it('顔が未登録でも管理者はスキップできない', async () => {
    const wrapper = await mountSuspended(RoleAuthGate, { props: { requiredRole: 'manager' as const } })
    await submitCode(wrapper, '0001')

    // 顔認証の段へ進まず、スキップの口も出さない
    expect(wrapper.text()).not.toContain('スキップ')
    expect(wrapper.findComponent({ name: 'FaceAuth' }).exists()).toBe(false)
    // 未登録である事実と、次の一手 (顔データの登録) を出す
    expect(wrapper.text()).toContain('顔データが未登録です')
    expect(wrapper.text()).toContain('顔データを登録してください')
    // 通っていない = 顔データ同期も認証もしていない
    expect(faceSyncMock).not.toHaveBeenCalled()
    expect(setManagerIdMock).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('としてログイン中')

    wrapper.unmount()
  })

  it('face_approval_status が未設定でも管理者はスキップできない', async () => {
    employee.value = { id: 'emp-test-2', name: 'テスト花子', role: ['manager'] }
    const wrapper = await mountSuspended(RoleAuthGate, { props: { requiredRole: 'manager' as const } })
    await submitCode(wrapper, '0002')

    expect(wrapper.text()).toContain('顔データが未登録です')
    expect(wrapper.text()).not.toContain('スキップ')
    expect(faceSyncMock).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('却下・審査中は従来どおり弾く (スキップの迂回路を作らない)', async () => {
    employee.value = { id: 'emp-test-3', name: 'テスト次郎', role: ['manager'], face_approval_status: 'rejected' }
    const wrapper = await mountSuspended(RoleAuthGate, { props: { requiredRole: 'manager' as const } })
    await submitCode(wrapper, '0003')

    expect(wrapper.text()).toContain('却下')
    expect(wrapper.text()).not.toContain('スキップ')
    expect(faceSyncMock).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('承認済みなら従来どおり顔認証の段へ進む', async () => {
    employee.value = { id: 'emp-test-4', name: 'テスト三郎', role: ['manager'], face_approval_status: 'approved' }
    const wrapper = await mountSuspended(RoleAuthGate, { props: { requiredRole: 'manager' as const } })
    await submitCode(wrapper, '0004')

    expect(faceSyncMock).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent({ name: 'FaceAuth' }).exists()).toBe(true)

    wrapper.unmount()
  })
})
