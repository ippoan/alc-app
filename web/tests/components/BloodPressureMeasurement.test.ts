import type { BpUiState } from '~/composables/useBloodPressureSetting'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, computed } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import BloodPressureMeasurement from '~/components/BloodPressureMeasurement.vue'
import { BP_STATION_DEVICE_AUTH_FAILED_MESSAGE } from '~/utils/api'
import { readReloadContext, resetReloadContext, useKioskScreen } from '~/composables/useKioskScreen'
import { VEIN_TEMPLATE_SYNC_INTERVAL_MS } from '~/utils/vein-identify'

// 血圧だけを測る端末の画面 (Refs ippoan/alc-app-s3#135)。
// カードをかざす → 顔認証 → 血圧を測る → 完了 だけを行い、**点呼の記録は作らない**。
// 従業員はすべて合成値 (実在の乗務員名・カード番号は書かない)

const employee = ref<{ id: string, name: string, face_approval_status?: string }>({
  id: 'emp-test-1',
  name: 'テスト太郎',
  face_approval_status: 'approved',
})

// vi.mock はファイル先頭へ巻き上がるので、factory から触る mock は vi.hoisted で作る。
// 他の export (useAuth が使う rePairDevice 等) は本物のまま残す
const { startMeasurementMock, updateMeasurementMock, saveMeasurementMock, startTenkoSessionMock, getEmployeeByNfcIdMock }
  = vi.hoisted(() => ({
    startMeasurementMock: vi.fn(),
    updateMeasurementMock: vi.fn(),
    saveMeasurementMock: vi.fn(),
    startTenkoSessionMock: vi.fn(),
    getEmployeeByNfcIdMock: vi.fn(),
  }))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getEmployeeByNfcId: getEmployeeByNfcIdMock,
  startMeasurement: startMeasurementMock,
  updateMeasurement: updateMeasurementMock,
  saveMeasurement: saveMeasurementMock,
  startTenkoSession: startTenkoSessionMock,
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

// Vein Station がつながっているときだけ、カード待ちに指静脈登録の入口を出す (Refs ippoan/vein-match#20)。
// 乗務員の特定も指静脈が主 (Refs ippoan/alc-app#436)
const veinIsConnected = ref(false)
const veinConnect = vi.fn(async () => true)
// 指が置かれた合図 (EVT VEIN FINGER) の購読は、受けた cb を finger.fire で呼べるようにしておく
const finger = vi.hoisted(() => ({ cb: null as (() => void) | null, off: vi.fn() }))
const vein = vi.hoisted(() => ({
  isSupported: true,
  say: vi.fn(),
  capture: vi.fn(),
  onFingerPlaced: vi.fn((cb: () => void) => { finger.cb = cb; return finger.off }),
}))
mockNuxtImport('useVeinSerial', () => () => ({ ...vein, isConnected: veinIsConnected, connect: veinConnect }))

// 照合の振り分け (オンライン/オフライン) は vein-identify.test.ts の領分。ここでは結果だけを差し替える
const veinIdentify = vi.hoisted(() => ({
  identifyVeinEmployee: vi.fn(),
  syncVeinTemplates: vi.fn(),
}))
vi.mock('~/utils/vein-identify', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/vein-identify')>()),
  ...veinIdentify,
}))

const NfcStatusStub = { name: 'NfcStatus', template: '<div class="nfc-stub" />', emits: ['read'] }
const FaceAuthStub = { name: 'FaceAuth', template: '<div class="face-stub" />', emits: ['result'] }
const BleStatusStub = { name: 'BleStatus', template: '<div class="ble-stub" />', emits: ['next', 'skip'] }
const VeinRegistrationStub = { name: 'VeinRegistration', template: '<div class="vein-stub" />', emits: ['close'] }

function mountBp() {
  return mountSuspended(BloodPressureMeasurement, {
    shallow: true,
    global: { stubs: { NfcStatus: NfcStatusStub, FaceAuth: FaceAuthStub, BleStatus: BleStatusStub, VeinRegistration: VeinRegistrationStub } },
  })
}

