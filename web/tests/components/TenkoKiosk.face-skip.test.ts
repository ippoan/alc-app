import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TenkoKiosk from '~/components/TenkoKiosk.vue'
import type { TenkoStep } from '~/composables/useTenkoKiosk'

// 乗務員の点呼は、顔を登録していない人を止めない (Refs ippoan/alc-app-s3#135)。
// 管理者の入口 (RoleAuthGate) は逆に未登録でも通さない — 方針は入口ごとに分かれ、
// 判定そのものは utils/face-approval.ts の 1 か所を共有する。

// 従業員はすべて合成値 (実在の乗務員名・カード番号は書かない)
const employee = ref<{ id: string, name: string, face_approval_status?: string }>({
  id: 'emp-test-1',
  name: 'テスト太郎',
  face_approval_status: 'none',
})
vi.mock('~/utils/api', () => ({
  getEmployeeByNfcId: vi.fn(async () => employee.value),
  getEmployeeByCode: vi.fn(async () => employee.value),
}))

const step = ref<TenkoStep>('nfc')
const error = ref<string | null>(null)
const identifyEmployeeMock = vi.fn(async () => { step.value = 'face_auth' })

mockNuxtImport('useTenkoKiosk', () => () => ({
  step,
  employeeId: ref('emp-test-1'),
  employeeName: ref('テスト太郎'),
  pendingSchedules: ref([]),
  resumableSessions: ref([]),
  selectedSchedule: ref(null),
  session: ref(null),
  error,
  isLoading: ref(false),
  bpRequirementUnknown: ref(false),
  retryBpRequirement: vi.fn(async () => {}),
  safetyJudgment: ref(null),
  tenkoType: ref(null),
  isPreOperation: ref(true),
  escalatedToRemote: ref(false),
  escalationReason: ref(null),
  isRemote: ref(false),
  escalateToRemote: vi.fn(async () => {}),
  stepLabels: ref(['NFC']),
  currentStepIndex: ref(0),
  identifyEmployee: identifyEmployeeMock,
  selectSchedule: vi.fn(async () => {}),
  resumeSession: vi.fn(async () => {}),
  onFaceAuthComplete: vi.fn(),
  onAlcoholResult: vi.fn(),
  onMedicalSubmit: vi.fn(),
  onSelfDeclarationSubmit: vi.fn(),
  onDailyInspectionSubmit: vi.fn(),
  carryingItems: ref([]),
  loadCarryingItems: vi.fn(),
  onCarryingItemsSubmit: vi.fn(),
  onInstructionConfirm: vi.fn(),
  onReportSubmit: vi.fn(),
  reset: vi.fn(),
}))

mockNuxtImport('useFaceSync', () => () => ({ isSyncing: ref(false), sync: vi.fn(async () => {}) }))
mockNuxtImport('useDemoMode', () => () => ({ isDemoMode: ref(false) }))
mockNuxtImport('useWebRtc', () => () => ({
  isConnected: ref(false),
  isPeerConnected: ref(false),
  remoteStream: ref(null),
  error: ref(null),
  connect: vi.fn(async () => {}),
  startStreaming: vi.fn(async () => {}),
  disconnect: vi.fn(),
}))
mockNuxtImport('useCamera', () => () => ({
  stream: ref(null), videoRef: ref(null), isActive: ref(false),
  start: vi.fn(async () => {}), stop: vi.fn(),
}))
mockNuxtImport('useBleGateway', () => () => ({ latestTemperature: ref(null), latestBloodPressure: ref(null) }))
mockNuxtImport('useFingerprint', () => () => ({
  isFingerprintAvailable: ref(false),
  isEmployeeAuthorized: vi.fn(() => false),
  authorizeEmployee: vi.fn(),
  requestFingerprint: vi.fn(),
}))
mockNuxtImport('useBloodPressureSetting', () => () => ({
  bpEnabled: ref(false), setBpEnabled: vi.fn(),
}))
mockNuxtImport('useCoreS3Stage', () => () => ({ syncStep: vi.fn(), sendResult: vi.fn() }))

/** 社員番号を入れて「次へ」を押す */
async function submitCode(wrapper: Awaited<ReturnType<typeof mountSuspended>>, code: string) {
  const manualBtn = wrapper.findAll('button').find(b => b.text() === '手動でIDを入力する')
  await manualBtn!.trigger('click')
  await wrapper.find('input[type="text"]').setValue(code)
  const btn = wrapper.findAll('button').find(b => b.text() === '次へ')
  await btn!.trigger('click')
  await new Promise(resolve => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
}

describe('TenkoKiosk — 顔が未登録の乗務員はスキップできる (Refs ippoan/alc-app-s3#135)', () => {
  beforeEach(() => {
    step.value = 'nfc'
    error.value = null
    identifyEmployeeMock.mockClear()
    employee.value = { id: 'emp-test-1', name: 'テスト太郎', face_approval_status: 'none' }
  })

  it('顔が未登録の乗務員はスキップできる', async () => {
    const wrapper = await mountSuspended(TenkoKiosk, { shallow: true })
    await submitCode(wrapper, '0001')

    // 弾かれず顔認証の段まで来る
    expect(error.value).toBeNull()
    expect(identifyEmployeeMock).toHaveBeenCalledTimes(1)

    // 未登録である事実と、スキップの口が出る
    expect(wrapper.text()).toContain('顔データが未登録です')
    const skipBtn = wrapper.findAll('button').find(b => b.text() === '顔認証をスキップして進む')
    expect(skipBtn).toBeTruthy()

    wrapper.unmount()
  })

  it('却下された乗務員はスキップできない (顔認証の段まで来ない)', async () => {
    employee.value = { id: 'emp-test-2', name: 'テスト次郎', face_approval_status: 'rejected' }
    const wrapper = await mountSuspended(TenkoKiosk, { shallow: true })
    await submitCode(wrapper, '0002')

    expect(error.value).toContain('却下')
    expect(identifyEmployeeMock).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('審査中の乗務員はスキップできない (顔認証の段まで来ない)', async () => {
    employee.value = { id: 'emp-test-3', name: 'テスト三郎', face_approval_status: 'pending' }
    const wrapper = await mountSuspended(TenkoKiosk, { shallow: true })
    await submitCode(wrapper, '0003')

    expect(error.value).toContain('承認待ち')
    expect(identifyEmployeeMock).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('承認済みの乗務員にはスキップの口を出さない (従来どおり顔認証)', async () => {
    employee.value = { id: 'emp-test-4', name: 'テスト四郎', face_approval_status: 'approved' }
    const wrapper = await mountSuspended(TenkoKiosk, { shallow: true })
    await submitCode(wrapper, '0004')

    expect(identifyEmployeeMock).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).not.toContain('顔認証をスキップして進む')

    wrapper.unmount()
  })
})
