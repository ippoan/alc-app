import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  getTenkoSession: vi.fn(),
  cancelTenkoSession: vi.fn(),
  getEmployeeByNfcId: vi.fn(),
  getEmployeeByCode: vi.fn(),
}))

// 故障の自動記録 (記録の中身は tests/utils/equipment-failure-report.test.ts)。ここでは「どこで何を記録するか」の配線だけを見る
const failureReport = vi.hoisted(() => ({ reportFailure: vi.fn(), reportApiFailure: vi.fn() }))
vi.mock('~/utils/equipment-failure-report', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/equipment-failure-report')>()),
  ...failureReport,
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
// 測定台で測った直近の血圧 (体温・血圧の段で引き当てる)
// アルコール測定の録画 + 測定レコード (Refs ippoan/alc-app#349)
const employeeId = ref('')
const tenkoType = ref<TenkoType | null>(null)
const onAlcoholMeasuredMock = vi.fn(async () => false)
// 遠隔点呼か (完了で通話の部屋から出るかの確かめに使う)
const isRemote = ref(false)
// 点呼のセッション (サーバが開始で作った測定の `measurement_id` を持つ)
const session = ref<Partial<TenkoSession> | null>(null)

const onInstructionConfirmMock = vi.fn()
const onReportSubmitMock = vi.fn()
const kioskError = ref<string | null>(null)
const resetMock = vi.fn()
// 車両番号の段 (業務前 二十 ハ)
const vehicleInput = ref('')
const vehicleManualRequired = ref(false)
const onVehicleSubmitMock = vi.fn()
mockNuxtImport('useTenkoKiosk', () => () => ({
  step,
  employeeId,
  employeeName: ref(''),
  pendingSchedules: ref([]),
  resumableSessions,
  selectedSchedule: ref(null),
  session,
  error: kioskError,
  isLoading: ref(false),
  safetyJudgment: ref(null),
  tenkoType,
  isPreOperation: ref(true),
  escalatedToRemote: ref(false),
  escalationReason: ref(null),
  isRemote,
  escalateToRemote: vi.fn(async () => {}),
  stepLabels: ref(['NFC']),
  currentStepIndex: ref(0),
  identifyEmployee: vi.fn(async () => {}),
  selectSchedule: vi.fn(async () => {}),
  resumeSession: resumeSessionMock,
  proceedWithoutSchedule: proceedWithoutScheduleMock,
  onFaceAuthComplete: vi.fn(),
  vehicleInput,
  vehicleManualRequired,
  onVehicleSubmit: onVehicleSubmitMock,
  onAlcoholMeasured: onAlcoholMeasuredMock,
  onMedicalSubmit: vi.fn(),
  onSelfDeclarationSubmit: vi.fn(),
  onDailyInspectionSubmit: vi.fn(),
  carryingItems: ref([]),
  loadCarryingItems: vi.fn(),
  onCarryingItemsSubmit: vi.fn(),
  onInstructionConfirm: onInstructionConfirmMock,
  onReportSubmit: onReportSubmitMock,
  reset: resetMock,
}))

mockNuxtImport('useFaceSync', () => () => ({
  isSyncing: ref(false),
  sync: vi.fn(async () => {}),
}))

const demoMode = ref(false)
mockNuxtImport('useDemoMode', () => () => ({
  isDemoMode: demoMode,
}))

const webRtcConnectMock = vi.fn(async () => {})
const webRtcDisconnectMock = vi.fn()
// 運行管理者と通話がつながっているか
const isPeerConnected = ref(false)
mockNuxtImport('useWebRtc', () => () => ({
  isConnected: ref(false),
  isPeerConnected,
  remoteStream: ref(null),
  error: ref(null),
  connect: webRtcConnectMock,
  startStreaming: vi.fn(async () => {}),
  disconnect: webRtcDisconnectMock,
}))

// 録画のプレビュー用カメラと WebRTC の送信用カメラで同じものを返す (どちらも useCamera)
const cameraStream = ref<MediaStream | null>(null)
const cameraStartMock = vi.fn(async () => {})
mockNuxtImport('useCamera', () => () => ({
  stream: cameraStream,
  videoRef: ref(null),
  isActive: ref(false),
  start: cameraStartMock,
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

// 体温計・血圧計 (BLE ゲートウェイ) のエラー
const bleError = ref<string | null>(null)
const showBpUiRef = ref(false)
const bleBloodPressure = ref<{ systolic: number, diastolic: number, pulse: number } | null>(null)
mockNuxtImport('useBleGateway', () => () => ({
  latestTemperature: ref(null),
  latestBloodPressure: bleBloodPressure,
  error: bleError,
}))

// この端末で血圧を使うか (Refs ippoan/alc-app#347)。判定の中身は
// useBloodPressureSetting.test.ts が見る
mockNuxtImport('useBpUiEnabled', () => () => ({ bpUiState: ref('unused'), showBpUi: showBpUiRef }))

mockNuxtImport('useFingerprint', () => () => ({
  isFingerprintAvailable: ref(false),
  isEmployeeAuthorized: vi.fn(() => false),
  authorizeEmployee: vi.fn(),
  requestFingerprint: vi.fn(),
}))

// PC の段を CoreS3 に送る口 (Refs #238)。ここでは呼ばれたかだけを見る
const syncStepMock = vi.fn()
const sendResultMock = vi.fn()
const sendMeasurementIdMock = vi.fn()
mockNuxtImport('useCoreS3Stage', () => () => ({
  syncStep: syncStepMock,
  sendResult: sendResultMock,
  sendMeasurementId: sendMeasurementIdMock,
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
    demoMode.value = false
  })

  it('BleStatus タブに allowSkip=false を渡す', async () => {
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'BleStatus' }).props('allowSkip')).toBe(false)
    wrapper.unmount()
  })

  it('★ 手動入力のタブは出さない (体温は機体から受けるだけ。業務前 七・八・十)', async () => {
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('button').some(b => b.text() === '手動入力')).toBe(false)
    expect(wrapper.findComponent({ name: 'ManualMedicalInput' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('デモの端末だけ ManualMedicalInput を出し、allowSkip=false を渡す', async () => {
    demoMode.value = true
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'BleStatus' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'ManualMedicalInput' }).props('allowSkip')).toBe(false)
    wrapper.unmount()
    demoMode.value = false
  })
})

// 血圧は血圧測定台 (別端末) で測る。血圧計が無い端末 (showBpUi=false) の体温の段は、体温だけを扱う
describe('TenkoKiosk — 体温の段: 血圧計が無い端末は体温だけ', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    step.value = 'medical'
    isRemote.value = false
    showBpUiRef.value = false
    bleBloodPressure.value = null
  })

  it('★ 見出しは「体温」。測定台の血圧の行・「血圧を読み込む」は出さず、測定台で測る案内だけ出す', async () => {
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('h2').text()).toBe('体温')
    expect(wrapper.find('[data-testid="station-bp"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('血圧を読み込む')
    expect(wrapper.text()).toContain('血圧は測定台で測った値を使います。測っていないときは遠隔点呼に切り替わります。')
    wrapper.unmount()
  })

  it('★ 「遠隔点呼に切り替える」の逃げ道 (血圧が測れないとき用) を出さない', async () => {
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('button').some(b => b.text() === '遠隔点呼に切り替える')).toBe(false)
    wrapper.unmount()
  })

  it('★ BleStatus の血圧計の未確認表示を隠す', async () => {
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'BleStatus' }).props('hideBpStatus')).toBe(true)
    wrapper.unmount()
  })

  it('血圧計がある端末では見出しは「体温・血圧」で、逃げ道も出し、血圧計の表示も隠さない', async () => {
    showBpUiRef.value = true
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('h2').text()).toBe('体温・血圧')
    expect(wrapper.findAll('button').some(b => b.text() === '遠隔点呼に切り替える')).toBe(true)
    expect(wrapper.findComponent({ name: 'BleStatus' }).props('hideBpStatus')).toBe(false)
    wrapper.unmount()
  })

  it('血圧計がある端末でも遠隔点呼では逃げ道を出さない', async () => {
    showBpUiRef.value = true
    isRemote.value = true
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('button').some(b => b.text() === '遠隔点呼に切り替える')).toBe(false)
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
    session.value = null
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
    // 始めた測定の id を CoreS3 に渡す (この後のアルコールの記録に載る)
    expect(sendMeasurementIdMock).toHaveBeenCalledWith('meas-1')
    wrapper.unmount()
  })

  it('結果が出ると、測定の完了の保存で点呼の段を進める (Refs ippoan/rust-alc-api#680)', async () => {
    const { startMeasurement, updateMeasurement } = await import('~/utils/api')
    vi.mocked(startMeasurement).mockResolvedValue({ id: 'meas-1' } as never)

    const wrapper = await mountKiosk()
    step.value = 'alcohol'
    await flushPromises()

    emitResult(wrapper)
    await flushPromises()

    // 保存は onAlcoholMeasured が tenko_session_id を足して 1 回で行う (component は直接 PUT しない)
    expect(updateMeasurement).not.toHaveBeenCalled()
    expect(onAlcoholMeasuredMock).toHaveBeenCalledTimes(1)
    const [id, body] = onAlcoholMeasuredMock.mock.calls[0]! as unknown as [string, Record<string, unknown>]
    expect(id).toBe('meas-1')
    expect(body).toMatchObject({
      status: 'completed',
      alcohol_value: 0.0,
      result_type: 'normal',
      device_use_count: 7,
      tenko_type: 'pre_operation',
    })
    wrapper.unmount()
  })

  it('★ 完了の保存に record_as_tenko を載せない (CSV に点呼が二重に出る)', async () => {
    const { startMeasurement } = await import('~/utils/api')
    vi.mocked(startMeasurement).mockResolvedValue({ id: 'meas-1' } as never)

    const wrapper = await mountKiosk()
    step.value = 'alcohol'
    await flushPromises()
    emitResult(wrapper)
    await flushPromises()

    const body = (onAlcoholMeasuredMock.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]
    expect(body).not.toHaveProperty('record_as_tenko')
    wrapper.unmount()
  })

  it('段に入ったときに測定レコードが作れなかったら、結果の時に作り直す。作れなければ段は進めない', async () => {
    const { startMeasurement } = await import('~/utils/api')
    vi.mocked(startMeasurement).mockRejectedValue(new Error('403'))

    const wrapper = await mountKiosk()
    step.value = 'alcohol'
    await flushPromises()
    emitResult(wrapper)
    await flushPromises()

    expect(startMeasurement).toHaveBeenCalledTimes(2)
    expect(onAlcoholMeasuredMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('測り直しが要るときは新しい測定レコードを作る', async () => {
    const { startMeasurement } = await import('~/utils/api')
    vi.mocked(startMeasurement)
      .mockResolvedValueOnce({ id: 'meas-1' } as never)
      .mockResolvedValueOnce({ id: 'meas-2' } as never)
    onAlcoholMeasuredMock.mockResolvedValueOnce(true)

    const wrapper = await mountKiosk()
    step.value = 'alcohol'
    await flushPromises()
    emitResult(wrapper)
    await flushPromises()

    expect(startMeasurement).toHaveBeenCalledTimes(2)
    emitResult(wrapper)
    await flushPromises()
    expect((onAlcoholMeasuredMock.mock.calls[1] as unknown as [string])[0]).toBe('meas-2')
    wrapper.unmount()
  })

  it('セッションに測定があれば開始の時点で CoreS3 に渡し、最初のアルコールはその測定に保存する。測り直しは新しい測定で', async () => {
    const { startMeasurement } = await import('~/utils/api')
    vi.mocked(startMeasurement).mockResolvedValue({ id: 'meas-2' } as never)
    onAlcoholMeasuredMock.mockResolvedValueOnce(true)

    const wrapper = await mountKiosk()
    session.value = { id: 'sess-1', measurement_id: 'meas-s' }
    await flushPromises()
    // 体温・血圧の段より前に渡す (端末の記録に載る)
    expect(sendMeasurementIdMock).toHaveBeenCalledWith('meas-s')

    step.value = 'alcohol'
    await flushPromises()
    expect(startMeasurement).not.toHaveBeenCalled()
    emitResult(wrapper)
    await flushPromises()
    expect((onAlcoholMeasuredMock.mock.calls[0] as unknown as [string])[0]).toBe('meas-s')

    // 測り直しはセッションの測定を使い直さない
    expect(startMeasurement).toHaveBeenCalledTimes(1)
    emitResult(wrapper)
    await flushPromises()
    expect((onAlcoholMeasuredMock.mock.calls[1] as unknown as [string])[0]).toBe('meas-2')
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

describe('TenkoKiosk — 遠隔点呼が閉じたら通話の部屋から出る', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    step.value = 'medical'
    isRemote.value = true
  })
  afterEach(() => {
    isRemote.value = false
  })

  it.each(['completed', 'cancelled'] as const)('★ %s になったら部屋から出て、通話の枠も出さない', async (end) => {
    const wrapper = await mountKiosk()
    expect(webRtcDisconnectMock).not.toHaveBeenCalled()
    step.value = end
    await flushPromises()
    expect(webRtcDisconnectMock).toHaveBeenCalled()
    expect(wrapper.findComponent({ name: 'TenkoVideoCall' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('遠隔でなければ何もしない', async () => {
    isRemote.value = false
    const wrapper = await mountKiosk()
    step.value = 'completed'
    await flushPromises()
    expect(webRtcDisconnectMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('TenkoKiosk — 遠隔点呼の判定待ち', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isRemote.value = true
    isPeerConnected.value = false
    session.value = { id: 'sess-1', status: 'judgment_pending' }
  })
  beforeEach(async () => {
    const { getTenkoSession } = await import('~/utils/api')
    vi.mocked(getTenkoSession).mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    isRemote.value = false
    session.value = null
  })

  it('★ 判定待ちの間は部屋に残って通話の枠を出し、取り直して判定が入ったら部屋から出る', async () => {
    vi.useFakeTimers()
    const { getTenkoSession } = await import('~/utils/api')
    vi.mocked(getTenkoSession)
      .mockResolvedValueOnce({ id: 'sess-1', status: 'judgment_pending' } as never)
      .mockResolvedValueOnce({ id: 'sess-1', status: 'completed' } as never)
    step.value = 'medical'
    const wrapper = await mountKiosk()
    step.value = 'completed'
    await flushPromises()
    expect(webRtcDisconnectMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5000)
    expect(getTenkoSession).toHaveBeenCalledWith('sess-1')
    expect(webRtcDisconnectMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(session.value?.status).toBe('completed')
    expect(webRtcDisconnectMock).toHaveBeenCalled()
    // 閉じたら取り直しも止まる
    await vi.advanceTimersByTimeAsync(15000)
    expect(getTenkoSession).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('★ 遠隔点呼の判定待ちは、運行管理者が通話に出るまで 30 秒を過ぎても最初の画面に戻らない (Refs #676)', async () => {
    vi.useFakeTimers()
    const { getTenkoSession } = await import('~/utils/api')
    vi.mocked(getTenkoSession).mockResolvedValue({ id: 'sess-1', status: 'judgment_pending' } as never)
    step.value = 'completed'
    const wrapper = await mountKiosk()
    try {
      await flushPromises()
      expect(wrapper.findComponent({ name: 'TenkoCompleted' }).props('autoResetSeconds')).toBeNull()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(resetMock).not.toHaveBeenCalled()
      expect(wrapper.findComponent({ name: 'TenkoCompleted' }).props('autoResetSeconds')).toBeNull()
      // 待てないときは「運行管理者が出ないので点呼をやめる」で抜けられる
      expect(wrapper.find('[data-testid="cancel-no-manager"]').exists()).toBe(true)
      expect(webRtcDisconnectMock).not.toHaveBeenCalled()
    }
    finally {
      wrapper.unmount()
      step.value = 'nfc'
    }
  })

  it('★ 遠隔点呼でない判定待ちは今までどおり 30 秒で次の点呼へ移る。運行管理者が通話に出ている間は数えない', async () => {
    vi.useFakeTimers()
    isRemote.value = false
    const { getTenkoSession } = await import('~/utils/api')
    vi.mocked(getTenkoSession).mockResolvedValue({ id: 'sess-1', status: 'judgment_pending' } as never)
    step.value = 'completed'
    const wrapper = await mountKiosk()
    const left = () => wrapper.findComponent({ name: 'TenkoCompleted' }).props('autoResetSeconds')
    try {
      await flushPromises()
      expect(left()).toBe(30)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(left()).toBe(20)
      // 通話に出たら止める
      isPeerConnected.value = true
      await flushPromises()
      expect(left()).toBeNull()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(resetMock).not.toHaveBeenCalled()
      // 通話が切れたら数え直す
      isPeerConnected.value = false
      await flushPromises()
      expect(left()).toBe(30)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(resetMock).toHaveBeenCalledTimes(1)
    }
    finally {
      wrapper.unmount()
      step.value = 'nfc'
    }
  })

  it('★ 血圧の記録不足で対面点呼にした判定待ちは 30 秒で戻らず、判定の取り直しを続け、判定で閉じたら 30 秒数える', async () => {
    vi.useFakeTimers()
    const { getTenkoSession } = await import('~/utils/api')
    const inPerson = {
      id: 'sess-1', status: 'judgment_pending', schedule_id: 's-1', tenko_type: 'pre_operation', tenko_method: '通常点呼',
      remote_escalation_reason: '血圧の記録が 10 日分に満たない (いま 3 日分) ため対面点呼',
    }
    session.value = inPerson
    vi.mocked(getTenkoSession)
      .mockResolvedValueOnce(inPerson as never)
      .mockResolvedValue({ ...inPerson, status: 'completed' } as never)
    step.value = 'completed'
    const wrapper = await mountKiosk()
    const left = () => wrapper.findComponent({ name: 'TenkoCompleted' }).props('autoResetSeconds')
    try {
      await flushPromises()
      expect(left()).toBeNull()
      // 判定が入るまでは戻らない (取り直しは続く)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(left()).toBeNull()
      expect(resetMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(session.value?.status).toBe('judgment_pending')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(session.value?.status).toBe('completed')
      await vi.advanceTimersByTimeAsync(15_000)
      expect(resetMock).not.toHaveBeenCalled()
      expect(left()).toBe(15)
    }
    finally {
      wrapper.unmount()
      step.value = 'nfc'
    }
  })

  it('遠隔点呼でない判定待ちでも、血圧の記録不足で対面点呼にした点呼は 30 秒で戻らない', async () => {
    vi.useFakeTimers()
    isRemote.value = false
    const inPerson = {
      id: 'sess-1', status: 'judgment_pending', schedule_id: 's-1', tenko_type: 'pre_operation', tenko_method: '通常点呼',
      remote_escalation_reason: '血圧の記録が 10 日分に満たない (いま 3 日分) ため対面点呼',
    }
    session.value = inPerson
    const { getTenkoSession } = await import('~/utils/api')
    vi.mocked(getTenkoSession).mockResolvedValue(inPerson as never)
    step.value = 'completed'
    const wrapper = await mountKiosk()
    try {
      await flushPromises()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(wrapper.findComponent({ name: 'TenkoCompleted' }).props('autoResetSeconds')).toBeNull()
      expect(resetMock).not.toHaveBeenCalled()
    }
    finally {
      wrapper.unmount()
      step.value = 'nfc'
    }
  })

  it('★ 判定で閉じたら完了の画面で 30 秒数え、次の点呼へ移る。最初の画面に戻ったら数えない', async () => {
    vi.useFakeTimers()
    // 通話中の判定待ちは数えない (判定が入ってから数え始めることを見る)
    isPeerConnected.value = true
    step.value = 'completed'
    const wrapper = await mountKiosk()
    const left = () => wrapper.findComponent({ name: 'TenkoCompleted' }).props('autoResetSeconds')
    try {
      expect(left()).toBeNull()
      session.value = { id: 'sess-1', status: 'completed' }
      await flushPromises()
      expect(left()).toBe(30)
      await vi.advanceTimersByTimeAsync(29_000)
      expect(left()).toBe(1)
      expect(resetMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(resetMock).toHaveBeenCalledTimes(1)
      step.value = 'nfc'
      await flushPromises()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(resetMock).toHaveBeenCalledTimes(1)
    }
    finally {
      wrapper.unmount()
      step.value = 'nfc'
    }
  })

  it('遠隔でない点呼の完了の画面は数えない', async () => {
    vi.useFakeTimers()
    isRemote.value = false
    session.value = { id: 'sess-1', status: 'completed' }
    step.value = 'completed'
    const wrapper = await mountKiosk()
    try {
      await vi.advanceTimersByTimeAsync(60_000)
      expect(wrapper.findComponent({ name: 'TenkoCompleted' }).props('autoResetSeconds')).toBeNull()
      expect(resetMock).not.toHaveBeenCalled()
    }
    finally {
      wrapper.unmount()
      step.value = 'nfc'
    }
  })

  it('取り直しに失敗しても待ち続ける', async () => {
    vi.useFakeTimers()
    const { getTenkoSession } = await import('~/utils/api')
    vi.mocked(getTenkoSession).mockRejectedValue(new Error('offline'))
    step.value = 'completed'
    const wrapper = await mountKiosk()
    await vi.advanceTimersByTimeAsync(10000)
    expect(getTenkoSession).toHaveBeenCalledTimes(2)
    expect(session.value?.status).toBe('judgment_pending')
    expect(webRtcDisconnectMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it.each([
    ['instruction', 'TenkoInstruction', 'confirm', onInstructionConfirmMock],
    ['report', 'TenkoOperationReport', 'submit', onReportSubmitMock],
  ] as const)('★ %s: 通話がつながっていなくても乗務員は確定できる (確定してから運行管理者を呼ぶ)', async (s, name, ev, handler) => {
    session.value = { id: 'sess-1', status: 'instruction_pending' }
    step.value = s
    const wrapper = await mountKiosk()
    wrapper.findComponent({ name }).vm.$emit(ev, {})
    await flushPromises()
    expect(handler).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

describe('TenkoKiosk — 運行管理者が出ないとき乗務員が点呼をやめる', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    isRemote.value = true
    isPeerConnected.value = false
    kioskError.value = null
    session.value = { id: 'sess-1', status: 'judgment_pending' }
    step.value = 'completed'
    const { cancelTenkoSession } = await import('~/utils/api')
    vi.mocked(cancelTenkoSession).mockReset()
  })
  afterEach(() => {
    isRemote.value = false
    session.value = null
  })

  it('★ 運行管理者を呼んでいる間 (判定待ち・通話なし) だけ出し、押すと理由付きで取り消して最初の画面へ戻す', async () => {
    const { cancelTenkoSession } = await import('~/utils/api')
    vi.mocked(cancelTenkoSession).mockResolvedValue({ id: 'sess-1', status: 'cancelled' } as never)
    const wrapper = await mountKiosk()
    await wrapper.find('[data-testid="cancel-no-manager"]').trigger('click')
    await flushPromises()
    expect(cancelTenkoSession).toHaveBeenCalledWith('sess-1', { reason: '運行管理者が通話に出なかったため乗務員が中止' })
    expect(resetMock).toHaveBeenCalled()

    // 通話がつながっている間は出さない
    isPeerConnected.value = true
    await flushPromises()
    expect(wrapper.find('[data-testid="cancel-no-manager"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('取り消せなければ理由を出し、最初の画面へは戻さない', async () => {
    const { cancelTenkoSession } = await import('~/utils/api')
    vi.mocked(cancelTenkoSession).mockRejectedValue(new Error('400'))
    const wrapper = await mountKiosk()
    await wrapper.find('[data-testid="cancel-no-manager"]').trigger('click')
    await flushPromises()
    expect(resetMock).not.toHaveBeenCalled()
    expect(kioskError.value).toBe('点呼をやめられませんでした。もう一度押してください')
    wrapper.unmount()
  })
})

describe('TenkoKiosk — 最初から遠隔点呼は確定の後に部屋に入って運行管理者を呼ぶ', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isRemote.value = true
    isPeerConnected.value = false
    session.value = { id: 'sess-1', status: 'instruction_pending' }
  })
  afterEach(() => {
    isRemote.value = false
    session.value = null
  })

  it('★ 自己申告・指示確認・運行報告の間は入らず、判定待ちになったら入る', async () => {
    step.value = 'self_declaration'
    const wrapper = await mountKiosk()
    for (const s of ['instruction', 'report'] as const) {
      step.value = s
      await flushPromises()
    }
    expect(webRtcConnectMock).not.toHaveBeenCalled()
    session.value = { id: 'sess-1', status: 'judgment_pending' }
    step.value = 'completed'
    await flushPromises()
    expect(webRtcConnectMock).toHaveBeenCalledWith(expect.any(String), 'sess-1', 'room', undefined)
    expect(webRtcDisconnectMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

// 車両番号の段 (業務前 二十 ハ)
describe('TenkoKiosk — 車両番号の段', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    step.value = 'vehicle'
    vehicleInput.value = '予定の車'
    vehicleManualRequired.value = false
  })

  it('★ 車両番号の段で TenkoVehicleEntry を出し、入力欄の値と車検証で決まらなかった印を渡す', async () => {
    vehicleManualRequired.value = true
    const wrapper = await mountKiosk()
    await wrapper.vm.$nextTick()

    const entry = wrapper.findComponent({ name: 'TenkoVehicleEntry' })
    expect(entry.exists()).toBe(true)
    expect(entry.props('modelValue')).toBe('予定の車')
    expect(entry.props('manualRequired')).toBe(true)
    wrapper.unmount()
  })

  it('入力欄の更新は composable の値へ、submit は onVehicleSubmit へ渡す', async () => {
    const wrapper = await mountKiosk()
    const entry = wrapper.findComponent({ name: 'TenkoVehicleEntry' })

    entry.vm.$emit('update:modelValue', '手入力')
    await wrapper.vm.$nextTick()
    expect(vehicleInput.value).toBe('手入力')

    entry.vm.$emit('submit', { carins_cert_no: 'CERT-1' })
    expect(onVehicleSubmitMock).toHaveBeenCalledWith({ carins_cert_no: 'CERT-1' })
    wrapper.unmount()
  })

  it('車両番号の段は CoreS3 の車検証の段(CARINS)に連動する', async () => {
    const wrapper = await mountKiosk()
    expect(syncStepMock.mock.calls.map(stepArgOf)).toContain('vehicle')
    wrapper.unmount()
  })
})

// 故障の自動記録: 機器の接続・読取の失敗 / 記録・写真の保存の失敗 / 通信の失敗 (利用者の誤りは記録しない)
describe('TenkoKiosk — 故障の自動記録の配線', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    step.value = 'nfc'
    employeeId.value = 'emp-1'
    tenkoType.value = 'pre_operation'
    session.value = { id: 'sess-1' }
    bleError.value = null
    cameraStartMock.mockResolvedValue(undefined)
    stopRecordingMock.mockResolvedValue(null)
  })

  it('★ FC-1200 のエラー(AlcMeasurement の error)→ measurement_recording_failed', async () => {
    const wrapper = await mountKiosk()
    step.value = 'alcohol'
    await flushPromises()

    wrapper.findComponent({ name: 'AlcMeasurement' }).vm.$emit('error', 'FC-1200 が接続されていません')
    expect(failureReport.reportFailure).toHaveBeenCalledWith(expect.objectContaining({
      type: 'measurement_recording_failed', device: 'FC-1200', sessionId: 'sess-1',
    }))
    wrapper.unmount()
  })

  it('★ 録画カメラを起こせない → photo_storage_error。起きれば記録しない', async () => {
    const wrapper = await mountKiosk()
    step.value = 'alcohol'
    await flushPromises()
    expect(failureReport.reportFailure).not.toHaveBeenCalled()
    wrapper.unmount()

    cameraStartMock.mockRejectedValueOnce(new Error('NotAllowedError'))
    const wrapper2 = await mountKiosk()
    step.value = 'nfc'
    await wrapper2.vm.$nextTick()
    step.value = 'alcohol'
    await flushPromises()
    expect(failureReport.reportFailure).toHaveBeenCalledWith(expect.objectContaining({
      type: 'photo_storage_error', device: 'カメラ', sessionId: 'sess-1',
    }))
    wrapper2.unmount()
  })

  it('★ 測定レコードを作れない(通信・サーバー)→ measurement_recording_failed として reportApiFailure に渡す', async () => {
    const { startMeasurement } = await import('~/utils/api')
    const down = new Error('Failed to fetch')
    vi.mocked(startMeasurement).mockRejectedValue(down)
    const wrapper = await mountKiosk()
    step.value = 'alcohol'
    await flushPromises()

    expect(failureReport.reportApiFailure).toHaveBeenCalledWith(
      down, 'アルコール測定の記録の作成', { sessionId: 'sess-1', type: 'measurement_recording_failed' },
    )
    wrapper.unmount()
  })

  it('★ 録画のアップロードに失敗 → photo_storage_error', async () => {
    const { startMeasurement } = await import('~/utils/api')
    vi.mocked(startMeasurement).mockResolvedValue({ id: 'meas-1' } as never)
    stopRecordingMock.mockResolvedValue(new Blob(['x']))
    // 録画の blob は有るが R2 への送信は実 API 無しで失敗する (uploadStatus が 'failed' になる)

    const wrapper = await mountKiosk()
    step.value = 'alcohol'
    await flushPromises()
    wrapper.findComponent({ name: 'AlcMeasurement' }).vm.$emit('result', {
      employeeId: 'emp-1', alcoholValue: 0, resultType: 'normal', deviceUseCount: 1, measuredAt: new Date('2026-09-18T08:00:00Z'),
    })
    await flushPromises()

    expect(failureReport.reportFailure).toHaveBeenCalledWith(expect.objectContaining({
      type: 'photo_storage_error', description: '吹きかけ録画のアップロードに失敗しました',
    }))
    wrapper.unmount()
  })

  it('★ 体温計・血圧計の接続エラーは体温・血圧の段にいるときだけ measurement_recording_failed', async () => {
    const wrapper = await mountKiosk()

    // 他の段で出たエラー・エラーの解消は記録しない
    bleError.value = 'BLE ブリッジに接続できません'
    await wrapper.vm.$nextTick()
    bleError.value = null
    await wrapper.vm.$nextTick()
    expect(failureReport.reportFailure).not.toHaveBeenCalled()

    step.value = 'medical'
    await wrapper.vm.$nextTick()
    bleError.value = 'BLE ブリッジとの接続でエラーが発生しました'
    await wrapper.vm.$nextTick()
    expect(failureReport.reportFailure).toHaveBeenCalledWith(expect.objectContaining({
      type: 'measurement_recording_failed', device: '体温計・血圧計', sessionId: 'sess-1',
    }))
    wrapper.unmount()
  })

  it('★ 乗務員の照会が通信で落ちたら reportApiFailure に渡す(NFC・手入力の両方)', async () => {
    const { getEmployeeByNfcId, getEmployeeByCode } = await import('~/utils/api')
    const down = new Error('Failed to fetch')
    vi.mocked(getEmployeeByNfcId).mockRejectedValue(down)
    vi.mocked(getEmployeeByCode).mockRejectedValue(down)

    const wrapper = await mountKiosk()
    wrapper.findComponent({ name: 'NfcStatus' }).vm.$emit('read', 'nfc-test-1')
    await flushPromises()
    expect(failureReport.reportApiFailure).toHaveBeenCalledWith(down, '乗務員の照会')

    failureReport.reportApiFailure.mockClear()
    await wrapper.find('button.underline').trigger('click')
    await wrapper.find('input[type="text"]').setValue('001')
    await wrapper.findAll('button').find(b => b.text() === '次へ')!.trigger('click')
    await flushPromises()
    expect(failureReport.reportApiFailure).toHaveBeenCalledWith(down, '乗務員の照会')
    wrapper.unmount()
  })
})