/** 非同期の乗務員解決・保存を流し切る */
async function flush(wrapper: Awaited<ReturnType<typeof mountBp>>) {
  await new Promise(resolve => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
}

async function tapCard(wrapper: Awaited<ReturnType<typeof mountBp>>, nfcId = 'test-card-0001') {
  await wrapper.findComponent(NfcStatusStub).vm.$emit('read', nfcId)
  await flush(wrapper)
}

describe('BloodPressureMeasurement (Refs ippoan/alc-app-s3#135)', () => {
  beforeEach(() => {
    bpUiState.value = 'show'
    latestBloodPressure.value = null
    veinIsConnected.value = false
    employee.value = { id: 'emp-test-1', name: 'テスト太郎', face_approval_status: 'approved' }
    getEmployeeByNfcIdMock.mockReset()
    getEmployeeByNfcIdMock.mockImplementation(async () => employee.value)
    startMeasurementMock.mockReset()
    startMeasurementMock.mockResolvedValue({ id: 'meas-test-1' })
    updateMeasurementMock.mockReset()
    updateMeasurementMock.mockResolvedValue({ id: 'meas-test-1' })
    saveMeasurementMock.mockClear()
    startTenkoSessionMock.mockClear()
  })

  it('BloodPressureMeasurement — カード → 顔認証 → 血圧 の順に進む', async () => {
    const wrapper = await mountBp()

    // 1. カードをかざす段
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(false)

    // 2. カードを読むと顔認証へ
    await tapCard(wrapper)
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(false)
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(true)
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(false)
    expect(wrapper.text()).toContain('テスト太郎')

    // 3. 顔が通ると血圧測定へ
    await wrapper.findComponent(FaceAuthStub).vm.$emit('result', { verified: true, similarity: 0.9 })
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)

    wrapper.unmount()
  })

  it('BloodPressureMeasurement — カード待ちを離れている間だけ「機体を使用中」を申告する (Refs ippoan/alc-app#403)', async () => {
    const wrapper = await mountBp()
    const { isDeviceBusy } = useKioskScreen()
    expect(isDeviceBusy.value).toBe(false)

    await tapCard(wrapper)
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(true)
    expect(isDeviceBusy.value).toBe(true)

    wrapper.unmount()
    expect(isDeviceBusy.value).toBe(false)
  })

  it('BloodPressureMeasurement — 顔が未登録ならスキップできる', async () => {
    employee.value = { id: 'emp-test-2', name: 'テスト次郎', face_approval_status: 'none' }
    const wrapper = await mountBp()
    await tapCard(wrapper)

    // 未登録である事実と、スキップの口が出る (顔認証そのものは出さない)
    expect(wrapper.text()).toContain('顔データが未登録です')
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
    const skipBtn = wrapper.findAll('button').find(b => b.text() === '顔認証をスキップして進む')
    expect(skipBtn).toBeTruthy()

    // スキップすると血圧測定へ進む
    await skipBtn!.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)

    wrapper.unmount()
  })

  it('BloodPressureMeasurement — 顔が却下なら進めない', async () => {
    employee.value = { id: 'emp-test-3', name: 'テスト三郎', face_approval_status: 'rejected' }
    const wrapper = await mountBp()
    await tapCard(wrapper)

    // 却下は登録済みなので弾く — 顔認証の段にもスキップの口にも行かない
    expect(wrapper.text()).toContain('却下')
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
    expect(wrapper.findAll('button').find(b => b.text() === '顔認証をスキップして進む')).toBeFalsy()

    // 審査中 (pending) も同じく弾く
    employee.value = { id: 'emp-test-4', name: 'テスト四郎', face_approval_status: 'pending' }
    await tapCard(wrapper)
    expect(wrapper.text()).toContain('承認待ち')
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)

    wrapper.unmount()
  })

  it('BloodPressureMeasurement — 血圧が測れたら保存する', async () => {
    const wrapper = await mountBp()
    await tapCard(wrapper)
    await wrapper.findComponent(FaceAuthStub).vm.$emit('result', { verified: true, similarity: 0.9 })
    await wrapper.vm.$nextTick()

    const measuredAt = new Date('2026-09-16T01:02:03.000Z')
    latestBloodPressure.value = { systolic: 124, diastolic: 78, pulse: 66, measuredAt }
    await flush(wrapper)

    expect(startMeasurementMock).toHaveBeenCalledWith('emp-test-1')
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
    expect(wrapper.text()).toContain('124')
    expect(wrapper.text()).toContain('78')

    wrapper.unmount()
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
    await tapCard(wrapper)
    await wrapper.findComponent(FaceAuthStub).vm.$emit('result', { verified: true, similarity: 0.9 })
    await wrapper.vm.$nextTick()

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

// 本番 flip 後の新版への載せ替え (Refs ippoan/alc-app#387)。測定台はカードのタッチを待って開いた
// ままになるので、カード待ちの間は「いまリロードして失うものが無い」と申告する。
// 読むのは plugin と同じ口 (`readReloadContext`)
describe('BloodPressureMeasurement — 新版への載せ替えの申告 (Refs ippoan/alc-app#387)', () => {
  const safe = () => readReloadContext().safe

  beforeEach(() => {
    resetReloadContext()
    bpUiState.value = 'show'
    latestBloodPressure.value = null
    employee.value = { id: 'emp-test-1', name: 'テスト太郎', face_approval_status: 'approved' }
    getEmployeeByNfcIdMock.mockReset()
    getEmployeeByNfcIdMock.mockImplementation(async () => employee.value)
    startMeasurementMock.mockReset()
    startMeasurementMock.mockResolvedValue({ id: 'meas-test-1' })
    updateMeasurementMock.mockReset()
    updateMeasurementMock.mockResolvedValue({ id: 'meas-test-1' })
  })

  it('★ カード待ちの間は安全。画面を離れたら申告を残さない', async () => {
    const wrapper = await mountBp()
    expect(readReloadContext()).toEqual({ screen: null, safe: 1, blocked: 0 })

    wrapper.unmount()
    expect(readReloadContext()).toEqual({ screen: null, safe: 0, blocked: 0 })
  })

  it('★ カードの照合中は段が動かなくても外れ、進んだ先でも外れたまま。「次の人へ」で戻る', async () => {
    let found!: (emp: unknown) => void
    getEmployeeByNfcIdMock.mockImplementation(() => new Promise((resolve) => { found = resolve }))
    const wrapper = await mountBp()
    expect(safe()).toBe(1)

    // 照合の応答待ち: 画面はまだカード待ちのまま
    await wrapper.findComponent(NfcStatusStub).vm.$emit('read', 'test-card-0001')
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(safe()).toBe(0)

    found(employee.value)
    await flush(wrapper)
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(true)
    expect(safe()).toBe(0)

    await wrapper.findComponent(FaceAuthStub).vm.$emit('result', { verified: true, similarity: 0.9 })
    await wrapper.vm.$nextTick()
    expect(safe()).toBe(0)
    latestBloodPressure.value = { systolic: 130, diastolic: 84, measuredAt: new Date('2026-09-16T02:00:00.000Z') }
    await flush(wrapper)
    expect(wrapper.text()).toContain('測定完了')
    expect(safe()).toBe(0)

    await wrapper.findAll('button').find(b => b.text() === '次の人へ')!.trigger('click')
    expect(safe()).toBe(1)
    wrapper.unmount()
  })

  it('測定台の鍵が取れなかった失敗は「未登録」にせず、その文言をそのまま出す (Refs #436)', async () => {
    getEmployeeByNfcIdMock.mockRejectedValue(new Error(BP_STATION_DEVICE_AUTH_FAILED_MESSAGE))
    const wrapper = await mountBp()

    await tapCard(wrapper)
    expect(wrapper.text()).toContain(BP_STATION_DEVICE_AUTH_FAILED_MESSAGE)
    expect(wrapper.text()).not.toContain('登録されていません')
    wrapper.unmount()
  })

  it('★ 照合が失敗で終わっても、照合中の印は戻る', async () => {
    let fail!: (e: unknown) => void
    getEmployeeByNfcIdMock.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    const wrapper = await mountBp()

    await wrapper.findComponent(NfcStatusStub).vm.$emit('read', 'test-card-0001')
    expect(safe()).toBe(0)
    fail(new Error('not found'))
    await flush(wrapper)
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(safe()).toBe(1)
    wrapper.unmount()
  })

  it('★ 顔の審査で弾かれてカード待ちに残ったときも、照合中の印は戻る', async () => {
    employee.value = { id: 'emp-test-1', name: 'テスト太郎', face_approval_status: 'rejected' }
    const wrapper = await mountBp()

    await tapCard(wrapper)
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(safe()).toBe(1)
    wrapper.unmount()
  })

  it('★ 2 回目のタッチが 1 回目の応答より先に終わっても、1 回目を待っている間は外れたまま', async () => {
    const resolvers: Array<(emp: unknown) => void> = []
    const rejecters: Array<(e: unknown) => void> = []
    getEmployeeByNfcIdMock.mockImplementation(() => new Promise((resolve, reject) => {
      resolvers.push(resolve)
      rejecters.push(reject)
    }))
    const wrapper = await mountBp()

    await wrapper.findComponent(NfcStatusStub).vm.$emit('read', 'test-card-0001')
    await wrapper.findComponent(NfcStatusStub).vm.$emit('read', 'test-card-0002')
    expect(resolvers).toHaveLength(2)
    rejecters[1]!(new Error('not found'))
    await flush(wrapper)
    expect(safe()).toBe(0)

    rejecters[0]!(new Error('not found'))
    await flush(wrapper)
    expect(safe()).toBe(1)
    wrapper.unmount()
  })

  describe('指静脈の登録 (Refs ippoan/vein-match#20)', () => {
    const veinEntry = (w: Awaited<ReturnType<typeof mountBp>>) =>
      w.findAll('button').find(b => b.text().includes('指静脈を登録する'))

    it('マウント時に Vein Station へ接続しにいく。つながっていなければ入口を出さない', async () => {
      const wrapper = await mountBp()
      expect(veinConnect).toHaveBeenCalled()
      expect(veinEntry(wrapper)).toBeUndefined()
    })

    it('つながっていればカード待ちに入口を出し、押すと登録画面 → 戻るでカード待ち', async () => {
      veinIsConnected.value = true
      resetReloadContext()
      const wrapper = await mountBp()
      expect(readReloadContext().safe).toBe(1)
      await veinEntry(wrapper)!.trigger('click')
      expect(wrapper.findComponent(VeinRegistrationStub).exists()).toBe(true)
      expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(false)
      expect(veinEntry(wrapper)).toBeUndefined()
      // 登録中はリロードしてよいと申告しない (カード待ちの段だけが安全)
      expect(readReloadContext().safe).toBe(0)
      await wrapper.findComponent(VeinRegistrationStub).vm.$emit('close')
      expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
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

// 乗務員の特定は指静脈が主、カードは予備 (Refs ippoan/alc-app#436)。手順は TenkoKiosk の指静脈と同じ
describe('BloodPressureMeasurement — 指静脈で乗務員を特定する (Refs ippoan/alc-app#436)', () => {
  const veinButton = (w: Awaited<ReturnType<typeof mountBp>>) => w.find('[data-testid="vein-identify"]')
  const veinErrorText = (w: Awaited<ReturnType<typeof mountBp>>) => w.find('[data-testid="vein-error"]').text()

  beforeEach(() => {
    resetReloadContext()
    bpUiState.value = 'show'
    latestBloodPressure.value = null
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
    getEmployeeByNfcIdMock.mockReset()
  })

  it('つながっていれば指の欄をカードより上に出す', async () => {
    const wrapper = await mountBp()
    const html = wrapper.html()
    expect(veinButton(wrapper).text()).toBe('指を置いて照合')
    expect(wrapper.text()).toContain('カードで進む')
    // 並び: 指 → カード → 登録の入口
    expect(html.indexOf('vein-identify')).toBeLessThan(html.indexOf('nfc-stub'))
    expect(html.indexOf('nfc-stub')).toBeLessThan(html.indexOf('指静脈を登録する'))
    wrapper.unmount()
  })

  it.each([
    ['つながっていない', () => { veinIsConnected.value = false }],
    ['WebSerial が無い', () => { vein.isSupported = false }],
  ])('%s端末では指の欄を出さず、カードだけ', async (_label, arrange) => {
    arrange()
    const wrapper = await mountBp()
    expect(veinButton(wrapper).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('カードで進む')
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    wrapper.unmount()
  })

  it('当たれば顔認証へ進み、名前が出る。案内 → 読み取りの順で送る', async () => {
    const wrapper = await mountBp()
    await veinButton(wrapper).trigger('click')
    await flush(wrapper)

    expect(vein.say).toHaveBeenCalledWith('PLACE')
    expect(vein.say.mock.invocationCallOrder[0]).toBeLessThan(vein.capture.mock.invocationCallOrder[0]!)
    expect(veinIdentify.identifyVeinEmployee).toHaveBeenCalledWith('chara-hex')
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(true)
    expect(wrapper.text()).toContain('テスト花子')
    expect(vein.say).not.toHaveBeenCalledWith('FAILED')
    wrapper.unmount()
  })

  it('外れたら「下のカードで進む」を案内し、カード待ちに残る', async () => {
    veinIdentify.identifyVeinEmployee.mockResolvedValue({ kind: 'miss' })
    const wrapper = await mountBp()
    await veinButton(wrapper).trigger('click')
    await flush(wrapper)

    expect(veinErrorText(wrapper)).toBe('照合できませんでした。もう一度置くか、下のカードで進んでください')
    // 開発者向けの語 (社員番号の入口はこの画面に無い) を出さない
    expect(wrapper.text()).not.toContain('社員番号')
    expect(vein.say).toHaveBeenCalledWith('FAILED')
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
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

  it('顔の審査で弾かれたらカードと同じく上に理由を出し、カード待ちに残る', async () => {
    veinIdentify.identifyVeinEmployee.mockResolvedValue({
      kind: 'hit',
      employee: { id: 'emp-vein-2', name: 'テスト五郎', face_approval_status: 'rejected' },
    })
    const wrapper = await mountBp()
    await veinButton(wrapper).trigger('click')
    await flush(wrapper)
    expect(wrapper.text()).toContain('却下')
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
    expect(wrapper.find('[data-testid="vein-error"]').exists()).toBe(false)
    expect(readReloadContext().safe).toBe(1)
    wrapper.unmount()
  })

  it('★ 読んでいる間は機体を使用中・リロード不可。多重に押しても 1 回だけ。顔認証へ進むまで外れない', async () => {
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
    await (wrapper.vm as unknown as { $: { setupState: { onVeinIdentify: () => Promise<void> } } }).$.setupState.onVeinIdentify()
    expect(vein.capture).toHaveBeenCalledTimes(1)

    captured('chara-hex')
    await flush(wrapper)
    // 照合の応答待ち: まだカード待ちの段だが使用中のまま
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(isDeviceBusy.value).toBe(true)
    expect(readReloadContext().safe).toBe(0)

    identified({ kind: 'hit', employee: { id: 'emp-vein-1', name: 'テスト花子', face_approval_status: 'approved' } })
    await flush(wrapper)
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(true)
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
    expect(veinIdentify.syncVeinTemplates).toHaveBeenLastCalledWith()

    await veinButton(wrapper).trigger('click')
    await flush(wrapper)
    await wrapper.findComponent(FaceAuthStub).vm.$emit('result', { verified: true, similarity: 0.9 })
    await wrapper.vm.$nextTick()
    latestBloodPressure.value = { systolic: 120, diastolic: 80, measuredAt: new Date('2026-10-20T01:00:00.000Z') }
    await flush(wrapper)
    expect(veinIdentify.syncVeinTemplates).toHaveBeenCalledTimes(1)

    await wrapper.findAll('button').find(b => b.text() === '次の人へ')!.trigger('click')
    await flush(wrapper)
    expect(veinIdentify.syncVeinTemplates).toHaveBeenCalledTimes(2)
    expect(veinIdentify.syncVeinTemplates).toHaveBeenLastCalledWith({ ifOlderThanMs: VEIN_TEMPLATE_SYNC_INTERVAL_MS })
    wrapper.unmount()
  })

  // 指が置かれた合図 (EVT VEIN FINGER) で、ボタンと同じ照合を始める (Refs ippoan/alc-app#436)
  describe('指の合図で照合を始める', () => {
    beforeEach(() => {
      finger.cb = null
      finger.off.mockClear()
      getEmployeeByNfcIdMock.mockReset()
      getEmployeeByNfcIdMock.mockImplementation(async () => employee.value)
    })

    it('★ 待機中なら「指を置いて」を鳴らさず読み取り、顔認証へ進む', async () => {
      const wrapper = await mountBp()
      finger.cb!()
      await flush(wrapper)

      expect(vein.say).not.toHaveBeenCalledWith('PLACE')
      expect(vein.capture).toHaveBeenCalledTimes(1)
      expect(veinIdentify.identifyVeinEmployee).toHaveBeenCalledWith('chara-hex')
      expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(true)
      wrapper.unmount()
    })

    it('外れ・読み取り失敗はボタンからと同じ文言を出す', async () => {
      veinIdentify.identifyVeinEmployee.mockResolvedValue({ kind: 'miss' })
      const wrapper = await mountBp()
      finger.cb!()
      await flush(wrapper)

      expect(veinErrorText(wrapper)).toBe('照合できませんでした。もう一度置くか、下のカードで進んでください')
      expect(vein.say).toHaveBeenCalledWith('FAILED')
      wrapper.unmount()
    })

    it('カード待ちの段でなければ始めない', async () => {
      const wrapper = await mountBp()
      await tapCard(wrapper)
      expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(true)
      finger.cb!()
      await flush(wrapper)

      expect(vein.capture).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('照合中・カードの照会中は 2 回目を始めない', async () => {
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

      let resolveEmp!: (e: unknown) => void
      getEmployeeByNfcIdMock.mockImplementation(() => new Promise((resolve) => { resolveEmp = resolve }))
      vein.capture.mockReset()
      vein.capture.mockResolvedValue('chara-hex')
      const second = await mountBp()
      void second.findComponent(NfcStatusStub).vm.$emit('read', 'test-card-0001')
      await second.vm.$nextTick()
      finger.cb!()
      await flush(second)
      expect(vein.capture).not.toHaveBeenCalled()
      resolveEmp(employee.value)
      await flush(second)
      second.unmount()
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
})
