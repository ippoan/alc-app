import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import TenkoKiosk from '~/components/TenkoKiosk.vue'
import type { TenkoStep } from '~/composables/useTenkoKiosk'
import type { ApiEmployee } from '~/types'
import { VEIN_NO_MATCH_MESSAGE, VEIN_OFFLINE_STALE_MESSAGE } from '~/utils/vein-identify'

// キオスクの「指静脈で本人確認」(Refs ippoan/vein-match#20)。NFC・社員番号と並ぶ 3 つ目の手段で、
// 当たったら NFC と同じく applyFaceApproval → identifyEmployee に合流する。
// オンライン/オフラインの振り分けは実物の vein-identify を通し、その先 (API・IndexedDB・wasm) を差し替える

const api = vi.hoisted(() => ({
  identifyVein: vi.fn(),
  getEmployeeById: vi.fn(),
  getEmployees: vi.fn(),
  getVeinTemplates: vi.fn(),
}))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
  startMeasurement: vi.fn(),
  updateMeasurement: vi.fn(),
}))

const db = vi.hoisted(() => ({
  loadVeinTemplates: vi.fn(),
  saveVeinTemplates: vi.fn(),
}))
vi.mock('~/utils/vein-db', () => db)

const match = vi.hoisted(() => ({
  loadVeinWasm: vi.fn(),
  matchVeinOffline: vi.fn(),
}))
vi.mock('~/utils/vein-match', () => match)

const vein = vi.hoisted(() => ({
  isSupported: true,
  isConnected: null as unknown as { value: boolean },
  connect: vi.fn(),
  say: vi.fn(),
  capture: vi.fn(),
}))
mockNuxtImport('useVeinSerial', () => () => vein)

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

const EMP = { id: 'emp-1', name: '山田 太郎', face_approval_status: 'approved' } as ApiEmployee

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true })
}

async function mountKiosk() {
  const wrapper = await mountSuspended(TenkoKiosk, { shallow: true })
  await flushPromises()
  return wrapper
}

async function pressVein(wrapper: Awaited<ReturnType<typeof mountKiosk>>) {
  await wrapper.find('[data-testid="vein-identify"]').trigger('click')
  await flushPromises()
}

