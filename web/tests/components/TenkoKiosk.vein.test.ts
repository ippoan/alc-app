import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import TenkoKiosk from '~/components/TenkoKiosk.vue'
import type { TenkoStep } from '~/composables/useTenkoKiosk'
import type { ApiEmployee } from '~/types'
import { VEIN_NO_MATCH_MESSAGE, VEIN_OFFLINE_STALE_MESSAGE } from '~/utils/vein-identify'

// キオスクの「指静脈で本人確認」(Refs ippoan/vein-match#20)。遠隔点呼・自動点呼は最初の段の NFC (免許証) で乗務員を
// 特定し、その後の本人確認の段 (顔認証の代わり) で指静脈を照合する。当たった人が最初の段の人と同じなら本人確認。
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
  putVeinModuleEntry: vi.fn(async () => {}),
}))
vi.mock('~/utils/vein-db', () => db)

const match = vi.hoisted(() => ({
  loadVeinWasm: vi.fn(),
  matchVeinOffline: vi.fn(),
}))
vi.mock('~/utils/vein-match', () => match)

// モジュール経路の判定 (usesVeinModule) だけ差し替える (対応表の引き方は本物を通す、Refs ippoan/alc-app#436)
// 本人が決まった人の記録の用意 (prepareVeinModuleRecord) は prep.fn に差し替える (中身は utils/vein-module.test.ts)
const viaModule = vi.hoisted(() => ({ on: false }))
const prep = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('~/utils/vein-module', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/vein-module')>()),
  usesVeinModule: () => viaModule.on,
  prepareVeinModuleRecord: (...args: unknown[]) => prep.fn(...args),
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
  verify: vi.fn(),
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
// 最初の段 (NFC) で特定した乗務員
const employeeId = ref('emp-1')
const employeeName = ref('山田 太郎')
/** 指静脈で本人確認できたときに渡す結果 */
const VEIN_OK = { verified: true, similarity: 0, skipped: true }

mockNuxtImport('useTenkoKiosk', () => () => ({
  step,
  employeeId,
  employeeName,
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
    step.value = 'face_auth'
    employeeId.value = 'emp-1'
    employeeName.value = '山田 太郎'
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

  it('オンラインで当たり → 案内してから読み取り、最初の段の人と同じなら本人確認にする', async () => {
    api.identifyVein.mockResolvedValue({ employee_id: 'emp-1', name: '山田 太郎' })
    api.getEmployeeById.mockResolvedValue(EMP)
    const wrapper = await mountKiosk()
    await pressVein(wrapper)

    expect(vein.say).toHaveBeenCalledWith('PLACE')
    expect(api.identifyVein).toHaveBeenCalledWith('BDBD01')
    expect(onFaceAuthCompleteMock).toHaveBeenCalledWith(VEIN_OK)
    expect(vein.say).not.toHaveBeenCalledWith('FAILED')
    expect(wrapper.find('[data-testid="vein-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('外れ → FAILED を鳴らし、画面に理由を出す (本人確認の段のまま置き直せる)', async () => {
    api.identifyVein.mockResolvedValue({ employee_id: null })
    const wrapper = await mountKiosk()
    await pressVein(wrapper)

    expect(onFaceAuthCompleteMock).not.toHaveBeenCalled()
    expect(vein.say).toHaveBeenCalledWith('FAILED')
    expect(wrapper.find('[data-testid="vein-error"]').text()).toBe(VEIN_NO_MATCH_MESSAGE)
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

  it('オフラインで当たり → wasm で照合し、社員一覧から引いて本人確認にする', async () => {
    setOnline(false)
    match.matchVeinOffline.mockResolvedValue({ kind: 'hit', employeeId: 'emp-1' })
    api.getEmployees.mockResolvedValue([EMP])
    const wrapper = await mountKiosk()
    await pressVein(wrapper)

    expect(api.identifyVein).not.toHaveBeenCalled()
    expect(match.matchVeinOffline).toHaveBeenCalledWith('BDBD01', expect.objectContaining({ logicVersion: '0.1.1' }))
    expect(onFaceAuthCompleteMock).toHaveBeenCalledWith(VEIN_OK)
    wrapper.unmount()
  })

  it('★ 版の不一致 → オフラインの照合を止め、同期を促す', async () => {
    setOnline(false)
    match.matchVeinOffline.mockResolvedValue({ kind: 'version_mismatch', stored: '0.1.0', wasm: '0.1.1' })
    const wrapper = await mountKiosk()
    await pressVein(wrapper)

    expect(onFaceAuthCompleteMock).not.toHaveBeenCalled()
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

  it('★ Vein Station が無い → 顔認証に逃がさず、本人確認の段で止める', async () => {
    vein.isConnected = ref(false)
    const wrapper = await mountKiosk()
    expect(wrapper.find('[data-testid="vein-identify"]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'FaceAuth' }).exists()).toBe(false)
    expect(wrapper.find('[data-testid="vein-missing"]').text()).toContain('Vein Station (指静脈読み取り端末) が接続されていません')
    wrapper.unmount()
  })

  it('WebSerial が無い端末 → 本人確認の段で止め、理由を出す', async () => {
    vein.isSupported = false
    const wrapper = await mountKiosk()
    expect(wrapper.find('[data-testid="vein-identify"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="vein-missing"]').text()).toContain('この端末では指静脈を読めません')
    wrapper.unmount()
  })

  it('★ 別の人の指静脈に当たったら本人確認にしない (置き直させる)', async () => {
    api.identifyVein.mockResolvedValue({ employee_id: 'emp-2', name: '佐藤 次郎' })
    api.getEmployeeById.mockResolvedValue({ ...EMP, id: 'emp-2', name: '佐藤 次郎' })
    const wrapper = await mountKiosk()
    await pressVein(wrapper)

    expect(onFaceAuthCompleteMock).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="vein-error"]').text()).toBe('山田 太郎さんの指静脈と一致しません。本人の指を置いてください')
    wrapper.unmount()
  })

  it('★ 最初の段 (NFC) には指静脈のボタンを出さない', async () => {
    step.value = 'nfc'
    const wrapper = await mountKiosk()
    expect(wrapper.find('[data-testid="vein-identify"]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'NfcStatus' }).exists()).toBe(true)
    wrapper.unmount()
  })

  it('★ 遠隔点呼でも本人確認は指静脈 (顔認証の画面は出さない)', async () => {
    api.identifyVein.mockResolvedValue({ employee_id: 'emp-1', name: '山田 太郎' })
    api.getEmployeeById.mockResolvedValue(EMP)
    const wrapper = await mountRemoteKiosk()
    expect(wrapper.findComponent({ name: 'FaceAuth' }).exists()).toBe(false)
    await pressVein(wrapper)
    expect(onFaceAuthCompleteMock).toHaveBeenCalledWith(VEIN_OK)
    wrapper.unmount()
  })

  it('最初の画面に戻ったとき、前回の同期から間が無ければ取り直さない', async () => {
    const wrapper = await mountKiosk()
    const calls = api.getVeinTemplates.mock.calls.length
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
      expect(onFaceAuthCompleteMock).toHaveBeenCalledWith(VEIN_OK)
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

    it('本人確認の段でなければ始めない', async () => {
      const wrapper = await mountKiosk()
      step.value = 'nfc'
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
        { employeeId: 'emp-3', moduleId: 14, updatedAt: 'v1', approved: true },
      ])
      api.getEmployeeById.mockResolvedValue(EMP)
    })

    it('★ 1:1: 最初の段の人の記録をモジュールに用意し、1:N で当たった ID がその人の枠なら本人確認にする (VEIN VERIFY は使わない)', async () => {
      prep.fn.mockResolvedValue(12)
      const wrapper = await mountKiosk()
      // 本人確認の段に入った時点で書き始める (指を置くまでの間と重ねる)
      expect(prep.fn).toHaveBeenCalledWith(vein, 'emp-1', undefined)
      await pressVein(wrapper)
      expect(prep.fn).toHaveBeenCalledTimes(1)
      expect(vein.identify).toHaveBeenCalledWith(expect.any(Function))
      expect(vein.verify).not.toHaveBeenCalled()
      expect(api.getEmployeeById).toHaveBeenCalledWith('emp-1', 'default')
      expect(onFaceAuthCompleteMock).toHaveBeenCalledWith(VEIN_OK)
      // 用意は 1 回の照合で使い切る (次の照合はもう一度確かめる)
      await pressVein(wrapper)
      expect(prep.fn).toHaveBeenCalledTimes(2)
      wrapper.unmount()
    })

    it('★ 承認済みの記録が無ければ照合せずに理由を出す', async () => {
      prep.fn.mockResolvedValue(null)
      const wrapper = await mountKiosk()
      await pressVein(wrapper)
      expect(vein.identify).not.toHaveBeenCalled()
      expect(onFaceAuthCompleteMock).not.toHaveBeenCalled()
      expect(wrapper.text()).toContain('この人の承認済みの指静脈の記録がありません')
      wrapper.unmount()
    })

    it('★ モジュールが撮り直しを求めたら (onAgain)、ボタンを「もう一度置いてください…」にする。次の照合では戻す', async () => {
      prep.fn.mockResolvedValue(12)
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

    it('不一致は (1 回自動でやり直しても) 不一致、読み取り・用意の失敗は理由を出す', async () => {
      prep.fn.mockResolvedValue(12)
      // 1 回目は誰にも当たらず、やり直しは他人 (emp-3) の枠に当たる → 本人ではない
      vein.identify.mockResolvedValueOnce(null).mockResolvedValueOnce(14).mockRejectedValueOnce(new Error('TIMEOUT'))
      const wrapper = await mountKiosk()
      await pressVein(wrapper)
      expect(vein.identify).toHaveBeenCalledTimes(2)
      expect(onFaceAuthCompleteMock).not.toHaveBeenCalled()
      expect(wrapper.text()).toContain(VEIN_NO_MATCH_MESSAGE)
      await pressVein(wrapper)
      expect(wrapper.text()).toContain('指静脈を読み取れませんでした (TIMEOUT)')
      prep.fn.mockRejectedValue(new Error('WRITE_SEQ'))
      await pressVein(wrapper)
      expect(wrapper.text()).toContain('指静脈の記録をこの端末に用意できませんでした (WRITE_SEQ)')
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
