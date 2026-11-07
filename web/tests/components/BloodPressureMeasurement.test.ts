import type { BpUiState } from '~/composables/useBloodPressureSetting'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, computed, watchEffect } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import BloodPressureMeasurement from '~/components/BloodPressureMeasurement.vue'
import { readReloadContext, resetReloadContext, useKioskScreen } from '~/composables/useKioskScreen'
import { VEIN_TEMPLATE_SYNC_INTERVAL_MS } from '~/utils/vein-identify'

// 血圧だけを測る端末の画面 (Refs ippoan/alc-app-s3#135)。
// 指を置く (指静脈だけで本人確認) → 血圧を測る → 完了 だけを行い、**点呼の記録は作らない**。
// 顔認証は無い (点呼が測定台の血圧を引き当てるので、本人確認は指静脈に限る)。カード・社員番号は人を選ぶだけで、
// その人の指静脈を 1:1 で照合する (一致しなければ測らない)。
// 従業員はすべて合成値 (実在の乗務員名・カード番号は書かない)

// vi.mock はファイル先頭へ巻き上がるので、factory から触る mock は vi.hoisted で作る。
// 他の export (useAuth が使う rePairDevice 等) は本物のまま残す
const { startMeasurementMock, updateMeasurementMock, saveMeasurementMock, startTenkoSessionMock, getEmployeeByNfcIdMock, getEmployeeByCodeMock, lookupEmployeeByCardMock }
  = vi.hoisted(() => ({
    getEmployeeByNfcIdMock: vi.fn(),
    getEmployeeByCodeMock: vi.fn(),
    lookupEmployeeByCardMock: vi.fn(),
    startMeasurementMock: vi.fn(),
    updateMeasurementMock: vi.fn(),
    saveMeasurementMock: vi.fn(),
    startTenkoSessionMock: vi.fn(),
  }))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  startMeasurement: startMeasurementMock,
  updateMeasurement: updateMeasurementMock,
  saveMeasurement: saveMeasurementMock,
  startTenkoSession: startTenkoSessionMock,
  getEmployeeByNfcId: getEmployeeByNfcIdMock,
  getEmployeeByCode: getEmployeeByCodeMock,
  lookupEmployeeByCard: lookupEmployeeByCardMock,
}))

// USB の機体 (Vein Base) の行の受け口。画面が登録した cb を控え、行はテストが流す
type HubEventHandler = (name: string, args: string[], source: string) => void
let hubCardHandler: HubEventHandler | null = null
const hubOffMock = vi.fn()
mockNuxtImport('useUsbHub', () => () => ({
  nfc: { onEvent: (cb: HubEventHandler) => { hubCardHandler = cb; return hubOffMock } },
}))

// 「この端末で血圧を使うか」の判定は **`useBpUiEnabled` の 1 か所** (Refs ippoan/alc-app#353)。
// 生の `bpEnabled` (= サーバの `devices.bp_enabled`) は、`devices` に行を持たない
// 測定台では**永久に false** なので、画面はこちらを見る
const bpUiState = ref<BpUiState>('show')
mockNuxtImport('useBpUiEnabled', () => () => ({
  bpUiState,
  showBpUi: computed(() => bpUiState.value === 'show'),
}))

const latestBloodPressure = ref<{ systolic: number, diastolic: number, pulse?: number, measuredAt: Date } | null>(null)
mockNuxtImport('useBleGateway', () => () => ({ latestBloodPressure }))

// Vein Station がつながっているときだけ、最初の段に指静脈登録の入口を出す (Refs ippoan/vein-match#20)。
// 乗務員の特定も指静脈が主 (Refs ippoan/alc-app#436)
const veinIsConnected = ref(false)
const veinConnect = vi.fn(async () => true)
// 指が置かれた合図 (EVT VEIN FINGER) の購読は、受けた cb を finger.fire で呼べるようにしておく
const finger = vi.hoisted(() => ({ cb: null as (() => void) | null, off: vi.fn() }))
const vein = vi.hoisted(() => ({
  isSupported: true,
  say: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  verify: vi.fn(),
  onFingerPlaced: vi.fn((cb: () => void) => { finger.cb = cb; return finger.off }),
}))
// 直近の照合結果 (via だけ使う)。FP の層でだけ当たったときの「撮り直し」の提案の材料
const veinLastMatch = ref<{ via: 'FV' | 'FP' | null } | null>(null)
mockNuxtImport('useVeinSerial', () => () => ({ ...vein, isConnected: veinIsConnected, connect: veinConnect, lastMatch: veinLastMatch }))

// 「この端末で撮り直す」の提案が使う足す手順 (Refs ippoan/alc-app#558)。手順は useVeinAddDevice.test.ts の領分で、ここは入口だけ見る
const addDevice = vi.hoisted(() => ({
  add: vi.fn(),
  reset: vi.fn(),
  scope: null as string | null,
}))
const addAdding = ref(false)
const addAvailable = ref(true)
const addAdded = ref(false)
const addError = ref<string | null>(null)
const addNotice = ref<string | null>(null)
mockNuxtImport('useVeinAddDevice', () => (opts: { scope: string }) => {
  addDevice.scope = opts.scope
  return { adding: addAdding, available: addAvailable, added: addAdded, error: addError, notice: addNotice, add: addDevice.add, reset: addDevice.reset }
})

// 血圧を待っている間の BLE の見張り。止まりの警告と再起動のボタンを出すかだけを差し替える
const bleWatchState = ref<'ok' | 'stuck' | 'no-reply'>('ok')
// 見張りを動かす条件 (血圧を待つ段) は、渡された ref を読んで控える
const bleWatchActive = ref<boolean | null>(null)
mockNuxtImport('useBleWatch', () => (_serial: unknown, active: { value: boolean }) => {
  watchEffect(() => { bleWatchActive.value = active.value })
  return { state: bleWatchState, stuckStage: ref(null) }
})
const restartMock = vi.hoisted(() => vi.fn())
vi.mock('~/utils/vein-restart', () => ({ restartVeinAndReload: restartMock }))

// 照合の振り分け (オンライン/オフライン) は vein-identify.test.ts の領分。ここでは結果だけを差し替える
const veinIdentify = vi.hoisted(() => ({
  identifyVeinEmployee: vi.fn(),
  syncVeinTemplates: vi.fn(),
}))
vi.mock('~/utils/vein-identify', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/vein-identify')>()),
  ...veinIdentify,
}))

// 照合をモジュールに任せる (Refs ippoan/alc-app#436)。対応表の引き方は vein-module.test.ts
const veinModule = vi.hoisted(() => ({
  usesVeinModule: vi.fn(() => false),
  identifyVeinModuleEmployee: vi.fn(),
  // カード・社員番号で決めた人の 1:1 (記録の用意と照合)。中身は vein-module.test.ts
  prepareVeinModuleRecord: vi.fn(),
  matchVeinModuleEmployee: vi.fn(),
  // 通った後の記録の入れ替えは裏で走る。中身は vein-module.test.ts
  rotateVeinModuleRecord: vi.fn(async (..._args: unknown[]) => {}),
}))
vi.mock('~/utils/vein-module', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/vein-module')>()),
  ...veinModule,
}))

const NfcStatusStub = { name: 'NfcStatus', template: '<div class="nfc-stub" />', emits: ['read'] }
const FaceAuthStub = { name: 'FaceAuth', template: '<div class="face-stub" />', emits: ['result'] }
const BleStatusStub = { name: 'BleStatus', template: '<div class="ble-stub" />', emits: ['next', 'skip'] }
const VeinRegistrationStub = { name: 'VeinRegistration', template: '<div class="vein-stub" />', props: ['employee'], emits: ['close'] }
const VeinModuleListStub = { name: 'VeinModuleList', template: '<div class="vein-list-stub" />', emits: ['close'] }
const BpBluetoothSettingsStub = { name: 'BpBluetoothSettings', template: '<div class="bp-ble-stub" />', emits: ['close'] }
const VeinPendingApprovalStub = { name: 'VeinPendingApproval', template: '<div class="vein-pending-stub" />', emits: ['close'] }
const ThermoTestStub = { name: 'ThermoTest', template: '<div class="thermo-test-stub" />', emits: ['close'] }
const VeinDeviceProfileStub = { name: 'VeinDeviceProfilePanel', template: '<div class="vein-profile-stub" />', props: ['scope', 'closeLabel'], emits: ['close'] }

