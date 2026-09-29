import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import TenkoKiosk from '~/components/TenkoKiosk.vue'
import type { TenkoStep } from '~/composables/useTenkoKiosk'
import type { TenkoSession, TenkoType } from '~/types'

// 測定レコードの 2 本 (start / update) だけ差し替える。他の api は素のまま
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  startMeasurement: vi.fn(),
  updateMeasurement: vi.fn(),
}))

// TenkoKiosk.vue は多くの composable (WebRTC・カメラ・指紋認証等) に依存するため、
// ここでは「PC の段 (step) が変わると CoreS3 に STAGE / RESULT を送る」配線だけを見る。
// useTenkoKiosk 自体は自前で mock し、step を外から動かせるようにする
// (自動点呼のフロー自体は tests/composables/useTenkoKiosk.test.ts が担当)。

const step = ref<TenkoStep>('nfc')
const proceedWithoutScheduleMock = vi.fn()
// 途中で止まった点呼の再開 (Refs ippoan/alc-app#343)
const resumableSessions = ref<TenkoSession[]>([])
const resumeSessionMock = vi.fn()
// 血圧の要否が確定できず入口で止めているか (Refs ippoan/alc-app#336)
const bpRequirementUnknown = ref(false)
const retryBpRequirementMock = vi.fn()
// アルコール測定の録画 + 測定レコード (Refs ippoan/alc-app#349)
const employeeId = ref('')
const tenkoType = ref<TenkoType | null>(null)
const onAlcoholResultMock = vi.fn()

