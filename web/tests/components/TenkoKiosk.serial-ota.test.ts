import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import TenkoKiosk from '~/components/TenkoKiosk.vue'
import type { TenkoStep } from '~/composables/useTenkoKiosk'
import type { SerialOtaState } from '~/composables/useSerialOta'
import type { TimecardWatchOptions } from '~/composables/useTimecardWatch'

// キオスクが購読 WS の合図で USB の端末をシリアル OTA する (Refs ippoan/alc-app-s3#279)。
// 実行は待機画面 (NFC 待ち) のときだけ。途中で受けた合図は預け、待機画面へ戻ったときに走らせる。
// OTA の中身 (契約・allowlist) は useSerialOta のテストで見るので、ここは配線だけを見る

vi.mock('~/utils/vein-identify', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/vein-identify')>()),
  syncVeinTemplates: vi.fn(async () => {}),
}))

const vein = vi.hoisted(() => ({
  isSupported: false,
  isConnected: { value: false },
  connect: vi.fn(async () => false),
  say: vi.fn(),
  capture: vi.fn(),
  request: vi.fn(),
}))
mockNuxtImport('useVeinSerial', () => () => vein)

const ota = vi.hoisted(() => ({
  state: null as unknown as { value: SerialOtaState },
  run: vi.fn(),
  enqueue: vi.fn(),
  runQueued: vi.fn(async () => {}),
}))
mockNuxtImport('useSerialOta', () => () => ota)

const watchMock = vi.hoisted(() => ({
  options: null as TimecardWatchOptions | null,
  connect: vi.fn(async () => {}),
  stop: vi.fn(),
}))
mockNuxtImport('useTimecardWatch', () => (options: TimecardWatchOptions) => {
  watchMock.options = options
  return { isConnected: { value: false }, connect: watchMock.connect, stop: watchMock.stop }
})

const getDeviceJwt = vi.hoisted(() => vi.fn(async () => 'device-jwt'))
mockNuxtImport('useDeviceToken', () => () => ({ getDeviceJwt }))

const step = ref<TenkoStep>('nfc')
const error = ref<string | null>(null)
const identifyEmployeeMock = vi.fn(async () => {})

mockNuxtImport('useTenkoKiosk', () => () => ({
  step,
  employeeId: ref(''),
  employeeName: ref(''),
  pendingSchedules: ref([]),
  resumableSessions: ref([]),
  selectedSchedule: ref(null),
  selectedTenkoType: ref(null),
  session: ref(null),
  error,
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
  bpRequirementUnknown: ref(false),
  retryBpRequirement: vi.fn(),
  identifyEmployee: identifyEmployeeMock,
  selectSchedule: vi.fn(async () => {}),
  resumeSession: vi.fn(),
  proceedWithoutSchedule: vi.fn(),
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
  stream: ref(null), videoRef: ref(null), isActive: ref(false), start: vi.fn(async () => {}), stop: vi.fn(),
}))
mockNuxtImport('useVideoRecorder', () => () => ({
  isRecording: ref(false), recordedBlob: ref(null), error: ref(null), startRecording: vi.fn(), stopRecording: vi.fn(async () => null),
}))
mockNuxtImport('useBleGateway', () => () => ({ latestTemperature: ref(null), latestBloodPressure: ref(null) }))
mockNuxtImport('useBpUiEnabled', () => () => ({ bpUiState: ref('unused'), showBpUi: ref(false) }))
mockNuxtImport('useFingerprint', () => () => ({
  isFingerprintAvailable: ref(false), isEmployeeAuthorized: vi.fn(() => false), authorizeEmployee: vi.fn(), requestFingerprint: vi.fn(),
}))
mockNuxtImport('useCoreS3Stage', () => () => ({ syncStep: vi.fn(), sendResult: vi.fn() }))

async function mountKiosk(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(TenkoKiosk, { shallow: true, props })
  await flushPromises()
  return wrapper
}

const overlay = (wrapper: Awaited<ReturnType<typeof mountKiosk>>) => wrapper.find('[data-testid="serial-ota-overlay"]')

describe('TenkoKiosk — 端末のシリアル OTA (Refs ippoan/alc-app-s3#279)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    step.value = 'nfc'
    error.value = null
    ota.state = ref<SerialOtaState>({ kind: 'idle' })
    watchMock.options = null
  })

  it('購読 WS を 1 本張る (打刻の引き直しは渡さない / トークンは device JWT)', async () => {
    const wrapper = await mountKiosk()
    expect(watchMock.connect).toHaveBeenCalledTimes(1)
    expect(watchMock.options!.onChange).toBeUndefined()
    expect(watchMock.options!.onSerialOta).toBeTypeOf('function')
    await expect(Promise.resolve(watchMock.options!.getToken())).resolves.toBe('device-jwt')
    expect(getDeviceJwt).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('デモモードでは購読しない (実機が無い)', async () => {
    const wrapper = await mountKiosk({ demoMode: true })
    expect(watchMock.connect).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('待機画面で合図を受けたら、その場で走らせる', async () => {
    const wrapper = await mountKiosk()
    watchMock.options!.onSerialOta!('timecard-station')
    expect(ota.enqueue).toHaveBeenCalledWith('timecard-station')
    expect(ota.runQueued).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('点呼の途中で受けた合図は預け、待機画面へ戻ったときに走らせる', async () => {
    step.value = 'alcohol'
    const wrapper = await mountKiosk()
    watchMock.options!.onSerialOta!('timecard-station')
    expect(ota.enqueue).toHaveBeenCalledWith('timecard-station')
    expect(ota.runQueued).not.toHaveBeenCalled()

    step.value = 'medical'
    await flushPromises()
    expect(ota.runQueued).not.toHaveBeenCalled()

    step.value = 'nfc'
    await flushPromises()
    expect(ota.runQueued).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it.each([
    [{ kind: 'downloading' }, '端末を更新しています 0%'],
    [{ kind: 'writing', pct: 42 }, '端末を更新しています 42%'],
    [{ kind: 'rebooting' }, '端末を再起動しています…'],
    [{ kind: 'confirming' }, '端末を再起動しています…'],
    [{ kind: 'done', ver: '0.2.0' }, '更新しました 0.2.0'],
    [{ kind: 'failed', reason: 'OTA ERR write' }, '更新できませんでした (元の版のまま)'],
  ] as Array<[SerialOtaState, string]>)('状態 %o は画面全体に「%s」と出す', async (state, text) => {
    const wrapper = await mountKiosk()
    expect(overlay(wrapper).exists()).toBe(false)

    ota.state.value = state
    await flushPromises()
    expect(overlay(wrapper).text()).toBe(text)

    ota.state.value = { kind: 'idle' }
    await flushPromises()
    expect(overlay(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })
})