function mountBp() {
  return mountSuspended(BloodPressureMeasurement, {
    shallow: true,
    global: { stubs: { NfcStatus: NfcStatusStub, FaceAuth: FaceAuthStub, BleStatus: BleStatusStub, VeinRegistration: VeinRegistrationStub, VeinModuleList: VeinModuleListStub, BpBluetoothSettings: BpBluetoothSettingsStub, VeinPendingApproval: VeinPendingApprovalStub, ThermoTest: ThermoTestStub, VeinDeviceProfilePanel: VeinDeviceProfileStub, EmployeeCodeKeypad: false, VeinRefreshSuggest: false } },
  })
}

/** 非同期の乗務員解決・保存を流し切る */
async function flush(wrapper: Awaited<ReturnType<typeof mountBp>>) {
  await new Promise(resolve => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
}

/** Vein Station がつながった測定台。照合は既定で乗務員 emp-vein-1 に当たる */
function arrangeVein() {
  resetReloadContext()
  veinIsConnected.value = true
  vein.isSupported = true
  vein.say.mockReset()
  vein.say.mockResolvedValue(undefined)
  vein.capture.mockReset()
  vein.capture.mockResolvedValue('chara-hex')
  veinIdentify.identifyVeinEmployee.mockReset()
  veinIdentify.identifyVeinEmployee.mockResolvedValue({
    kind: 'hit',
    employee: { id: 'emp-vein-1', name: 'テスト花子', face_approval_status: 'approved' },
  })
  veinIdentify.syncVeinTemplates.mockReset()
  veinIdentify.syncVeinTemplates.mockResolvedValue(true)
}

/** 「指を置いて照合」を押して、測定へ進むまで流す */
async function identifyByFinger(wrapper: Awaited<ReturnType<typeof mountBp>>) {
  await wrapper.find('[data-testid="vein-identify"]').trigger('click')
  await flush(wrapper)
}

describe('BloodPressureMeasurement (Refs ippoan/alc-app-s3#135)', () => {
  beforeEach(() => {
    bpUiState.value = 'show'
    latestBloodPressure.value = null
    arrangeVein()
    startMeasurementMock.mockReset()
    startMeasurementMock.mockResolvedValue({ id: 'meas-test-1' })
    updateMeasurementMock.mockReset()
    updateMeasurementMock.mockResolvedValue({ id: 'meas-test-1' })
    saveMeasurementMock.mockClear()
    startTenkoSessionMock.mockClear()
  })

  it('BloodPressureMeasurement — 指 → 血圧 の順に進む (顔認証を挟まない)', async () => {
    const wrapper = await mountBp()

    // 1. 指を置く段
    expect(wrapper.find('[data-testid="vein-identify"]').exists()).toBe(true)
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(false)

    // 2. 指静脈で特定すると、そのまま血圧測定へ
    await identifyByFinger(wrapper)
    expect(wrapper.find('[data-testid="bp-entry"]').exists()).toBe(false)
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
    expect(wrapper.text()).toContain('テスト花子')
    // BLE の見張りは血圧を待つ段のあいだだけ
    expect(bleWatchActive.value).toBe(true)

    wrapper.unmount()
  })

  it('★ 最初の画面は指の照合が主。その下にカード・社員番号で人を選ぶ入口', async () => {
    const wrapper = await mountBp()
    expect(wrapper.find('[data-testid="bp-entry"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="vein-identify"]').text()).toBe('指を置いて照合')
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'EmployeeCodeKeypad' }).exists()).toBe(true)
    expect(wrapper.text()).toContain('カード・社員番号で人を選んでから指を置く')
    expect(wrapper.html().indexOf('vein-identify')).toBeLessThan(wrapper.html().indexOf('nfc-stub'))
    expect(wrapper.find('[data-testid="vein-unavailable"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('★ Vein Station が使えないときは、つなぐよう案内するだけでカードの入口を出さない', async () => {
    veinIsConnected.value = false
    const wrapper = await mountBp()
    expect(wrapper.find('[data-testid="vein-unavailable"]').text()).toBe(
      '血圧は指静脈で本人を確かめてから測ります。Vein Station (指静脈読み取り端末) を USB でつないでください',
    )
    expect(wrapper.find('[data-testid="vein-identify"]').exists()).toBe(false)
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'NfcStatus' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'EmployeeCodeKeypad' }).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('社員番号')
    wrapper.unmount()
  })

  it('★ 顔認証の段は無い。ソースにも顔認証の部品・判定が残っていない (カードは人を選ぶだけで本人確認にしない)', () => {
    const src = readFileSync(
      resolve(import.meta.dirname!, '../../app/components/BloodPressureMeasurement.vue'),
      'utf-8',
    )
    // doc コメントの言及は残るので、呼び出し・部品の形を見る
    expect(src).not.toMatch(/<FaceAuth\b/)
    expect(src).not.toMatch(/checkFaceApproval\s*\(/)
    expect(src).not.toContain("'face_auth'")
    // カード・社員番号で決めた人を、指静脈を通さずに測定へ進める道 (旧: 不一致でも測る) を残さない
    expect(src).not.toContain('このまま測定します')
  })

  it('血圧が来る前に「次へ」が押されたら、進めずに測るよう促す。次の人へ戻すと消える', async () => {
    const wrapper = await mountBp()
    await identifyByFinger(wrapper)
    await wrapper.findComponent(BleStatusStub).vm.$emit('next')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('血圧がまだ測れていません。血圧計で測ってください')
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
    // 値が来た後に届いても促さない (完了の段のまま)
    latestBloodPressure.value = { systolic: 120, diastolic: 80, measuredAt: new Date('2026-09-16T01:02:03.000Z') }
    await flush(wrapper)
    ;(wrapper.vm as unknown as { $: { setupState: { onMeasureNext: () => void } } }).$.setupState.onMeasureNext()
    expect(wrapper.text()).toContain('測定完了')
    wrapper.unmount()
  })

  it('★ 血圧を待っている間に BLE が止まったら、画面から Vein Station を再起動できる', async () => {
    restartMock.mockReset()
    restartMock.mockRejectedValueOnce(new Error('Vein Station がつながっていません')).mockRejectedValueOnce('文字列の失敗').mockResolvedValue(undefined)
    const wrapper = await mountBp()
    await identifyByFinger(wrapper)
    expect(wrapper.find('[data-testid="ble-watch-warning"]').exists()).toBe(false)

    bleWatchState.value = 'stuck'
    await wrapper.vm.$nextTick()
    const button = () => wrapper.find('[data-testid="ble-watch-restart"]')
    expect(button().exists()).toBe(true)

    // 頼めなければ理由を出し、もう一度押せる
    await button().trigger('click')
    await flush(wrapper)
    expect(wrapper.find('[data-testid="ble-watch-restart-error"]').text()).toBe('Vein Station がつながっていません')
    expect(button().attributes('disabled')).toBeUndefined()

    // Error 以外で落ちても文字にして出す
    await button().trigger('click')
    await flush(wrapper)
    expect(wrapper.find('[data-testid="ble-watch-restart-error"]').text()).toBe('文字列の失敗')

    await button().trigger('click')
    await flush(wrapper)
    expect(restartMock).toHaveBeenCalledTimes(3)
    expect(button().attributes('disabled')).toBeDefined()
    expect(button().text()).toContain('読み込み直します')

    bleWatchState.value = 'ok'
    wrapper.unmount()
  })

  it('BloodPressureMeasurement — 指を待つ段を離れている間だけ「機体を使用中」を申告する (Refs ippoan/alc-app#403)', async () => {
    const wrapper = await mountBp()
    const { isDeviceBusy } = useKioskScreen()
    expect(isDeviceBusy.value).toBe(false)

    await identifyByFinger(wrapper)
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
    expect(isDeviceBusy.value).toBe(true)

    wrapper.unmount()
    expect(isDeviceBusy.value).toBe(false)
  })

  it('BloodPressureMeasurement — 血圧が測れたら保存する', async () => {
    const wrapper = await mountBp()
    await identifyByFinger(wrapper)

    const measuredAt = new Date('2026-09-16T01:02:03.000Z')
    latestBloodPressure.value = { systolic: 124, diastolic: 78, pulse: 66, measuredAt }
    await flush(wrapper)

    expect(startMeasurementMock).toHaveBeenCalledWith('emp-vein-1')
    expect(updateMeasurementMock).toHaveBeenCalledTimes(1)
    const [id, body] = updateMeasurementMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('meas-test-1')
    expect(body).toMatchObject({
      status: 'completed',
      systolic: 124,
      diastolic: 78,
      pulse: 66,
      medical_measured_at: measuredAt.toISOString(),
    })

    // 完了の段で測った値を見せる
    expect(wrapper.text()).toContain('測定完了')
    expect(wrapper.text()).toContain('テスト花子')
    expect(wrapper.text()).toContain('124')
    expect(wrapper.text()).toContain('78')

    wrapper.unmount()
  })

  describe('完了を先に出し、保存は裏で (Refs ippoan/alc-app#436)', () => {
    const reading = { systolic: 124, diastolic: 78, pulse: 66, measuredAt: new Date('2026-09-16T01:02:03.000Z') }
    const nextBtn = (w: Awaited<ReturnType<typeof mountBp>>) => w.findAll('button').find(b => b.text() === '次の人へ')!
    const retryBtn = (w: Awaited<ReturnType<typeof mountBp>>) => w.find('[data-testid="retry-save"]')

    async function toMeasure() {
      const wrapper = await mountBp()
      await identifyByFinger(wrapper)
      return wrapper
    }

    it('★ 保存が済むと結果の下に最初の画面を出し、10 秒のカウントダウンで最初の画面へ戻る', async () => {
      const wrapper = await toMeasure()
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      try {
        latestBloodPressure.value = reading
        await flush(wrapper)
        expect(wrapper.text()).toContain('測定完了')
        expect(wrapper.find('[data-testid="bp-entry"]').exists()).toBe(true)
        expect(wrapper.find('[data-testid="bp-done-countdown"]').text()).toContain('あと 10 秒')
        vi.advanceTimersByTime(3000)
        await wrapper.vm.$nextTick()
        expect(wrapper.find('[data-testid="bp-done-countdown"]').text()).toContain('あと 7 秒')
        vi.advanceTimersByTime(7000)
        await wrapper.vm.$nextTick()
        expect(wrapper.text()).not.toContain('測定完了')
        expect(wrapper.find('[data-testid="bp-entry"]').exists()).toBe(true)
        expect(wrapper.find('[data-testid="bp-done-countdown"]').exists()).toBe(false)
      }
      finally {
        vi.useRealTimers()
        wrapper.unmount()
      }
    })

    it('★ 完了の段のまま次の人が指を置くと、前の人の結果を片付けてそのまま進む', async () => {
      const wrapper = await toMeasure()
      latestBloodPressure.value = reading
      await flush(wrapper)
      expect(wrapper.text()).toContain('測定完了')
      veinIdentify.identifyVeinEmployee.mockResolvedValue({ kind: 'hit', employee: { id: 'emp-test-2', name: '次の人' } })
      await identifyByFinger(wrapper)
      expect(wrapper.text()).not.toContain('測定完了')
      expect(wrapper.text()).not.toContain('124')
      expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
      expect(wrapper.text()).toContain('次の人')
      wrapper.unmount()
    })

    it('カウントダウン中に画面を離れたら、タイマーを止める', async () => {
      const wrapper = await toMeasure()
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      try {
        latestBloodPressure.value = reading
        await flush(wrapper)
        expect(wrapper.find('[data-testid="bp-done-countdown"]').exists()).toBe(true)
        expect(vi.getTimerCount()).toBe(1)
        wrapper.unmount()
        expect(vi.getTimerCount()).toBe(0)
      }
      finally {
        vi.useRealTimers()
      }
    })

    it('保存中・保存の失敗中は最初の画面もカウントダウンも出さない', async () => {
      startMeasurementMock.mockImplementation(() => new Promise(() => {}))
      const wrapper = await toMeasure()
      latestBloodPressure.value = reading
      await flush(wrapper)
      expect(wrapper.text()).toContain('保存中...')
      expect(wrapper.find('[data-testid="bp-entry"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="bp-done-countdown"]').exists()).toBe(false)
      wrapper.unmount()
    })

    it('保存の応答を待たずに完了の段と値が出る。保存中は「次の人へ」が押せず、終わると押せる', async () => {
      let finishStart!: (v: { id: string }) => void
      startMeasurementMock.mockImplementation(() => new Promise((resolve) => { finishStart = resolve }))
      const wrapper = await toMeasure()

      latestBloodPressure.value = reading
      await flush(wrapper)
      expect(startMeasurementMock).toHaveBeenCalledTimes(1)
      expect(updateMeasurementMock).not.toHaveBeenCalled()
      expect(wrapper.text()).toContain('測定完了')
      expect(wrapper.text()).toContain('124')
      expect(wrapper.text()).toContain('保存中...')
      expect(nextBtn(wrapper).attributes('disabled')).toBeDefined()
      expect(retryBtn(wrapper).exists()).toBe(false)

      // 保存中に別の値が来ても二重に保存しない (段が done なので弾かれる)
      latestBloodPressure.value = { ...reading, systolic: 150 }
      await flush(wrapper)
      expect(startMeasurementMock).toHaveBeenCalledTimes(1)
      expect(wrapper.text()).toContain('124')

      finishStart({ id: 'meas-test-1' })
      await flush(wrapper)
      expect(updateMeasurementMock).toHaveBeenCalledTimes(1)
      expect(wrapper.text()).not.toContain('保存中...')
      expect(nextBtn(wrapper).attributes('disabled')).toBeUndefined()
      expect(retryBtn(wrapper).exists()).toBe(false)
      wrapper.unmount()
    })

    it('start で落ちたら赤字と「もう一度保存」。押すと start からやり直し、二度押ししても 1 回だけ', async () => {
      startMeasurementMock.mockRejectedValueOnce(new Error('接続できません'))
      const wrapper = await toMeasure()
      latestBloodPressure.value = reading
      await flush(wrapper)

      expect(wrapper.text()).toContain('測定完了')
      expect(wrapper.text()).toContain('接続できません')
      expect(updateMeasurementMock).not.toHaveBeenCalled()
      // 失敗しても次の人へは進める
      expect(nextBtn(wrapper).attributes('disabled')).toBeUndefined()

      let finishStart!: (v: { id: string }) => void
      startMeasurementMock.mockImplementation(() => new Promise((resolve) => { finishStart = resolve }))
      await retryBtn(wrapper).trigger('click')
      await flush(wrapper)
      // 保存中は赤字も「もう一度保存」も消える。二度押しは届いても走らない
      expect(wrapper.text()).not.toContain('接続できません')
      expect(retryBtn(wrapper).exists()).toBe(false)
      await (wrapper.vm as unknown as { $: { setupState: { onRetrySave: () => void } } }).$.setupState.onRetrySave()
      expect(startMeasurementMock).toHaveBeenCalledTimes(2)
      expect(startMeasurementMock).toHaveBeenLastCalledWith('emp-vein-1')

      finishStart({ id: 'meas-test-1' })
      await flush(wrapper)
      expect(updateMeasurementMock).toHaveBeenCalledTimes(1)
      expect(updateMeasurementMock.mock.calls[0]![1]).toMatchObject({ systolic: 124, diastolic: 78, pulse: 66 })
      expect(retryBtn(wrapper).exists()).toBe(false)
      wrapper.unmount()
    })

    it('update だけ落ちたら、取れた id のまま update だけやり直す (start は呼び直さない)', async () => {
      updateMeasurementMock.mockRejectedValueOnce(new Error('保存に失敗'))
      const wrapper = await toMeasure()
      latestBloodPressure.value = reading
      await flush(wrapper)
      expect(wrapper.text()).toContain('保存に失敗')

      await retryBtn(wrapper).trigger('click')
      await flush(wrapper)
      expect(startMeasurementMock).toHaveBeenCalledTimes(1)
      expect(updateMeasurementMock).toHaveBeenCalledTimes(2)
      expect(updateMeasurementMock.mock.calls[1]![0]).toBe('meas-test-1')
      expect(updateMeasurementMock.mock.calls[1]![1]).toMatchObject({ systolic: 124, diastolic: 78 })
      expect(retryBtn(wrapper).exists()).toBe(false)
      wrapper.unmount()
    })

    it('Error 以外で落ちた文言と、「次の人へ」で捨てた id は次の人に持ち越さない', async () => {
      updateMeasurementMock.mockRejectedValueOnce('boom')
      const wrapper = await toMeasure()
      latestBloodPressure.value = reading
      await flush(wrapper)
      expect(wrapper.text()).toContain('血圧の保存に失敗しました')

      await nextBtn(wrapper).trigger('click')
      await flush(wrapper)
      expect(wrapper.find('[data-testid="vein-identify"]').exists()).toBe(true)
      expect(retryBtn(wrapper).exists()).toBe(false)
      // 捨てた後は呼んでも何も起きない
      ;(wrapper.vm as unknown as { $: { setupState: { onRetrySave: () => void } } }).$.setupState.onRetrySave()
      await flush(wrapper)
      expect(startMeasurementMock).toHaveBeenCalledTimes(1)
      expect(updateMeasurementMock).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })
  })

  it.each<BpUiState>(['unused', 'unavailable', 'unregistered'])(
    'BloodPressureMeasurement — %s の端末では「血圧計が見つかりません」の案内だけを出す',
    async (state) => {
      bpUiState.value = state
      const wrapper = await mountBp()

      expect(wrapper.text()).toContain('血圧計が見つかりません')
      // 測る口はどれも出さない
      expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(false)
      expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
      expect(wrapper.findComponent(BleStatusStub).exists()).toBe(false)

      wrapper.unmount()
    },
  )

  it('BloodPressureMeasurement — checking の間は待つ (「使わない設定」に倒さない)', async () => {
    // ★ ここで倒すと、署名をまだ取りに行っていない起動直後に**必ず**詰まる
    bpUiState.value = 'checking'
    const wrapper = await mountBp()

    expect(wrapper.text()).toContain('血圧計を確認しています')
    expect(wrapper.text()).not.toContain('血圧計が見つかりません')
    // まだ測らせない (確認が済むまで)
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(false)

    wrapper.unmount()
  })

  it('BloodPressureMeasurement — 生の bpEnabled は見ない (測定台では永久に false のため)', () => {
    const src = readFileSync(
      resolve(import.meta.dirname!, '../../app/components/BloodPressureMeasurement.vue'),
      'utf-8',
    )
    // 判定は useBpUiEnabled の 1 か所に寄せる (doc コメントの言及は残るので、呼び出しの形を見る)
    expect(src).not.toMatch(/useBloodPressureSetting\s*\(/)
    expect(src).toMatch(/useBpUiEnabled\s*\(/)
  })

  it('BloodPressureMeasurement — 点呼の記録を作らない', async () => {
    const wrapper = await mountBp()
    await identifyByFinger(wrapper)

    latestBloodPressure.value = { systolic: 130, diastolic: 84, measuredAt: new Date('2026-09-16T02:00:00.000Z') }
    await flush(wrapper)

    // 点呼のセッションを作る口も、record_as_tenko 固定の口も通らない
    expect(startTenkoSessionMock).not.toHaveBeenCalled()
    expect(saveMeasurementMock).not.toHaveBeenCalled()
    // 保存の本文に点呼の印が入らない (入ると rust-alc-api が点呼の記録を作る)
    const [, body] = updateMeasurementMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).not.toHaveProperty('record_as_tenko')
    expect(body).not.toHaveProperty('tenko_type')

    // 点呼のセッション前提の口を呼んでいないこと自体を固定する
    // (doc コメントは「使わない」と書いているので、呼び出しの形だけを見る)
    const src = readFileSync(
      resolve(import.meta.dirname!, '../../app/components/BloodPressureMeasurement.vue'),
      'utf-8',
    )
    expect(src).not.toMatch(/useTenkoKiosk\s*\(/)
    expect(src).not.toMatch(/\bsaveMeasurement\s*\(/)

    wrapper.unmount()
  })
})

// 本番 flip 後の新版への載せ替え (Refs ippoan/alc-app#387)。測定台は指を待って開いた
// ままになるので、指を待つ間は「いまリロードして失うものが無い」と申告する。
// 読むのは plugin と同じ口 (`readReloadContext`)
describe('BloodPressureMeasurement — 画面の高さに収まらないとき', () => {
  it('自分の枠の中でスクロールし、下に固定された測定ログの帯のぶん空ける', async () => {
    const wrapper = await mountBp()
    const root = wrapper.find('[data-testid="bp-root"]')
    expect(root.classes()).toContain('overflow-y-auto')
    expect(root.classes()).toContain('pb-16')
    wrapper.unmount()
  })
})

describe('BloodPressureMeasurement — 新版への載せ替えの申告 (Refs ippoan/alc-app#387)', () => {
  const safe = () => readReloadContext().safe

  beforeEach(() => {
    arrangeVein()
    bpUiState.value = 'show'
    latestBloodPressure.value = null
    startMeasurementMock.mockReset()
    startMeasurementMock.mockResolvedValue({ id: 'meas-test-1' })
    updateMeasurementMock.mockReset()
    updateMeasurementMock.mockResolvedValue({ id: 'meas-test-1' })
  })

  it('★ 指を待つ間は安全。画面を離れたら申告を残さない', async () => {
    const wrapper = await mountBp()
    expect(readReloadContext()).toEqual({ screen: null, safe: 1, blocked: 0 })

    wrapper.unmount()
    expect(readReloadContext()).toEqual({ screen: null, safe: 0, blocked: 0 })
  })

  it('★ 指の照合中は段が動かなくても外れ、進んだ先でも外れたまま。「次の人へ」で戻る', async () => {
    let identified!: (o: unknown) => void
    veinIdentify.identifyVeinEmployee.mockImplementation(() => new Promise((resolve) => { identified = resolve }))
    const wrapper = await mountBp()
    expect(safe()).toBe(1)

    // 照合の応答待ち: 画面はまだ最初の段のまま
    await wrapper.find('[data-testid="vein-identify"]').trigger('click')
    await flush(wrapper)
    expect(wrapper.find('[data-testid="vein-identify"]').exists()).toBe(true)
    expect(safe()).toBe(0)

    identified({ kind: 'hit', employee: { id: 'emp-vein-1', name: 'テスト花子' } })
    await flush(wrapper)
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
    expect(safe()).toBe(0)

    latestBloodPressure.value = { systolic: 130, diastolic: 84, measuredAt: new Date('2026-09-16T02:00:00.000Z') }
    await flush(wrapper)
    expect(wrapper.text()).toContain('測定完了')
    expect(safe()).toBe(0)

    await wrapper.findAll('button').find(b => b.text() === '次の人へ')!.trigger('click')
    expect(safe()).toBe(1)
    wrapper.unmount()
  })

  it('★ 照合が失敗で終わっても、照合中の印は戻る', async () => {
    let fail!: (o: unknown) => void
    veinIdentify.identifyVeinEmployee.mockImplementation(() => new Promise((resolve) => { fail = resolve }))
    const wrapper = await mountBp()

    await wrapper.find('[data-testid="vein-identify"]').trigger('click')
    await flush(wrapper)
    expect(safe()).toBe(0)
    fail({ kind: 'error', message: '照合データがありません' })
    await flush(wrapper)
    expect(wrapper.find('[data-testid="vein-identify"]').exists()).toBe(true)
    expect(safe()).toBe(1)
    wrapper.unmount()
  })

  describe('指静脈の登録 (Refs ippoan/vein-match#20)', () => {
    const veinEntry = (w: Awaited<ReturnType<typeof mountBp>>) =>
      w.findAll('button').find(b => b.text().includes('指静脈を登録する'))

    it('マウント時に Vein Station へ接続しにいく。つながっていなければ入口を出さない', async () => {
      veinIsConnected.value = false
      const wrapper = await mountBp()
      expect(veinConnect).toHaveBeenCalled()
      expect(veinEntry(wrapper)).toBeUndefined()
    })

    it('つながっていれば最初の段に入口を出し、押すと登録画面 → 戻ると最初の段', async () => {
      veinIsConnected.value = true
      resetReloadContext()
      const wrapper = await mountBp()
      expect(readReloadContext().safe).toBe(1)
      await veinEntry(wrapper)!.trigger('click')
      expect(wrapper.findComponent(VeinRegistrationStub).exists()).toBe(true)
      expect(wrapper.find('[data-testid="bp-entry"]').exists()).toBe(false)
      expect(veinEntry(wrapper)).toBeUndefined()
      // 登録中はリロードしてよいと申告しない (指を待つ段だけが安全)
      expect(readReloadContext().safe).toBe(0)
      await wrapper.findComponent(VeinRegistrationStub).vm.$emit('close')
      expect(wrapper.find('[data-testid="bp-entry"]').exists()).toBe(true)
      wrapper.unmount()
    })

    it('血圧計が見つからない端末でも入口を出す', async () => {
      veinIsConnected.value = true
      bpUiState.value = 'unused'
      const wrapper = await mountBp()
      expect(veinEntry(wrapper)).toBeDefined()
    })
  })
})

// 乗務員の特定は指静脈だけ (Refs ippoan/alc-app#436)。手順は TenkoKiosk の指静脈と同じ
describe('BloodPressureMeasurement — 指静脈で乗務員を特定する (Refs ippoan/alc-app#436)', () => {
  const veinButton = (w: Awaited<ReturnType<typeof mountBp>>) => w.find('[data-testid="vein-identify"]')
  const veinErrorText = (w: Awaited<ReturnType<typeof mountBp>>) => w.find('[data-testid="vein-error"]').text()

  beforeEach(() => {
    arrangeVein()
    bpUiState.value = 'show'
    latestBloodPressure.value = null
  })

  it('つながっていれば指のボタンを先頭に出し、登録の入口・一覧は 2 列', async () => {
    const wrapper = await mountBp()
    const html = wrapper.html()
    expect(veinButton(wrapper).text()).toBe('指を置いて照合')
    expect(html.indexOf('vein-identify')).toBeLessThan(html.indexOf('指静脈を登録する'))
    expect(wrapper.find('[data-testid="vein-module-list-open"]').element.parentElement!.classList.contains('grid-cols-2')).toBe(true)
    wrapper.unmount()
  })

  it.each([
    ['つながっていない', () => { veinIsConnected.value = false }],
    ['WebSerial が無い', () => { vein.isSupported = false }],
  ])('%s端末では指の欄を出さず、つなぐ案内だけ (カードの代わりは無い)', async (_label, arrange) => {
    arrange()
    const wrapper = await mountBp()
    expect(veinButton(wrapper).exists()).toBe(false)
    expect(wrapper.find('[data-testid="vein-unavailable"]').text()).toContain('Vein Station (指静脈読み取り端末) を USB でつないでください')
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(false)
    expect(wrapper.find('[data-testid="code-display"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('カードで進む')
    wrapper.unmount()
  })

  it('当たれば顔認証を挟まず測定へ進み、名前が出る。案内 → 読み取りの順で送る', async () => {
    const wrapper = await mountBp()
    await veinButton(wrapper).trigger('click')
    await flush(wrapper)

    expect(vein.say).toHaveBeenCalledWith('PLACE')
    expect(vein.say.mock.invocationCallOrder[0]).toBeLessThan(vein.capture.mock.invocationCallOrder[0]!)
    expect(veinIdentify.identifyVeinEmployee).toHaveBeenCalledWith('chara-hex')
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
    expect(wrapper.text()).toContain('テスト花子')
    expect(vein.say).not.toHaveBeenCalledWith('FAILED')
    wrapper.unmount()
  })

  it('外れたら「もう一度指を置いてください」と出し、最初の段に残る (カード・社員番号で人を選ぶ入口はそのまま)', async () => {
    veinIdentify.identifyVeinEmployee.mockResolvedValue({ kind: 'miss' })
    const wrapper = await mountBp()
    await veinButton(wrapper).trigger('click')
    await flush(wrapper)

    expect(veinErrorText(wrapper)).toBe('照合できませんでした。もう一度指を置いてください')
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(vein.say).toHaveBeenCalledWith('FAILED')
    expect(wrapper.find('[data-testid="bp-entry"]').exists()).toBe(true)
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(false)
    expect(veinButton(wrapper).attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('照合が失敗したらその理由をそのまま出す', async () => {
    veinIdentify.identifyVeinEmployee.mockResolvedValue({ kind: 'error', message: '照合データがありません' })
    const wrapper = await mountBp()
    await veinButton(wrapper).trigger('click')
    await flush(wrapper)
    expect(veinErrorText(wrapper)).toBe('照合データがありません')
    expect(vein.say).toHaveBeenCalledWith('FAILED')
    wrapper.unmount()
  })

  it('読み取れなかったら理由を添え、照合はしない。FAILED の案内が失敗しても画面は止まらない', async () => {
    vein.capture.mockRejectedValue(new Error('NO_FINGER'))
    vein.say.mockImplementation(async (cmd: string) => {
      if (cmd === 'FAILED') throw new Error('port closed')
    })
    const wrapper = await mountBp()
    await veinButton(wrapper).trigger('click')
    await flush(wrapper)
    expect(veinErrorText(wrapper)).toBe('指静脈を読み取れませんでした (NO_FINGER)')
    expect(veinIdentify.identifyVeinEmployee).not.toHaveBeenCalled()
    expect(veinButton(wrapper).attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('ファーム更新中は案内の時点で断られ、その理由を出す', async () => {
    vein.say.mockRejectedValueOnce(new Error('ファームウェアを更新しています'))
    const wrapper = await mountBp()
    await veinButton(wrapper).trigger('click')
    await flush(wrapper)
    expect(veinErrorText(wrapper)).toBe('指静脈を読み取れませんでした (ファームウェアを更新しています)')
    expect(vein.capture).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it.each(['rejected', 'pending', 'unregistered'])(
    '顔が %s の乗務員でも、指静脈で特定すれば止まらず測定へ進む (顔を使わない)',
    async (status) => {
      veinIdentify.identifyVeinEmployee.mockResolvedValue({
        kind: 'hit',
        employee: { id: 'emp-vein-2', name: 'テスト五郎', face_approval_status: status },
      })
      const wrapper = await mountBp()
      await veinButton(wrapper).trigger('click')
      await flush(wrapper)
      expect(wrapper.text()).not.toContain('却下')
      expect(wrapper.text()).not.toContain('顔認証をスキップ')
      expect(wrapper.find('.text-red-700').exists()).toBe(false)
      expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
      expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
      expect(wrapper.text()).toContain('テスト五郎')
      wrapper.unmount()
    },
  )

  it('指静脈で特定した乗務員の血圧は、その乗務員で保存する', async () => {
    startMeasurementMock.mockResolvedValue({ id: 'meas-test-1' })
    updateMeasurementMock.mockResolvedValue({ id: 'meas-test-1' })
    const wrapper = await mountBp()
    await veinButton(wrapper).trigger('click')
    await flush(wrapper)
    latestBloodPressure.value = { systolic: 120, diastolic: 80, measuredAt: new Date('2026-10-20T01:00:00.000Z') }
    await flush(wrapper)
    expect(startMeasurementMock).toHaveBeenCalledWith('emp-vein-1')
    expect(wrapper.text()).toContain('測定完了')
    wrapper.unmount()
  })

  it('★ 読んでいる間は機体を使用中・リロード不可。多重に押しても 1 回だけ。測定へ進むまで外れない', async () => {
    let captured!: (chara: string) => void
    vein.capture.mockImplementation(() => new Promise((resolve) => { captured = resolve }))
    let identified!: (o: unknown) => void
    veinIdentify.identifyVeinEmployee.mockImplementation(() => new Promise((resolve) => { identified = resolve }))
    const wrapper = await mountBp()
    const { isDeviceBusy } = useKioskScreen()
    expect(isDeviceBusy.value).toBe(false)
    expect(readReloadContext().safe).toBe(1)

    await veinButton(wrapper).trigger('click')
    await flush(wrapper)
    expect(veinButton(wrapper).text()).toBe('指を置いてください…')
    expect(veinButton(wrapper).attributes('disabled')).toBeDefined()
    expect(isDeviceBusy.value).toBe(true)
    expect(readReloadContext().safe).toBe(0)

    // disabled を越えて届いても 2 回目は走らない
    await (wrapper.vm as unknown as { $: { setupState: { vein: { identify: () => Promise<void> } } } }).$.setupState.vein.identify()
    expect(vein.capture).toHaveBeenCalledTimes(1)

    captured('chara-hex')
    await flush(wrapper)
    // 照合の応答待ち: まだ最初の段だが使用中のまま
    expect(wrapper.find('[data-testid="bp-entry"]').exists()).toBe(true)
    expect(isDeviceBusy.value).toBe(true)
    expect(readReloadContext().safe).toBe(0)

    identified({ kind: 'hit', employee: { id: 'emp-vein-1', name: 'テスト花子', face_approval_status: 'approved' } })
    await flush(wrapper)
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
    expect(isDeviceBusy.value).toBe(true)
    expect(readReloadContext().safe).toBe(0)
    wrapper.unmount()
  })

  it('マウント時に照合データを取り、次の人を待つ段に戻ったら古ければ取り直す', async () => {
    latestBloodPressure.value = null
    startMeasurementMock.mockResolvedValue({ id: 'meas-test-1' })
    updateMeasurementMock.mockResolvedValue({ id: 'meas-test-1' })
    const wrapper = await mountBp()
    expect(veinIdentify.syncVeinTemplates).toHaveBeenCalledTimes(1)
    expect(veinIdentify.syncVeinTemplates).toHaveBeenLastCalledWith({ module: undefined })

    await veinButton(wrapper).trigger('click')
    await flush(wrapper)
    latestBloodPressure.value = { systolic: 120, diastolic: 80, measuredAt: new Date('2026-10-20T01:00:00.000Z') }
    await flush(wrapper)
    expect(veinIdentify.syncVeinTemplates).toHaveBeenCalledTimes(1)

    await wrapper.findAll('button').find(b => b.text() === '次の人へ')!.trigger('click')
    await flush(wrapper)
    expect(veinIdentify.syncVeinTemplates).toHaveBeenCalledTimes(2)
    expect(veinIdentify.syncVeinTemplates).toHaveBeenLastCalledWith({ ifOlderThanMs: VEIN_TEMPLATE_SYNC_INTERVAL_MS, module: undefined })
    wrapper.unmount()
  })

  // 指が置かれた合図 (EVT VEIN FINGER) で、ボタンと同じ照合を始める (Refs ippoan/alc-app#436)
  describe('指の合図で照合を始める', () => {
    beforeEach(() => {
      finger.cb = null
      finger.off.mockClear()
    })

    it('★ 待機中なら「指を置いて」を鳴らさず読み取り、測定へ進む', async () => {
      const wrapper = await mountBp()
      finger.cb!()
      await flush(wrapper)

      expect(vein.say).not.toHaveBeenCalledWith('PLACE')
      expect(vein.capture).toHaveBeenCalledTimes(1)
      expect(veinIdentify.identifyVeinEmployee).toHaveBeenCalledWith('chara-hex')
      expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
      expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
      wrapper.unmount()
    })

    it('★ 完了の段 (保存済み) のまま指を置くと、前の人の結果を片付けて照合を始める', async () => {
      const wrapper = await mountBp()
      finger.cb!()
      await flush(wrapper)
      latestBloodPressure.value = { systolic: 124, diastolic: 78, pulse: 66, measuredAt: new Date('2026-09-16T01:02:03.000Z') }
      await flush(wrapper)
      expect(wrapper.text()).toContain('測定完了')
      vein.capture.mockClear()
      finger.cb!()
      await flush(wrapper)
      expect(vein.capture).toHaveBeenCalledTimes(1)
      expect(wrapper.text()).not.toContain('測定完了')
      expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
      wrapper.unmount()
    })

    it('外れ・読み取り失敗はボタンからと同じ文言を出す', async () => {
      veinIdentify.identifyVeinEmployee.mockResolvedValue({ kind: 'miss' })
      const wrapper = await mountBp()
      finger.cb!()
      await flush(wrapper)

      expect(veinErrorText(wrapper)).toBe('照合できませんでした。もう一度指を置いてください')
      expect(vein.say).toHaveBeenCalledWith('FAILED')
      wrapper.unmount()
    })

    it('最初の段でなければ始めない (測定中に指を置いても照合しない)', async () => {
      const wrapper = await mountBp()
      await identifyByFinger(wrapper)
      expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
      vein.capture.mockClear()
      finger.cb!()
      await flush(wrapper)

      expect(vein.capture).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('撮り直しで指を足している間は始めない (置くたびに合図が来る)', async () => {
      const wrapper = await mountBp()
      addAdding.value = true
      finger.cb!()
      await flush(wrapper)
      expect(vein.capture).not.toHaveBeenCalled()
      addAdding.value = false
      wrapper.unmount()
    })

    it('照合中は 2 回目を始めない', async () => {
      let captured!: (chara: string) => void
      vein.capture.mockImplementation(() => new Promise((resolve) => { captured = resolve }))
      const wrapper = await mountBp()
      finger.cb!()
      await flush(wrapper)
      finger.cb!()
      await flush(wrapper)
      expect(vein.capture).toHaveBeenCalledTimes(1)
      captured('chara-hex')
      await flush(wrapper)
      wrapper.unmount()
    })

    it('unmount で購読を解除する / ボタンは今までどおり「指を置いて」を鳴らす', async () => {
      const wrapper = await mountBp()
      expect(finger.off).not.toHaveBeenCalled()
      await veinButton(wrapper).trigger('click')
      await flush(wrapper)
      expect(vein.say).toHaveBeenCalledWith('PLACE')
      wrapper.unmount()
      expect(finger.off).toHaveBeenCalledTimes(1)
    })
  })

  describe('モジュール経路: 照合をモジュールに任せる (Refs ippoan/alc-app#436)', () => {
    beforeEach(() => {
      veinModule.usesVeinModule.mockReset().mockReturnValue(true)
      vein.identify.mockReset().mockResolvedValue(12)
      veinModule.identifyVeinModuleEmployee.mockReset().mockResolvedValue({
        kind: 'hit',
        employee: { id: 'emp-vein-1', name: 'テスト花子', face_approval_status: 'approved' },
      })
    })

    it('VEIN IDENTIFY の ID を対応表で引いて測定へ。読み取り (capture) とサーバー照合は使わない', async () => {
      const wrapper = await mountBp()
      await veinButton(wrapper).trigger('click')
      await flush(wrapper)
      expect(vein.identify).toHaveBeenCalledTimes(1)
      expect(veinModule.identifyVeinModuleEmployee).toHaveBeenCalledWith(12, undefined)
      expect(vein.capture).not.toHaveBeenCalled()
      expect(veinIdentify.identifyVeinEmployee).not.toHaveBeenCalled()
      expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
      expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
      wrapper.unmount()
    })

    it('★ モジュールが撮り直しを求めたら (onAgain)、ボタンを「もう一度置いてください…」にする', async () => {
      let finish: (id: number | null) => void = () => {}
      vein.identify.mockImplementationOnce((onAgain?: () => void) => new Promise((resolve) => {
        finish = resolve
        onAgain?.()
      }))
      const wrapper = await mountBp()
      await veinButton(wrapper).trigger('click')
      await flush(wrapper)
      expect(veinButton(wrapper).text()).toBe('もう一度置いてください…')
      finish(12)
      await flush(wrapper)
      wrapper.unmount()
    })

    it('★ 承認待ちの記録に当たったら、未承認と出して未承認の一覧へ案内する (名前が無ければ「この人」)', async () => {
      veinModule.identifyVeinModuleEmployee.mockResolvedValue({ kind: 'pending', employeeId: 'emp-new', name: '試験 新人' })
      const wrapper = await mountBp()
      await veinButton(wrapper).trigger('click')
      await flush(wrapper)
      expect(veinErrorText(wrapper)).toBe('試験 新人さんの指静脈は未承認です。下の「未承認の指静脈」から運行管理者が承認してください')
      veinModule.identifyVeinModuleEmployee.mockResolvedValue({ kind: 'pending', employeeId: 'emp-new', name: null })
      await veinButton(wrapper).trigger('click')
      await flush(wrapper)
      expect(veinErrorText(wrapper)).toContain('この人さんの指静脈は未承認です')
      wrapper.unmount()
    })

    it('不一致・読み取りの失敗は今と同じ文言', async () => {
      veinModule.identifyVeinModuleEmployee.mockResolvedValue({ kind: 'miss' })
      const wrapper = await mountBp()
      await veinButton(wrapper).trigger('click')
      await flush(wrapper)
      expect(veinErrorText(wrapper)).toContain('照合できませんでした')

      vein.identify.mockRejectedValue(new Error('NO_MODULE'))
      await veinButton(wrapper).trigger('click')
      await flush(wrapper)
      expect(veinErrorText(wrapper)).toBe('指静脈を読み取れませんでした (NO_MODULE)')
      wrapper.unmount()
    })

    it('同期にモジュールを渡し、Vein Station がつながったら揃える', async () => {
      veinIsConnected.value = false
      const wrapper = await mountBp()
      expect(veinIdentify.syncVeinTemplates).toHaveBeenLastCalledWith({ module: expect.objectContaining({ identify: vein.identify }) })
      veinIsConnected.value = true
      await flush(wrapper)
      expect(veinIdentify.syncVeinTemplates).toHaveBeenLastCalledWith({
        ifOlderThanMs: VEIN_TEMPLATE_SYNC_INTERVAL_MS,
        module: expect.objectContaining({ identify: vein.identify }),
      })
      // 抜けたときは何もしない (前のテストの画面も同じ ref を見ているので、回数は差分で見る)
      const before = veinIdentify.syncVeinTemplates.mock.calls.length
      veinIsConnected.value = false
      await flush(wrapper)
      expect(veinIdentify.syncVeinTemplates).toHaveBeenCalledTimes(before)
      wrapper.unmount()
    })
  })
})

// 指静脈が FP の層でだけ当たったときの「この端末で撮り直す」の提案。測定は止めない
describe('BloodPressureMeasurement — 指静脈が FP のときの撮り直しの提案', () => {
  const suggest = (w: Awaited<ReturnType<typeof mountBp>>) => w.find('[data-testid="vein-refresh-suggest"]')
  const accept = (w: Awaited<ReturnType<typeof mountBp>>) => w.find('[data-testid="vein-refresh-suggest-accept"]')

  beforeEach(() => {
    arrangeVein()
    bpUiState.value = 'show'
    veinLastMatch.value = null
    addDevice.add.mockReset().mockResolvedValue(true)
    addDevice.reset.mockClear()
    addAdding.value = false
    addAvailable.value = true
    addAdded.value = false
    addError.value = null
    addNotice.value = null
    veinModule.usesVeinModule.mockReturnValue(true)
    vein.say.mockReset().mockResolvedValue(undefined)
    vein.identify.mockReset().mockResolvedValue(12)
    veinModule.identifyVeinModuleEmployee.mockReset().mockResolvedValue({
      kind: 'hit',
      employee: { id: 'emp-vein-1', name: 'テスト花子', face_approval_status: 'approved' },
    })
    startMeasurementMock.mockReset()
    startMeasurementMock.mockResolvedValue({ id: 'meas-test-1' })
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    veinModule.usesVeinModule.mockReturnValue(false)
    veinIsConnected.value = false
    veinLastMatch.value = null
  })

  /** 指静脈ボタンで 1:N 照合する (照合の途中で機体が via を記録したことにする) */
  async function identifyWith(wrapper: Awaited<ReturnType<typeof mountBp>>, via: 'FV' | 'FP' | null) {
    vein.identify.mockImplementationOnce(async () => { veinLastMatch.value = { via }; return 12 })
    await wrapper.find('[data-testid="vein-identify"]').trigger('click')
    await flush(wrapper)
  }

  it('1:N が FP で当たったら、測定へ進んだうえで提案を出す。承認すると当たった人を測定台の鍵で足す', async () => {
    const wrapper = await mountBp()
    await identifyWith(wrapper, 'FP')
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
    expect(suggest(wrapper).text()).toContain('この端末で指を撮り直すと安定します')
    expect(console.info).toHaveBeenCalledWith('[vein] 撮り直しの提案 shown screen=bp')
    expect(addDevice.scope).toBe('default')
    await accept(wrapper).trigger('click')
    expect(addDevice.add).toHaveBeenCalledWith('emp-vein-1')
    expect(console.info).toHaveBeenCalledWith('[vein] 撮り直しの提案 accepted screen=bp')
    addAdded.value = true
    await flush(wrapper)
    expect(wrapper.find('[data-testid="vein-refresh-suggest-done"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('1:N が FV・via なしなら出さない', async () => {
    const wrapper = await mountBp()
    await identifyWith(wrapper, 'FV')
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
    expect(suggest(wrapper).exists()).toBe(false)
    wrapper.unmount()
    const old = await mountBp()
    await identifyWith(old, null)
    expect(suggest(old).exists()).toBe(false)
    old.unmount()
  })

  it('「あとで」で消え、測定はそのまま進められる。次の人 (やり直し) でも消える', async () => {
    const wrapper = await mountBp()
    await identifyWith(wrapper, 'FP')
    await wrapper.find('[data-testid="vein-refresh-suggest-dismiss"]').trigger('click')
    expect(suggest(wrapper).exists()).toBe(false)
    expect(console.info).toHaveBeenCalledWith('[vein] 撮り直しの提案 dismissed screen=bp')
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('BloodPressureMeasurement — この端末の指静脈の一覧 (Refs ippoan/alc-app#436)', () => {
  it('Vein Station がつながっているときだけ入口を出し、開いて閉じると入口へ戻る', async () => {
    bpUiState.value = 'show'
    veinIsConnected.value = false
    const off = await mountBp()
    expect(off.find('[data-testid="vein-module-list-open"]').exists()).toBe(false)
    off.unmount()
    veinIsConnected.value = true
    const w = await mountBp()
    await w.find('[data-testid="vein-module-list-open"]').trigger('click')
    await flush(w)
    expect(w.findComponent(VeinModuleListStub).exists()).toBe(true)
    await w.findComponent(VeinModuleListStub).vm.$emit('close')
    await flush(w)
    expect(w.findComponent(VeinModuleListStub).exists()).toBe(false)
    expect(w.find('[data-testid="bp-entry"]').exists()).toBe(true)
    w.unmount()
    veinIsConnected.value = false
  })
})

describe('BloodPressureMeasurement — 血圧計 (Bluetooth) の設定・ペアリング (Refs ippoan/alc-app#436)', () => {
  it('Vein Station がつながっているときだけ入口を出し、開いて閉じると入口へ戻る', async () => {
    bpUiState.value = 'show'
    veinIsConnected.value = false
    const off = await mountBp()
    expect(off.find('[data-testid="bp-ble-open"]').exists()).toBe(false)
    off.unmount()
    veinIsConnected.value = true
    const w = await mountBp()
    await w.find('[data-testid="bp-ble-open"]').trigger('click')
    await flush(w)
    expect(w.findComponent(BpBluetoothSettingsStub).exists()).toBe(true)
    await w.findComponent(BpBluetoothSettingsStub).vm.$emit('close')
    await flush(w)
    expect(w.findComponent(BpBluetoothSettingsStub).exists()).toBe(false)
    expect(w.find('[data-testid="bp-entry"]').exists()).toBe(true)
    w.unmount()
    veinIsConnected.value = false
  })
})

describe('BloodPressureMeasurement — 体温計の受信テスト', () => {
  it('Vein Station がつながっているときだけ入口を出し、開いて閉じると入口へ戻る', async () => {
    bpUiState.value = 'show'
    veinIsConnected.value = false
    const off = await mountBp()
    expect(off.find('[data-testid="thermo-test-open"]').exists()).toBe(false)
    off.unmount()
    veinIsConnected.value = true
    const w = await mountBp()
    await w.find('[data-testid="thermo-test-open"]').trigger('click')
    await flush(w)
    expect(w.findComponent(ThermoTestStub).exists()).toBe(true)
    await w.findComponent(ThermoTestStub).vm.$emit('close')
    await flush(w)
    expect(w.findComponent(ThermoTestStub).exists()).toBe(false)
    expect(w.find('[data-testid="bp-entry"]').exists()).toBe(true)
    w.unmount()
    veinIsConnected.value = false
  })
})

describe('BloodPressureMeasurement — 未承認の指静脈 (Refs ippoan/alc-app#436)', () => {
  it('Vein Station がつながっているときだけ入口を出し、開いて閉じると入口へ戻る', async () => {
    bpUiState.value = 'show'
    veinIsConnected.value = true
    const w = await mountBp()
    await w.find('[data-testid="vein-pending-open"]').trigger('click')
    await flush(w)
    expect(w.findComponent(VeinPendingApprovalStub).exists()).toBe(true)
    await w.findComponent(VeinPendingApprovalStub).vm.$emit('close')
    await flush(w)
    expect(w.findComponent(VeinPendingApprovalStub).exists()).toBe(false)
    expect(w.find('[data-testid="bp-entry"]').exists()).toBe(true)
    w.unmount()
    veinIsConnected.value = false
  })
})

describe('BloodPressureMeasurement — 指静脈の個体値の計測', () => {
  it('Vein Station がつながっているときに入口を出し、測定台の鍵で開いて、閉じると入口へ戻る', async () => {
    bpUiState.value = 'show'
    veinIsConnected.value = true
    const w = await mountBp()
    await w.find('[data-testid="vein-profile-open"]').trigger('click')
    await flush(w)
    const panel = w.findComponent(VeinDeviceProfileStub)
    expect(panel.exists()).toBe(true)
    expect(panel.props('scope')).toBe('bp-station')
    await panel.vm.$emit('close')
    await flush(w)
    expect(w.findComponent(VeinDeviceProfileStub).exists()).toBe(false)
    expect(w.find('[data-testid="bp-entry"]').exists()).toBe(true)
    w.unmount()
    veinIsConnected.value = false
  })
})

describe('BloodPressureMeasurement — カード・社員番号で人を選んでから指静脈を 1:1 で照合する', () => {
  const HANAKO = { id: 'emp-vein-1', name: 'テスト花子' }
  const TARO = { id: 'emp-card-2', name: 'テスト太郎' }

  beforeEach(() => {
    arrangeVein()
    bpUiState.value = 'show'
    latestBloodPressure.value = null
    veinModule.usesVeinModule.mockReset().mockReturnValue(false)
    getEmployeeByNfcIdMock.mockReset().mockResolvedValue(HANAKO)
    getEmployeeByCodeMock.mockReset().mockResolvedValue(HANAKO)
  })

  it('カードで選んだ人と指静脈が一致したら測定へ進む', async () => {
    const wrapper = await mountBp()
    await wrapper.findComponent(NfcStatusStub).vm.$emit('read', 'nfc-test-1')
    await flush(wrapper)
    expect(getEmployeeByNfcIdMock).toHaveBeenCalledWith('nfc-test-1')
    expect(vein.say).toHaveBeenCalledWith('PLACE')
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
    expect(wrapper.text()).toContain('テスト花子')
    wrapper.unmount()
  })

  describe('Vein Base で読んだ社員証 (`EVT TIMECARD`)', () => {
    const tap = async (wrapper: Awaited<ReturnType<typeof mountBp>>, name: string, args: string[]) => {
      hubCardHandler!(name, args, 'vein-station')
      await flush(wrapper)
    }
    beforeEach(() => {
      lookupEmployeeByCardMock.mockReset().mockResolvedValue(TARO)
      hubOffMock.mockClear()
    })

    it('★ 打刻と同じカードの台帳で引き、その人で 1:1 の照合へ進む', async () => {
      const wrapper = await mountBp()
      await tap(wrapper, 'TIMECARD', ['card_id=04a1b2c3', 'card_kind=nfca_uid'])
      expect(lookupEmployeeByCardMock).toHaveBeenCalledWith('04a1b2c3', 'bp-station')
      expect(wrapper.find('[data-testid="bp-expected"]').text()).toContain('テスト太郎さん')
      // 人を選んでいる間の 2 枚目は受けない
      await tap(wrapper, 'TIMECARD', ['card_id=04a1b2c4', 'card_kind=nfca_uid'])
      expect(lookupEmployeeByCardMock).toHaveBeenCalledTimes(1)
      wrapper.unmount()
      expect(hubOffMock).toHaveBeenCalledTimes(1)
    })

    it('免許証の行 (NfcStatus が受ける)・免許証の TIMECARD・知らない行は引かない。未登録は理由を出す', async () => {
      const wrapper = await mountBp()
      await tap(wrapper, 'NFC_LICENSE', ['issue=20230609', 'expiry=20280513'])
      await tap(wrapper, 'TIMECARD', ['card_id=2023060920280513', 'card_kind=license'])
      await tap(wrapper, 'FC1200', ['state=ready'])
      expect(lookupEmployeeByCardMock).not.toHaveBeenCalled()
      lookupEmployeeByCardMock.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))
      await tap(wrapper, 'TIMECARD', ['card_id=04a1b2c3', 'card_kind=felica_idm'])
      expect(wrapper.text()).toContain('この社員証は登録されていません')
      wrapper.unmount()
    })

    it('照会中・照合中・カードの入口が出ていない段では受けない', async () => {
      const wrapper = await mountBp()
      lookupEmployeeByCardMock.mockImplementationOnce(() => new Promise(() => {}))
      await tap(wrapper, 'TIMECARD', ['card_id=04a1b2c3', 'card_kind=nfca_uid'])
      await tap(wrapper, 'TIMECARD', ['card_id=04a1b2c4', 'card_kind=nfca_uid'])
      expect(lookupEmployeeByCardMock).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })
  })

  it('★ 指静脈が別の人なら測らず、選んだ人の名前で置き直させる。「別の人」で選び直せる', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(TARO)
    const wrapper = await mountBp()
    await wrapper.findComponent(NfcStatusStub).vm.$emit('read', 'nfc-test-2')
    await flush(wrapper)
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(false)
    expect(wrapper.find('[data-testid="vein-error"]').text()).toBe('テスト太郎さんの指静脈と一致しません。本人の指を置いてください')
    // 記録が無いのではないので、登録へは促さない
    expect(wrapper.find('[data-testid="bp-register-expected"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="bp-expected"]').text()).toContain('テスト太郎さん: 指を置いてください')
    // 選んでいる間はカード・社員番号の入口を隠す
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(false)

    await wrapper.find('[data-testid="bp-expected-clear"]').trigger('click')
    expect(wrapper.find('[data-testid="bp-expected"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="vein-error"]').exists()).toBe(false)
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    wrapper.unmount()
  })

  it('社員番号でも同じ (測定台の口で引く)', async () => {
    const wrapper = await mountBp()
    const keypad = wrapper.findComponent({ name: 'EmployeeCodeKeypad' })
    await keypad.vm.$emit('update:modelValue', '1234')
    expect(keypad.props('modelValue')).toBe('1234')
    await keypad.vm.$emit('submit', '1234')
    await flush(wrapper)
    expect(getEmployeeByCodeMock).toHaveBeenCalledWith('1234', 'bp-station')
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
    wrapper.unmount()
  })

  it('人が引けなければ理由を出し、指静脈は読まない。次の人へ戻すと消える', async () => {
    getEmployeeByNfcIdMock.mockRejectedValue(new Error('404'))
    const wrapper = await mountBp()
    await wrapper.findComponent(NfcStatusStub).vm.$emit('read', 'nfc-test-3')
    await flush(wrapper)
    expect(wrapper.find('[data-testid="bp-lookup-error"]').exists()).toBe(true)
    expect(vein.capture).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="bp-expected"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('★ 照会の応答待ちの間は、指の合図で照合を始めず、リロードもさせない', async () => {
    let resolveLookup: (v: typeof HANAKO) => void = () => {}
    getEmployeeByNfcIdMock.mockReturnValue(new Promise((r) => { resolveLookup = r }))
    const wrapper = await mountBp()
    expect(readReloadContext().safe).toBe(1)
    await wrapper.findComponent(NfcStatusStub).vm.$emit('read', 'nfc-test-4')
    expect(readReloadContext().safe).toBe(0)
    finger.cb?.()
    await flush(wrapper)
    expect(vein.capture).not.toHaveBeenCalled()
    resolveLookup(HANAKO)
    await flush(wrapper)
    expect(vein.capture).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
    wrapper.unmount()
  })

  describe('モジュール経路: その人の記録を用意して 1:1', () => {
    beforeEach(() => {
      veinModule.usesVeinModule.mockReturnValue(true)
      veinModule.prepareVeinModuleRecord.mockReset().mockResolvedValue(12)
      veinModule.matchVeinModuleEmployee.mockReset().mockResolvedValue({ id: 12, record: null })
      veinModule.identifyVeinModuleEmployee.mockReset().mockResolvedValue({ kind: 'hit', employee: { ...HANAKO, face_approval_status: 'approved' } })
    })

    it('選んだ人の記録をモジュールに用意し、その人で照合して測定へ', async () => {
      const wrapper = await mountBp()
      await wrapper.findComponent(NfcStatusStub).vm.$emit('read', 'nfc-test-5')
      await flush(wrapper)
      expect(veinModule.prepareVeinModuleRecord).toHaveBeenCalledWith(expect.anything(), 'emp-vein-1', undefined)
      expect(veinModule.matchVeinModuleEmployee.mock.calls[0]![1]).toBe('emp-vein-1')
      expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)
      wrapper.unmount()
    })

    it('承認済みの指静脈の記録が無ければ、登録して承認を受けるよう出し、測らない', async () => {
      veinModule.prepareVeinModuleRecord.mockResolvedValue(null)
      const wrapper = await mountBp()
      await wrapper.findComponent(NfcStatusStub).vm.$emit('read', 'nfc-test-6')
      await flush(wrapper)
      expect(wrapper.find('[data-testid="vein-error"]').text()).toBe('この人の承認済みの指静脈の記録がありません。登録して運行管理者の承認を受けてください')
      expect(wrapper.findComponent(BleStatusStub).exists()).toBe(false)

      // その人で登録画面を開く (カード・社員番号を打ち直させない)。閉じると最初の段へ戻り、選んだ人は残らない
      const register = wrapper.find('[data-testid="bp-register-expected"]')
      expect(register.text()).toBe('テスト花子さんの指静脈を登録する')
      await register.trigger('click')
      expect(wrapper.findComponent(VeinRegistrationStub).props('employee')).toEqual(HANAKO)
      await wrapper.findComponent(VeinRegistrationStub).vm.$emit('close')
      expect(wrapper.find('[data-testid="bp-entry"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="bp-expected"]').exists()).toBe(false)
      // 最初の段の入口から開くときは人を決めない
      await wrapper.findAll('button').find(b => b.text() === '指静脈を登録する')!.trigger('click')
      expect(wrapper.findComponent(VeinRegistrationStub).props('employee')).toBeNull()
      wrapper.unmount()
    })
  })
})
