import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import TenkoKiosk from '~/components/TenkoKiosk.vue'
import type { TenkoStep } from '~/composables/useTenkoKiosk'
import type { ApiEmployee } from '~/types'
import { VEIN_NO_MATCH_MESSAGE, VEIN_OFFLINE_STALE_MESSAGE } from '~/utils/vein-identify'

// キオスクの「指静脈で本人確認」(Refs ippoan/vein-match#20)。NFC・社員番号と並ぶ 3 つ目の手段で、
// 当たったら identifyEmployee に合流し、指静脈を本人確認にして顔認証の段を飛ばす (顔の承認は見ない)。
// オンライン/オフラインの振り分けは実物の vein-identify を通し、その先 (API・IndexedDB・wasm) を差し替える

const api = vi.hoisted(() => ({
  identifyVein: vi.fn(),
  getEmployeeById: vi.fn(),
  getEmployees: vi.fn(),
  getVeinTemplates: vi.fn(),
  getEmployeeByNfcId: vi.fn(),
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
  loadVeinModuleEntries: vi.fn(),
}))
vi.mock('~/utils/vein-db', () => db)

const match = vi.hoisted(() => ({
  loadVeinWasm: vi.fn(),
  matchVeinOffline: vi.fn(),
}))
vi.mock('~/utils/vein-match', () => match)

// モジュール経路の判定 (usesVeinModule) だけ差し替える (対応表の引き方は本物を通す、Refs ippoan/alc-app#436)
const viaModule = vi.hoisted(() => ({ on: false }))
vi.mock('~/utils/vein-module', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/vein-module')>()),
  usesVeinModule: () => viaModule.on,
}))

// 指が置かれた合図 (EVT VEIN FINGER) の購読は、受けた cb を finger.cb で呼べるようにしておく
const finger = vi.hoisted(() => ({ cb: null as (() => void) | null, off: vi.fn() }))
const vein = vi.hoisted(() => ({
  isSupported: true,
  onFingerPlaced: vi.fn((cb: () => void) => { finger.cb = cb; return finger.off }),
  isConnected: null as unknown as { value: boolean },
  connect: vi.fn(),
  // 直近の照合結果 (キオスクは撮り直しの提案を出さないが、共通の照合手順が via を読む)
  lastMatch: { value: null },
  say: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  // useDeviceToken が抜線でキャッシュを捨てるために登録する (Refs ippoan/alc-app#436)
  onClose: vi.fn(),
  // useSerialOta が書き込みのポートとして掴む (Refs ippoan/alc-app#436)
  ota: { begin: vi.fn(), end: vi.fn(), request: vi.fn() },
}))
mockNuxtImport('useVeinSerial', () => () => vein)

const step = ref<TenkoStep>('nfc')
const error = ref<string | null>(null)
const identifyEmployeeMock = vi.fn(async () => {})
const onFaceAuthCompleteMock = vi.fn()

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
  onFaceAuthComplete: onFaceAuthCompleteMock,
  onAlcoholMeasured: vi.fn(async () => false),
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
mockNuxtImport('useCoreS3Stage', () => () => ({ syncStep: vi.fn(), sendResult: vi.fn(), sendMeasurementId: vi.fn() }))

const EMP = { id: 'emp-1', name: '山田 太郎', face_approval_status: 'approved' } as ApiEmployee

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true })
}

async function mountKiosk() {
  const wrapper = await mountSuspended(TenkoKiosk, { shallow: true })
  await flushPromises()
  return wrapper
}

