import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TenkoKiosk from '~/components/TenkoKiosk.vue'
import type { TenkoStep } from '~/composables/useTenkoKiosk'

// TenkoKiosk.vue は多くの composable (WebRTC・カメラ・指紋認証等) に依存するため、
// ここでは「PC の段 (step) が変わると CoreS3 に STAGE / RESULT を送る」配線だけを見る。
// useTenkoKiosk 自体は自前で mock し、step を外から動かせるようにする
// (自動点呼のフロー自体は tests/composables/useTenkoKiosk.test.ts が担当)。

const step = ref<TenkoStep>('nfc')
const proceedWithoutScheduleMock = vi.fn()
// 血圧の要否が確定できず入口で止めているか (Refs ippoan/alc-app#336)
const bpRequirementUnknown = ref(false)
const retryBpRequirementMock = vi.fn()

mockNuxtImport('useTenkoKiosk', () => () => ({
  step,
  employeeId: ref(''),
  employeeName: ref(''),
  pendingSchedules: ref([]),
  selectedSchedule: ref(null),
  session: ref(null),
  error: ref(null),
  isLoading: ref(false),
  safetyJudgment: ref(null),
  tenkoType: ref(null),
  isPreOperation: ref(true),
  escalatedToRemote: ref(false),
  escalationReason: ref(null),
  isRemote: ref(false),
  escalateToRemote: vi.fn(async () => {}),
  stepLabels: ref(['NFC']),
  currentStepIndex: ref(0),
  identifyEmployee: vi.fn(async () => {}),
  selectSchedule: vi.fn(async () => {}),
  proceedWithoutSchedule: proceedWithoutScheduleMock,
  bpRequirementUnknown,
  retryBpRequirement: retryBpRequirementMock,
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

mockNuxtImport('useFaceSync', () => () => ({
  isSyncing: ref(false),
  sync: vi.fn(async () => {}),
}))

mockNuxtImport('useDemoMode', () => () => ({
  isDemoMode: ref(false),
}))

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
  stream: ref(null),
  videoRef: ref(null),
  isActive: ref(false),
  start: vi.fn(async () => {}),
  stop: vi.fn(),
}))

mockNuxtImport('useBleGateway', () => () => ({
  latestTemperature: ref(null),
  latestBloodPressure: ref(null),
}))

mockNuxtImport('useFingerprint', () => () => ({
  isFingerprintAvailable: ref(false),
  isEmployeeAuthorized: vi.fn(() => false),
  authorizeEmployee: vi.fn(),
  requestFingerprint: vi.fn(),
}))

// PC の段を CoreS3 に送る口 (Refs #238)。ここでは呼ばれたかだけを見る
const syncStepMock = vi.fn()
const sendResultMock = vi.fn()
mockNuxtImport('useCoreS3Stage', () => () => ({
  syncStep: syncStepMock,
  sendResult: sendResultMock,
}))

async function mountKiosk() {
  return await mountSuspended(TenkoKiosk, {
    shallow: true,
  })
}

/** watch(step, syncStep, {...}) は Vue の watch コールバック引数をそのまま渡すので、見るのは 1 番目の引数だけ */
function stepArgOf(call: unknown[]): unknown {
  return call[0]
}

describe('TenkoKiosk — PC の段を CoreS3 に送る (useCoreS3Stage、Refs #238)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    step.value = 'nfc'
  })

  it('mount 時 (nfc ステップ) に syncStep が呼ばれる', async () => {
    const wrapper = await mountKiosk()
    expect(syncStepMock.mock.calls.map(stepArgOf)).toContain('nfc')
    wrapper.unmount()
  })

  it('step が変わるたびに syncStep が呼ばれる', async () => {
    const wrapper = await mountKiosk()

    step.value = 'medical'
    await wrapper.vm.$nextTick()
    expect(syncStepMock.mock.calls.map(stepArgOf)).toContain('medical')

    step.value = 'alcohol'
    await wrapper.vm.$nextTick()
    expect(syncStepMock.mock.calls.map(stepArgOf)).toContain('alcohol')
    wrapper.unmount()
  })

  it('測定結果が出ると sendResult が呼ばれる', async () => {
    const wrapper = await mountKiosk()

    step.value = 'alcohol'
    await wrapper.vm.$nextTick()

    const result = {
      employeeId: 'emp-1',
      alcoholValue: 0.1,
      resultType: 'normal',
      deviceUseCount: 1,
      measuredAt: new Date('2026-01-01'),
    }
    wrapper.findComponent({ name: 'AlcMeasurement' }).vm.$emit('result', result)
    await wrapper.vm.$nextTick()

    expect(sendResultMock).toHaveBeenCalledTimes(1)
    expect(sendResultMock.mock.calls[0]![0]).toMatchObject({ alcoholValue: 0.1, resultType: 'normal' })
    wrapper.unmount()
  })
})

// 自動点呼の体温・血圧ステップは「押すと必ず 400」だったスキップを出さない (Refs #322)。
// BleStatus / ManualMedicalInput の既定 (allowSkip: true) を TenkoKiosk だけが false で上書きする
describe('TenkoKiosk — 体温・血圧ステップでスキップを出さない (allowSkip=false、Refs ippoan/alc-app#322)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    step.value = 'medical'
  })

  it('BleStatus タブに allowSkip=false を渡す', async () => {
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'BleStatus' }).props('allowSkip')).toBe(false)
    wrapper.unmount()
  })

  it('手動入力タブの ManualMedicalInput にも allowSkip=false を渡す', async () => {
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    const manualTab = wrapper.findAll('button').find(b => b.text() === '手動入力')
    await manualTab!.trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'ManualMedicalInput' }).props('allowSkip')).toBe(false)
    wrapper.unmount()
  })
})

// 業務後は予定なしでも進められる (Refs ippoan/alc-app#322)
describe('TenkoKiosk — 血圧の要否が確定できないときの顔認証画面 (Refs ippoan/alc-app#336)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    step.value = 'face_auth'
    bpRequirementUnknown.value = false
  })

  it('確定していれば従来どおり顔認証を出す', async () => {
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'FaceAuth' }).exists()).toBe(true)
    expect(wrapper.findAll('button').some(b => b.text() === 'もう一度試す')).toBe(false)
    wrapper.unmount()
  })

  it('★ 不明なら顔認証を出さず、「もう一度試す」を出す (行き止まりを作らない)', async () => {
    bpRequirementUnknown.value = true
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'FaceAuth' }).exists()).toBe(false)
    const retry = wrapper.findAll('button').find(b => b.text() === 'もう一度試す')
    expect(retry).toBeTruthy()

    await retry!.trigger('click')
    expect(retryBpRequirementMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

describe('TenkoKiosk — TenkoScheduleSelect の no-schedule を proceedWithoutSchedule へ配線する', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    step.value = 'schedule_select'
  })

  it('TenkoScheduleSelect が no-schedule を発火すると proceedWithoutSchedule が呼ばれる', async () => {
    const wrapper = await mountKiosk()
    wrapper.findComponent({ name: 'TenkoScheduleSelect' }).vm.$emit('no-schedule')
    await wrapper.vm.$nextTick()

    expect(proceedWithoutScheduleMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