describe('TenkoKiosk — 指静脈で本人確認 (Refs ippoan/vein-match#20)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    step.value = 'nfc'
    error.value = null
    setOnline(true)
    vein.isSupported = true
    vein.isConnected = ref(true)
    vein.connect.mockResolvedValue(true)
    vein.say.mockResolvedValue(undefined)
    vein.capture.mockResolvedValue('BDBD01')
    api.getVeinTemplates.mockResolvedValue({ logic_version: '0.1.1', templates: [] })
    db.saveVeinTemplates.mockResolvedValue(undefined)
    db.loadVeinTemplates.mockResolvedValue({ logicVersion: '0.1.1', fetchedAt: 1, templates: [] })
    match.loadVeinWasm.mockResolvedValue(undefined)
  })

  afterEach(() => setOnline(true))

  it('起動時に端末へ接続し、照合データを同期する', async () => {
    const wrapper = await mountKiosk()
    expect(vein.connect).toHaveBeenCalled()
    expect(api.getVeinTemplates).toHaveBeenCalled()
    expect(db.saveVeinTemplates).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('オンラインで当たり → 案内してから読み取り、NFC と同じく identifyEmployee へ合流する', async () => {
    api.identifyVein.mockResolvedValue({ employee_id: 'emp-1', name: '山田 太郎' })
    api.getEmployeeById.mockResolvedValue(EMP)
    const wrapper = await mountKiosk()
    await pressVein(wrapper)

    expect(vein.say).toHaveBeenCalledWith('PLACE')
    expect(api.identifyVein).toHaveBeenCalledWith('BDBD01')
    expect(identifyEmployeeMock).toHaveBeenCalledWith('emp-1', '山田 太郎')
    expect(vein.say).not.toHaveBeenCalledWith('FAILED')
    expect(wrapper.find('[data-testid="vein-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('外れ → FAILED を鳴らし、画面に理由を出す (NFC・社員番号はそのまま使える)', async () => {
    api.identifyVein.mockResolvedValue({ employee_id: null })
    const wrapper = await mountKiosk()
    await pressVein(wrapper)

    expect(identifyEmployeeMock).not.toHaveBeenCalled()
    expect(vein.say).toHaveBeenCalledWith('FAILED')
    expect(wrapper.find('[data-testid="vein-error"]').text()).toBe(VEIN_NO_MATCH_MESSAGE)
    expect(wrapper.findComponent({ name: 'NfcStatus' }).exists()).toBe(true)
    wrapper.unmount()
  })

  it('422 → サーバーの理由を出す', async () => {
    api.identifyVein.mockRejectedValue(new Error('API エラー (422): {"error":"unsupported_chara_format","message":"特徴量の形式が違います"}'))
    const wrapper = await mountKiosk()
    await pressVein(wrapper)

    expect(wrapper.find('[data-testid="vein-error"]').text()).toBe('特徴量の形式が違います')
    expect(vein.say).toHaveBeenCalledWith('FAILED')
    wrapper.unmount()
  })

  it('オフラインで当たり → wasm で照合し、社員一覧から引いて identifyEmployee へ', async () => {
    setOnline(false)
    match.matchVeinOffline.mockResolvedValue({ kind: 'hit', employeeId: 'emp-1' })
    api.getEmployees.mockResolvedValue([EMP])
    const wrapper = await mountKiosk()
    await pressVein(wrapper)

    expect(api.identifyVein).not.toHaveBeenCalled()
    expect(match.matchVeinOffline).toHaveBeenCalledWith('BDBD01', expect.objectContaining({ logicVersion: '0.1.1' }))
    expect(identifyEmployeeMock).toHaveBeenCalledWith('emp-1', '山田 太郎')
    wrapper.unmount()
  })

  it('★ 版の不一致 → オフラインの照合を止め、同期を促す', async () => {
    setOnline(false)
    match.matchVeinOffline.mockResolvedValue({ kind: 'version_mismatch', stored: '0.1.0', wasm: '0.1.1' })
    const wrapper = await mountKiosk()
    await pressVein(wrapper)

    expect(identifyEmployeeMock).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="vein-error"]').text()).toBe(VEIN_OFFLINE_STALE_MESSAGE)
    expect(vein.say).toHaveBeenCalledWith('FAILED')
    wrapper.unmount()
  })

  it('読み取りに失敗 → 理由を出す。FAILED の案内が失敗しても画面の理由は残る', async () => {
    vein.capture.mockRejectedValue(new Error('NO_FINGER'))
    vein.say.mockImplementation(async (x: string) => { if (x === 'FAILED') throw new Error('unsupported') })
    const wrapper = await mountKiosk()
    await pressVein(wrapper)

    expect(api.identifyVein).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="vein-error"]').text()).toBe('指静脈を読み取れませんでした (NO_FINGER)')
    expect(wrapper.find('[data-testid="vein-identify"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('端末が無い → ボタンを押せず、理由を出す', async () => {
    vein.isConnected = ref(false)
    const wrapper = await mountKiosk()
    const button = wrapper.find('[data-testid="vein-identify"]')
    expect(button.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Vein Station (指静脈読み取り端末) が接続されていません')
    await button.trigger('click')
    await flushPromises()
    expect(vein.capture).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('WebSerial が無い端末には出さない', async () => {
    vein.isSupported = false
    const wrapper = await mountKiosk()
    expect(wrapper.find('[data-testid="vein-identify"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('顔の承認で止まる社員 → NFC と同じくグローバルエラーに出し、identifyEmployee へ進まない', async () => {
    api.identifyVein.mockResolvedValue({ employee_id: 'emp-1', name: '山田 太郎' })
    api.getEmployeeById.mockResolvedValue({ ...EMP, face_approval_status: 'rejected' })
    const wrapper = await mountKiosk()
    await pressVein(wrapper)

    expect(identifyEmployeeMock).not.toHaveBeenCalled()
    expect(error.value).toBeTruthy()
    expect(wrapper.find('[data-testid="vein-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('最初の画面に戻ったとき、前回の同期から間が無ければ取り直さない', async () => {
    const wrapper = await mountKiosk()
    const calls = api.getVeinTemplates.mock.calls.length
    step.value = 'face_auth'
    await flushPromises()
    step.value = 'nfc'
    await flushPromises()
    expect(api.getVeinTemplates.mock.calls.length).toBe(calls)
    wrapper.unmount()
  })
})