async function mountRemoteKiosk() {
  const wrapper = await mountSuspended(TenkoKiosk, { shallow: true, props: { remoteMode: true } })
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
    viaModule.on = false
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

  it('★ 指静脈で当たったら顔の承認は見ない (顔認証の代わりに指静脈を本人確認にする)', async () => {
    api.identifyVein.mockResolvedValue({ employee_id: 'emp-1', name: '山田 太郎' })
    api.getEmployeeById.mockResolvedValue({ ...EMP, face_approval_status: 'rejected' })
    const wrapper = await mountKiosk()
    await pressVein(wrapper)

    expect(identifyEmployeeMock).toHaveBeenCalledWith('emp-1', '山田 太郎')
    expect(error.value).toBeNull()
    wrapper.unmount()
  })

  it('NFC で特定したときは今まで通り顔認証の段で止まる', async () => {
    api.identifyVein.mockResolvedValue({ employee_id: 'emp-1', name: '山田 太郎' })
    api.getEmployeeById.mockResolvedValue(EMP)
    const wrapper = await mountKiosk()
    await pressVein(wrapper)
    // 同じ画面で次の人が NFC で特定した (指静脈の印は消える)
    api.getEmployeeByNfcId.mockResolvedValue({ ...EMP, id: 'emp-2' })
    wrapper.findComponent({ name: 'NfcStatus' }).vm.$emit('read', 'nfc-1')
    await flushPromises()
    expect(api.getEmployeeByNfcId).toHaveBeenCalledWith('nfc-1')
    step.value = 'face_auth'
    await flushPromises()
    expect(onFaceAuthCompleteMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('★ 遠隔点呼は指静脈を本人確認にする — 顔の承認を見ず、顔認証の段を飛ばして始める', async () => {
    api.identifyVein.mockResolvedValue({ employee_id: 'emp-1', name: '山田 太郎' })
    api.getEmployeeById.mockResolvedValue({ ...EMP, face_approval_status: 'rejected' })
    // 遠隔点呼の identifyEmployee は顔認証の段へ進める
    identifyEmployeeMock.mockImplementationOnce(async () => { step.value = 'face_auth' })
    const wrapper = await mountRemoteKiosk()
    await pressVein(wrapper)

    expect(identifyEmployeeMock).toHaveBeenCalledWith('emp-1', '山田 太郎')
    expect(error.value).toBeNull()
    expect(onFaceAuthCompleteMock).toHaveBeenCalledWith({ verified: true, similarity: 0, skipped: true })
    wrapper.unmount()
  })

  it('★ 自動点呼も、予定を選んで顔認証の段に来たら飛ばす', async () => {
    api.identifyVein.mockResolvedValue({ employee_id: 'emp-1', name: '山田 太郎' })
    api.getEmployeeById.mockResolvedValue(EMP)
    identifyEmployeeMock.mockImplementationOnce(async () => { step.value = 'schedule_select' })
    const wrapper = await mountKiosk()
    await pressVein(wrapper)
    expect(onFaceAuthCompleteMock).not.toHaveBeenCalled()

    step.value = 'face_auth'
    await flushPromises()
    expect(onFaceAuthCompleteMock).toHaveBeenCalledWith({ verified: true, similarity: 0, skipped: true })
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

  // 指が置かれた合図 (EVT VEIN FINGER) で、ボタンと同じ照合を始める (Refs ippoan/alc-app#436)
  describe('指の合図で照合を始める', () => {
    beforeEach(() => {
      finger.cb = null
      finger.off.mockClear()
    })

    it('★ 待機中なら「指を置いて」を鳴らさず読み取り、identifyEmployee へ合流する', async () => {
      api.identifyVein.mockResolvedValue({ employee_id: 'emp-1', name: '山田 太郎' })
      api.getEmployeeById.mockResolvedValue(EMP)
      const wrapper = await mountKiosk()
      finger.cb!()
      await flushPromises()

      expect(vein.say).not.toHaveBeenCalledWith('PLACE')
      expect(vein.capture).toHaveBeenCalledTimes(1)
      expect(identifyEmployeeMock).toHaveBeenCalledWith('emp-1', '山田 太郎')
      wrapper.unmount()
    })

    it('外れはボタンからと同じ文言を出す', async () => {
      api.identifyVein.mockResolvedValue({ employee_id: null })
      const wrapper = await mountKiosk()
      finger.cb!()
      await flushPromises()

      expect(wrapper.find('[data-testid="vein-error"]').text()).toBe(VEIN_NO_MATCH_MESSAGE)
      expect(vein.say).toHaveBeenCalledWith('FAILED')
      wrapper.unmount()
    })

    it('待機画面でなければ始めない', async () => {
      const wrapper = await mountKiosk()
      step.value = 'face_auth'
      await flushPromises()
      finger.cb!()
      await flushPromises()

      expect(vein.capture).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('照合中は 2 回目を始めない', async () => {
      let captured!: (chara: string) => void
      vein.capture.mockImplementation(() => new Promise((resolve) => { captured = resolve }))
      api.identifyVein.mockResolvedValue({ employee_id: null })
      const wrapper = await mountKiosk()
      finger.cb!()
      await flushPromises()
      finger.cb!()
      await flushPromises()

      expect(vein.capture).toHaveBeenCalledTimes(1)
      captured('BDBD01')
      await flushPromises()
      wrapper.unmount()
    })

    it('unmount で購読を解除する / ボタンは今までどおり「指を置いて」を鳴らす', async () => {
      api.identifyVein.mockResolvedValue({ employee_id: null })
      const wrapper = await mountKiosk()
      await pressVein(wrapper)
      expect(vein.say).toHaveBeenCalledWith('PLACE')
      wrapper.unmount()
      expect(finger.off).toHaveBeenCalledTimes(1)
    })
  })

  describe('モジュール経路: 照合をモジュールに任せる (Refs ippoan/alc-app#436)', () => {
    beforeEach(() => {
      viaModule.on = true
      vein.identify.mockResolvedValue(12)
      db.loadVeinModuleEntries.mockResolvedValue([
        { employeeId: 'emp-1', moduleId: 12, updatedAt: 'v1', approved: true },
        { employeeId: 'emp-2', moduleId: 13, updatedAt: 'v1', approved: false },
      ])
      api.getEmployeeById.mockResolvedValue(EMP)
    })

    it('VEIN IDENTIFY の ID → 対応表 → 乗務員で、NFC と同じく identifyEmployee へ合流する', async () => {
      const wrapper = await mountKiosk()
      await pressVein(wrapper)
      expect(vein.identify).toHaveBeenCalledTimes(1)
      expect(vein.capture).not.toHaveBeenCalled()
      expect(api.identifyVein).not.toHaveBeenCalled()
      expect(api.getEmployeeById).toHaveBeenCalledWith('emp-1', 'default')
      expect(identifyEmployeeMock).toHaveBeenCalledWith('emp-1', '山田 太郎')
      wrapper.unmount()
    })

    it('★ 承認待ちの ID に当たっても本人確認にしない (未承認と出す)', async () => {
      vein.identify.mockResolvedValue(13)
      api.getEmployeeById.mockRejectedValueOnce(new Error('500'))
      const wrapper = await mountKiosk()
      await pressVein(wrapper)
      expect(identifyEmployeeMock).not.toHaveBeenCalled()
      expect(wrapper.text()).toContain('この人さんの指静脈は未承認です')
      wrapper.unmount()
    })

    it('★ モジュールが撮り直しを求めたら (onAgain)、ボタンを「もう一度置いてください…」にする。次の照合では戻す', async () => {
      let finish: (id: number | null) => void = () => {}
      vein.identify.mockImplementationOnce((onAgain?: () => void) => new Promise((resolve) => {
        finish = resolve
        onAgain?.()
      }))
      const wrapper = await mountKiosk()
      const button = () => wrapper.find('[data-testid="vein-identify"]')
      await button().trigger('click')
      await flushPromises()
      expect(button().text()).toBe('もう一度置いてください…')
      finish(12)
      await flushPromises()

      vein.identify.mockImplementationOnce(() => new Promise(() => {}))
      await button().trigger('click')
      await flushPromises()
      expect(button().text()).toBe('指を置いてください…')
      wrapper.unmount()
    })

    it('VEIN NOMATCH は不一致、読み取りの失敗は理由を出す', async () => {
      vein.identify.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('TIMEOUT'))
      const wrapper = await mountKiosk()
      await pressVein(wrapper)
      expect(wrapper.text()).toContain(VEIN_NO_MATCH_MESSAGE)
      await pressVein(wrapper)
      expect(wrapper.text()).toContain('指静脈を読み取れませんでした (TIMEOUT)')
      wrapper.unmount()
    })

    it('Vein Station がつながったら、モジュールも揃えにいく (写しは同期したばかりなら取り直さない)', async () => {
      const connected = ref(false)
      vein.isConnected = connected
      const wrapper = await mountKiosk()
      expect(api.getVeinTemplates).toHaveBeenCalledTimes(1)
      connected.value = true
      await flushPromises()
      expect(api.getVeinTemplates).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })
  })
})
