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
const getEmployeeByNfcIdMock = vi.fn(async () => employee.value)
const updateDeviceLastLoginMock = vi.fn(async () => {})

vi.mock('~/utils/api', () => ({
  getEmployeeByNfcId: (...args: unknown[]) => getEmployeeByNfcIdMock(...args as []),
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

// 指静脈の照合 (手順は useVeinEmployeeIdentify で共通)。入口が渡した設定を控え、特定できた人を渡すのはテストが行う
type VeinOpts = Parameters<typeof import('~/composables/useVeinEmployeeIdentify').useVeinEmployeeIdentify>[0]
let veinOpts: VeinOpts | null = null
const veinState = {
  ready: ref(false),
  busy: ref(false),
  again: ref(false),
  error: ref<string | null>(null),
}
const veinIdentifyMock = vi.fn(async () => {})
mockNuxtImport('useVeinEmployeeIdentify', () => (opts: VeinOpts) => {
  veinOpts = opts
  return { ...veinState, identify: veinIdentifyMock, sync: vi.fn() }
})

// 「この端末の指を足す」(Refs ippoan/alc-app#558)。手順は useVeinAddDevice.test.ts の領分で、ここは入口だけ見る
const addDevice = { add: vi.fn(async () => true), reset: vi.fn(), scope: null as string | null }
const addState = {
  adding: ref(false),
  available: ref(true),
  added: ref(false),
  error: ref<string | null>(null),
  notice: ref<string | null>(null),
}
mockNuxtImport('useVeinAddDevice', () => (opts: { scope: string }) => {
  addDevice.scope = opts.scope
  return { ...addState, add: addDevice.add, reset: addDevice.reset }
})

// NFC の読み取りは部品を差し替え、`read` を流す
const NfcStatusStub = { name: 'NfcStatus', template: '<div data-testid="nfc-status" />', emits: ['read'] }
const stubs = { NfcStatus: NfcStatusStub }

async function settle(wrapper: Awaited<ReturnType<typeof mountSuspended>>) {
  await new Promise(resolve => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
}

/** 社員番号を入れて「次へ」を押す (システム管理者の入口だけ。step 'nfc' は既定で手動入力) */
async function submitCode(wrapper: Awaited<ReturnType<typeof mountSuspended>>, code: string) {
  await wrapper.find('input[type="text"]').setValue(code)
  const btn = wrapper.findAll('button').find(b => b.text() === '次へ')
  await btn!.trigger('click')
  await settle(wrapper)
}

/** NFC でカードを読んだことにする */
async function readNfc(wrapper: Awaited<ReturnType<typeof mountSuspended>>, nfcId: string) {
  wrapper.findComponent(NfcStatusStub).vm.$emit('read', nfcId)
  await settle(wrapper)
}

function mountGate(requiredRole: 'manager' | 'admin') {
  return mountSuspended(RoleAuthGate, { props: { requiredRole }, global: { stubs } })
}

beforeEach(() => {
  veinOpts = null
  veinState.ready.value = false
  veinState.busy.value = false
  veinState.error.value = null
  veinIdentifyMock.mockClear()
  getEmployeeByCodeMock.mockClear()
  getEmployeeByNfcIdMock.mockClear()
})

const AUTH_FAILED = '端末の鍵が取れませんでした (テスト用の文言)'

describe('RoleAuthGate — 乗務員の照会が失敗したとき (Refs #436)', () => {
  it('席の鍵が取れなかった失敗は「見つかりません」にせず、その文言をそのまま出す', async () => {
    getEmployeeByNfcIdMock.mockRejectedValueOnce(new Error(AUTH_FAILED))
    const wrapper = await mountGate('manager')
    await readNfc(wrapper, '0001')
    expect(wrapper.text()).toContain(AUTH_FAILED)
    expect(wrapper.text()).not.toContain('見つかりません')
  })

  it('404 は「登録されていません」(NFC の文言)', async () => {
    getEmployeeByNfcIdMock.mockRejectedValueOnce(Object.assign(new Error('API エラー (404): x'), { status: 404 }))
    const wrapper = await mountGate('manager')
    await readNfc(wrapper, '0001')
    expect(wrapper.text()).toContain('乗務員に登録されていません')
  })
})

describe('RoleAuthGate — 管理者の入口は顔認証が必須 (Refs ippoan/alc-app-s3#135)', () => {
  beforeEach(() => {
    faceSyncMock.mockClear()
    setManagerIdMock.mockClear()
    employee.value = { id: 'emp-test-1', name: 'テスト太郎', role: ['manager'], face_approval_status: 'none' }
  })

  it('顔が未登録でも管理者はスキップできない', async () => {
    const wrapper = await mountGate('manager')
    await readNfc(wrapper, '0001')

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
    const wrapper = await mountGate('manager')
    await readNfc(wrapper, '0002')

    expect(wrapper.text()).toContain('顔データが未登録です')
    expect(wrapper.text()).not.toContain('スキップ')
    expect(faceSyncMock).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('却下・審査中は従来どおり弾く (スキップの迂回路を作らない)', async () => {
    employee.value = { id: 'emp-test-3', name: 'テスト次郎', role: ['manager'], face_approval_status: 'rejected' }
    const wrapper = await mountGate('manager')
    await readNfc(wrapper, '0003')

    expect(wrapper.text()).toContain('却下')
    expect(wrapper.text()).not.toContain('スキップ')
    expect(faceSyncMock).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('承認済みなら従来どおり顔認証の段へ進む', async () => {
    employee.value = { id: 'emp-test-4', name: 'テスト三郎', role: ['manager'], face_approval_status: 'approved' }
    const wrapper = await mountGate('manager')
    await readNfc(wrapper, '0004')

    expect(faceSyncMock).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent({ name: 'FaceAuth' }).exists()).toBe(true)

    wrapper.unmount()
  })
})

describe('RoleAuthGate — 運行管理者は社員番号を打てない・指静脈で特定できる', () => {
  beforeEach(() => {
    faceSyncMock.mockClear()
    employee.value = { id: 'emp-test-5', name: 'テスト四郎', role: ['manager'], face_approval_status: 'approved' }
  })

  it('指静脈の照合データと照会は、運行管理者の入口は席の鍵、システム管理者は既定の鍵で行う', async () => {
    const manager = await mountGate('manager')
    expect(veinOpts!.scope).toBe('manager-device')
    manager.unmount()
    const admin = await mountGate('admin')
    expect(veinOpts!.scope).toBe('default')
    admin.unmount()
  })

  it('運行管理者の入口は社員番号の手入力を出さない (切り替えのリンクも無い)', async () => {
    const wrapper = await mountGate('manager')
    expect(wrapper.find('input[type="text"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('手動でIDを入力する')
    expect(wrapper.find('[data-testid="nfc-status"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('NFC + 顔認証、または指静脈が必要です')
    wrapper.unmount()
  })

  it('システム管理者の入口は今までどおり社員番号で進める', async () => {
    employee.value = { ...employee.value, role: ['admin'] }
    const wrapper = await mountGate('admin')
    expect(wrapper.text()).toContain('ID + 顔認証が必要です')
    await submitCode(wrapper, '0005')
    expect(getEmployeeByCodeMock).toHaveBeenCalledWith('0005')
    expect(wrapper.findComponent({ name: 'FaceAuth' }).exists()).toBe(true)
    wrapper.unmount()
  })

  it('Vein が繋がっていなければ指静脈のボタンを出さず、繋がっていれば出して押すと照合する', async () => {
    const wrapper = await mountGate('manager')
    expect(wrapper.find('[data-testid="vein-identify"]').exists()).toBe(false)

    veinState.ready.value = true
    await wrapper.vm.$nextTick()
    const button = wrapper.find('[data-testid="vein-identify"]')
    expect(button.text()).toBe('指静脈で本人確認')
    await button.trigger('click')
    expect(veinIdentifyMock).toHaveBeenCalledTimes(1)

    // 読み取り中・撮り直し・理由の表示
    veinState.busy.value = true
    veinState.again.value = true
    veinState.error.value = '一致しません (テスト)'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="vein-identify"]').text()).toBe('もう一度置いてください…')
    expect(wrapper.find('[data-testid="vein-identify"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="vein-error"]').text()).toBe('一致しません (テスト)')
    veinState.again.value = false
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="vein-identify"]').text()).toBe('指を置いてください…')
    wrapper.unmount()
  })

  it('指静脈で特定した人は顔認証を挟まずに通す (顔が未登録でも通す。端末に運行管理者を控える)', async () => {
    setManagerIdMock.mockClear()
    updateDeviceLastLoginMock.mockClear()
    employee.value = { ...employee.value, face_approval_status: 'none' }
    const wrapper = await mountGate('manager')
    const failure = await veinOpts!.onEmployee(employee.value as never)
    await settle(wrapper)
    expect(failure).toBeNull()
    expect(faceSyncMock).not.toHaveBeenCalled()
    expect(wrapper.findComponent({ name: 'FaceAuth' }).exists()).toBe(false)
    expect(wrapper.text()).toContain('テスト四郎 (運行管理者) としてログイン中')
    expect(setManagerIdMock).toHaveBeenCalledWith('emp-test-5')
    expect(updateDeviceLastLoginMock).toHaveBeenCalledWith('device-test-1', 'emp-test-5', 'テスト四郎', ['manager'])
    wrapper.unmount()
  })

  it('システム管理者を指静脈で通しても、運行管理者としては控えない', async () => {
    setManagerIdMock.mockClear()
    employee.value = { ...employee.value, role: ['admin'] }
    const wrapper = await mountGate('admin')
    expect(await veinOpts!.onEmployee(employee.value as never)).toBeNull()
    await settle(wrapper)
    expect(wrapper.text()).toContain('(システム管理者) としてログイン中')
    expect(setManagerIdMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('指静脈で特定した人に権限が無ければ、理由を返して通さない', async () => {
    const wrapper = await mountGate('manager')
    employee.value = { ...employee.value, role: ['driver'] }
    expect(await veinOpts!.onEmployee(employee.value as never)).toContain('運行管理者の権限がありません')
    await settle(wrapper)
    expect(wrapper.text()).not.toContain('としてログイン中')
    wrapper.unmount()
  })

  it('指静脈の照合を始めるときは前の理由を消し、待機中 (NFC の段で照会も同期もしていない) だけ指の合図を受ける', async () => {
    const wrapper = await mountGate('manager')
    expect(veinOpts!.isIdle()).toBe(true)
    getEmployeeByNfcIdMock.mockRejectedValueOnce(new Error(AUTH_FAILED))
    await readNfc(wrapper, '0006')
    expect(wrapper.text()).toContain(AUTH_FAILED)
    veinOpts!.onStart!()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain(AUTH_FAILED)

    veinState.busy.value = true
    expect(veinOpts!.isIdle()).toBe(false)
    veinState.busy.value = false
    // 顔認証の段では受けない
    await readNfc(wrapper, '0007')
    expect(veinOpts!.isIdle()).toBe(false)
    expect(veinOpts!.missMessage).toContain('NFC')
    expect(veinOpts!.pendingMessage(null)).toContain('この人さん')
    expect(veinOpts!.pendingMessage('テスト')).toContain('テストさん')
    wrapper.unmount()
  })
})

describe('RoleAuthGate — この端末の指を足す (Refs ippoan/alc-app#558)', () => {
  beforeEach(() => {
    addDevice.add.mockClear()
    addDevice.reset.mockClear()
    addState.adding.value = false
    addState.available.value = true
    addState.added.value = false
    addState.error.value = null
    addState.notice.value = null
    employee.value = { id: 'emp-test-6', name: 'テスト五郎', role: ['manager'], face_approval_status: 'approved' }
  })

  /** NFC → 顔認証の成功まで進める */
  async function loginByCard(wrapper: Awaited<ReturnType<typeof mountGate>>) {
    await readNfc(wrapper, '0006')
    wrapper.findComponent({ name: 'FaceAuth' }).vm.$emit('result', { verified: true, similarity: 0.9 })
    await settle(wrapper)
  }

  it('NFC + 顔認証で入った運行管理者には、運行管理者席の鍵で足すボタンを任意で出す (ログインは止めない)', async () => {
    const wrapper = await mountGate('manager')
    expect(addDevice.scope).toBe('manager-device')
    await loginByCard(wrapper)
    expect(wrapper.text()).toContain('テスト五郎 (運行管理者) としてログイン中')
    const btn = wrapper.find('[data-testid="vein-add-device"]')
    expect(btn.text()).toBe('この端末の指を足す')
    await btn.trigger('click')
    expect(addDevice.add).toHaveBeenCalledWith('emp-test-6')
    wrapper.unmount()
  })

  it('足している間は案内 (置き直し / 既定の文言) を出して押せない。結果と失敗の理由も出る', async () => {
    const wrapper = await mountGate('manager')
    await loginByCard(wrapper)
    addState.adding.value = true
    await settle(wrapper)
    expect(wrapper.find('[data-testid="vein-add-device"]').text()).toBe('指を置いてください…')
    expect(wrapper.find('[data-testid="vein-add-device"]').attributes('disabled')).toBeDefined()
    addState.notice.value = 'もう一度置いてください (2/6)'
    await settle(wrapper)
    expect(wrapper.find('[data-testid="vein-add-device"]').text()).toBe('もう一度置いてください (2/6)')
    addState.adding.value = false
    addState.added.value = true
    addState.error.value = '失敗の理由'
    await settle(wrapper)
    expect(wrapper.find('[data-testid="vein-add-device-done"]').text()).toBe('この端末の指を足しました')
    expect(wrapper.find('[data-testid="vein-add-device-error"]').text()).toBe('失敗の理由')
    wrapper.unmount()
  })

  it('Vein の機体が繋がっていなければ出さない。ログアウトで消し、控えも片付ける', async () => {
    const wrapper = await mountGate('manager')
    addState.available.value = false
    await loginByCard(wrapper)
    expect(wrapper.find('[data-testid="vein-add-device"]').exists()).toBe(false)
    addState.available.value = true
    await settle(wrapper)
    expect(wrapper.find('[data-testid="vein-add-device"]').exists()).toBe(true)
    await wrapper.findAll('button').find(b => b.text() === 'ログアウト')!.trigger('click')
    await settle(wrapper)
    expect(addDevice.reset).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('指静脈で入った人・システム管理者の入口には出さない', async () => {
    const byVein = await mountGate('manager')
    await veinOpts!.onEmployee(employee.value as never)
    await settle(byVein)
    expect(byVein.text()).toContain('としてログイン中')
    expect(byVein.find('[data-testid="vein-add-device"]').exists()).toBe(false)
    byVein.unmount()

    employee.value = { ...employee.value, role: ['admin'] }
    const admin = await mountGate('admin')
    await submitCode(admin, '0006')
    admin.findComponent({ name: 'FaceAuth' }).vm.$emit('result', { verified: true, similarity: 0.9 })
    await settle(admin)
    expect(admin.text()).toContain('としてログイン中')
    expect(admin.find('[data-testid="vein-add-device"]').exists()).toBe(false)
    admin.unmount()
  })
})