mockNuxtImport('useTenkoKiosk', () => () => ({
  step,
  employeeId,
  employeeName: ref(''),
  pendingSchedules: ref([]),
  resumableSessions,
  selectedSchedule: ref(null),
  session: ref(null),
  error: ref(null),
  isLoading: ref(false),
  safetyJudgment: ref(null),
  tenkoType,
  isPreOperation: ref(true),
  escalatedToRemote: ref(false),
  escalationReason: ref(null),
  isRemote: ref(false),
  escalateToRemote: vi.fn(async () => {}),
  stepLabels: ref(['NFC']),
  currentStepIndex: ref(0),
  identifyEmployee: vi.fn(async () => {}),
  selectSchedule: vi.fn(async () => {}),
  resumeSession: resumeSessionMock,
  proceedWithoutSchedule: proceedWithoutScheduleMock,
  bpRequirementUnknown,
  retryBpRequirement: retryBpRequirementMock,
  onFaceAuthComplete: vi.fn(),
  onAlcoholResult: onAlcoholResultMock,
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

// 録画のプレビュー用カメラと WebRTC の送信用カメラで同じものを返す (どちらも useCamera)
const cameraStream = ref<MediaStream | null>(null)
mockNuxtImport('useCamera', () => () => ({
  stream: cameraStream,
  videoRef: ref(null),
  isActive: ref(false),
  start: vi.fn(async () => {}),
  stop: vi.fn(),
}))

// 吹きかけ録画の MediaRecorder ラッパー。ここでは「呼ばれたか」だけを見る
// (中身は tests/composables/useVideoRecorder.test.ts が担当)
const startRecordingMock = vi.fn()
const stopRecordingMock = vi.fn(async () => null as Blob | null)
mockNuxtImport('useVideoRecorder', () => () => ({
  isRecording: ref(false),
  recordedBlob: ref(null),
  error: ref(null),
  startRecording: startRecordingMock,
  stopRecording: stopRecordingMock,
}))

mockNuxtImport('useBleGateway', () => () => ({
  latestTemperature: ref(null),
  latestBloodPressure: ref(null),
}))

// この端末で血圧を使うか (Refs ippoan/alc-app#347)。判定の中身は
// useBloodPressureSetting.test.ts が見る
mockNuxtImport('useBpUiEnabled', () => () => ({ bpUiState: ref('unused'), showBpUi: ref(false) }))

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
    employeeId.value = ''
    tenkoType.value = null
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
    // 結果のハンドラは録画の停止 (+ 測定レコードの更新) を待ってから進むので、
    // マイクロタスクを空にしてから見る (Refs ippoan/alc-app#349)
    await flushPromises()

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
// 途中で止まった点呼を、本人特定後の選択画面から再開する (Refs ippoan/alc-app#343)
describe('TenkoKiosk — schedule_select の再開の導線', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    step.value = 'schedule_select'
    bpRequirementUnknown.value = false
    resumableSessions.value = []
  })

  it('拾った未完了セッションを TenkoScheduleSelect へそのまま渡す', async () => {
    const stuck = { id: 'sess-stuck', status: 'medical_pending' } as TenkoSession
    resumableSessions.value = [stuck]
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'TenkoScheduleSelect' }).props('resumableSessions')).toEqual([stuck])
    wrapper.unmount()
  })

  it('resume を発火すると resumeSession がそのセッションで呼ばれる', async () => {
    const stuck = { id: 'sess-stuck', status: 'medical_pending' } as TenkoSession
    resumableSessions.value = [stuck]
    const wrapper = await mountKiosk()
    wrapper.findComponent({ name: 'TenkoScheduleSelect' }).vm.$emit('resume', stuck)
    await wrapper.vm.$nextTick()

    expect(resumeSessionMock).toHaveBeenCalledWith(stuck)
    wrapper.unmount()
  })

  it('血圧の要否が確定していれば、この画面に「もう一度試す」は出ない', async () => {
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="retry-bp-from-schedule-select"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('★ 再開が入口で止められたら、この画面にも「もう一度試す」を出す (#336 の行き止まりを作らない)', async () => {
    bpRequirementUnknown.value = true
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    const retry = wrapper.find('[data-testid="retry-bp-from-schedule-select"]')
    expect(retry.exists()).toBe(true)
    // 予定一覧は消さない — 別の予定を選ぶ道を残す
    expect(wrapper.findComponent({ name: 'TenkoScheduleSelect' }).exists()).toBe(true)

    await retry.trigger('click')
    expect(retryBpRequirementMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

/**
 * 自動点呼・遠隔点呼のアルコール測定でも、通常点呼と同じように
 * `measurements` の行を作り録画を紐づける (Refs ippoan/alc-app#349)。
 *
 * **アルコールの段は `isRemote` で分岐していない**ので、この 1 か所を通せば
 * 自動点呼と遠隔点呼の両方が同時に揃う。
 */
describe('TenkoKiosk — アルコール測定の測定レコードと録画 (Refs ippoan/alc-app#349)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    step.value = 'nfc'
    employeeId.value = 'emp-1'
    tenkoType.value = 'pre_operation'
    cameraStream.value = null
    stopRecordingMock.mockResolvedValue(null)
  })

  function emitResult(wrapper: Awaited<ReturnType<typeof mountKiosk>>) {
    wrapper.findComponent({ name: 'AlcMeasurement' }).vm.$emit('result', {
      employeeId: 'emp-1',
      alcoholValue: 0.0,
      resultType: 'normal',
      deviceUseCount: 7,
      measuredAt: new Date('2026-09-18T08:00:00Z'),
    })
  }

  it('アルコールの段に入ると measurements/start で行を作る', async () => {
    const { startMeasurement } = await import('~/utils/api')
    vi.mocked(startMeasurement).mockResolvedValue({ id: 'meas-1' } as never)

    const wrapper = await mountKiosk()
    step.value = 'alcohol'
    await flushPromises()

    expect(startMeasurement).toHaveBeenCalledWith('emp-1')
    wrapper.unmount()
  })

  it('結果が出ると PUT で完了にし、measurement_id を点呼へ渡す', async () => {
    const { startMeasurement, updateMeasurement } = await import('~/utils/api')
    vi.mocked(startMeasurement).mockResolvedValue({ id: 'meas-1' } as never)
    vi.mocked(updateMeasurement).mockResolvedValue({ id: 'meas-1' } as never)

    const wrapper = await mountKiosk()
    step.value = 'alcohol'
    await flushPromises()

    emitResult(wrapper)
    await flushPromises()

    expect(updateMeasurement).toHaveBeenCalledTimes(1)
    const [id, body] = vi.mocked(updateMeasurement).mock.calls[0]!
    expect(id).toBe('meas-1')
    expect(body).toMatchObject({
      status: 'completed',
      alcohol_value: 0.0,
      result_type: 'normal',
      device_use_count: 7,
      tenko_type: 'pre_operation',
    })
    // 3 番目の引数が measurement_id (useTenkoKiosk が SubmitAlcoholResult に載せる)
    expect(onAlcoholResultMock).toHaveBeenCalledWith('pass', 0.0, 'meas-1')
    wrapper.unmount()
  })

  it('★ 完了更新に record_as_tenko を載せない (CSV に点呼が二重に出る)', async () => {
    const { startMeasurement, updateMeasurement } = await import('~/utils/api')
    vi.mocked(startMeasurement).mockResolvedValue({ id: 'meas-1' } as never)
    vi.mocked(updateMeasurement).mockResolvedValue({ id: 'meas-1' } as never)

    const wrapper = await mountKiosk()
    step.value = 'alcohol'
    await flushPromises()
    emitResult(wrapper)
    await flushPromises()

    const body = vi.mocked(updateMeasurement).mock.calls[0]![1]
    expect(body).not.toHaveProperty('record_as_tenko')
    wrapper.unmount()
  })

  it('測定レコードが作れなくても点呼は進む (measurement_id なしで送る)', async () => {
    const { startMeasurement, updateMeasurement } = await import('~/utils/api')
    vi.mocked(startMeasurement).mockRejectedValue(new Error('403'))

    const wrapper = await mountKiosk()
    step.value = 'alcohol'
    await flushPromises()
    emitResult(wrapper)
    await flushPromises()

    expect(updateMeasurement).not.toHaveBeenCalled()
    expect(onAlcoholResultMock).toHaveBeenCalledWith('pass', 0.0, undefined)
    wrapper.unmount()
  })

  it('完了更新が失敗しても点呼は進む', async () => {
    const { startMeasurement, updateMeasurement } = await import('~/utils/api')
    vi.mocked(startMeasurement).mockResolvedValue({ id: 'meas-1' } as never)
    vi.mocked(updateMeasurement).mockRejectedValue(new Error('500'))

    const wrapper = await mountKiosk()
    step.value = 'alcohol'
    await flushPromises()
    emitResult(wrapper)
    await flushPromises()

    expect(onAlcoholResultMock).toHaveBeenCalledWith('pass', 0.0, 'meas-1')
    wrapper.unmount()
  })

  // #349 の症状そのもの: AlcMeasurement は state-change を emit していたのに
  // TenkoKiosk が listen しておらず、録画が一度も始まらなかった
  it('AlcMeasurement の state-change で吹き込み待ちから録画が始まる', async () => {
    const { startMeasurement } = await import('~/utils/api')
    vi.mocked(startMeasurement).mockResolvedValue({ id: 'meas-1' } as never)
    cameraStream.value = {} as MediaStream

    const wrapper = await mountKiosk()
    step.value = 'alcohol'
    await flushPromises()

    const alc = wrapper.findComponent({ name: 'AlcMeasurement' })
    alc.vm.$emit('state-change', 'ready')
    expect(startRecordingMock).not.toHaveBeenCalled()

    alc.vm.$emit('state-change', 'blow_waiting')
    expect(startRecordingMock).toHaveBeenCalledWith(cameraStream.value)
    wrapper.unmount()
  })
})
