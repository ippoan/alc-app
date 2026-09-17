import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly, defineComponent } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import NormalMeasurement from '~/components/NormalMeasurement.vue'
import { employeeNotFoundByNfc } from '~/utils/employee-lookup-messages'
import { updateMeasurement, startMeasurement } from '~/utils/api'

// --- API のモック (NFC → 乗務員照合だけを動かす) ---

const getEmployeeByNfcIdMock = vi.fn()
const getEmployeeByCodeMock = vi.fn()
// 免許証タッチの打刻 (Refs ippoan/alc-app-s3#135)。既定は成功
const punchTimecardMock = vi.fn(async () => {})
const checkFaceApprovalMock = vi.fn(() => null)
// vehicle 段の照合 (Refs ippoan/alc-app-s3#110)。既定は null (未登録扱い) — 個別のテストで差し替える
const lookupCarInspectionMock = vi.fn(async () => null as import('~/types').CarInspectionLookupResponse | null)

vi.mock('~/utils/api', () => ({
  getEmployeeByNfcId: (nfcId: string) => getEmployeeByNfcIdMock(nfcId),
  getEmployeeByCode: (code: string) => getEmployeeByCodeMock(code),
  punchTimecard: (cardId: string) => punchTimecardMock(cardId),
  startMeasurement: vi.fn(async () => ({ id: 'measurement-1' })),
  updateMeasurement: vi.fn(async () => ({})),
  uploadBlowVideo: vi.fn(async () => 'https://example.com/blow.webm'),
  lookupCarInspection: (certNo?: string, carId?: string) => lookupCarInspectionMock(certNo, carId),
}))

// 通常点呼は顔承認 gate を通さない (呼ばれないことを assert するためにモックする)
vi.mock('~/utils/face-approval', () => ({
  checkFaceApproval: (emp: unknown) => checkFaceApprovalMock(emp),
}))

vi.mock('~/utils/video-store', () => ({
  saveVideo: vi.fn(async () => 'video-1'),
  markVideoUploaded: vi.fn(async () => {}),
  getPendingVideos: vi.fn(async () => []),
  cleanupOldVideos: vi.fn(async () => {}),
}))

// --- composable のモック (測定フロー本体は動かさない) ---

mockNuxtImport('useDemoMode', () => () => ({
  isDemoMode: ref(false),
}))

// オフラインの打刻 (打たない) を見るテストがあるので、値を差し替えられる ref にしておく
const isOnlineRef = ref(true)
mockNuxtImport('useOfflineSync', () => () => ({
  isOnline: isOnlineRef,
  pending: ref(0),
  isSyncing: ref(false),
  save: vi.fn(),
  syncQueue: vi.fn(),
}))

const faceSyncMock = vi.fn(async () => {})
mockNuxtImport('useFaceSync', () => () => ({
  isSyncing: ref(false),
  sync: faceSyncMock,
}))

mockNuxtImport('useCamera', () => () => ({
  stream: ref(null),
  videoRef: ref(null),
  isActive: ref(false),
  start: vi.fn(async () => {}),
  stop: vi.fn(),
}))

mockNuxtImport('useVideoRecorder', () => () => ({
  isRecording: ref(false),
  startRecording: vi.fn(),
  stopRecording: vi.fn(async () => null),
}))

// record_as_tenko のテストで測定途中の温度 PUT を発火させたいので、値を差し替えられる ref にしておく
const bleTemperatureRef = ref<{ value: number; unit: 'celsius'; measuredAt: Date } | null>(null)
mockNuxtImport('useBleGateway', () => () => ({
  latestTemperature: readonly(bleTemperatureRef),
  latestBloodPressure: readonly(ref(null)),
}))

// PC の段を CoreS3 に送る口 (Refs #238)。ここでは呼ばれたかだけを見る
const syncStepMock = vi.fn()
const sendResultMock = vi.fn()
mockNuxtImport('useCoreS3Stage', () => () => ({
  syncStep: syncStepMock,
  sendResult: sendResultMock,
}))

// vehicle 段の NFC_CARINS 受け口 (Refs ippoan/alc-app-s3#135)。捕まえた handler に
// テストから直接イベントを流せるよう、onEvent の引数を carinsHandler に控える
let carinsHandler: ((name: string, args: string[]) => void) | null = null
const carinsOffMock = vi.fn()
mockNuxtImport('useCoreS3Serial', () => () => ({
  onEvent: (cb: (name: string, args: string[]) => void) => {
    carinsHandler = cb
    return carinsOffMock
  },
}))

// NfcStatus は表示と emit('read') だけなので、read を直接投げられるスタブに差し替える
// 段が進んで NfcStatus が消えた後に届くタップ (在庫の読み取りイベント) も流せるよう、
// emit の口を控えておく (Refs ippoan/alc-app-s3#135)
let emitNfcRead: ((nfcId: string, expiryDate?: Date) => void) | null = null
const NfcStatusStub = defineComponent({
  name: 'NfcStatus',
  emits: ['read'],
  setup(_props, { emit }) {
    emitNfcRead = (nfcId: string, expiryDate?: Date) => emit('read', nfcId, expiryDate)
  },
  template: '<div data-testid="nfc-stub" />',
})

// BleStatus / AlcMeasurement は composable への依存が重いので、emit だけ発火できるスタブに差し替える
const BleStatusStub = defineComponent({
  name: 'BleStatus',
  emits: ['skip', 'next'],
  template: '<div data-testid="ble-status-stub" />',
})
const AlcMeasurementStub = defineComponent({
  name: 'AlcMeasurement',
  emits: ['result', 'error', 'stateChange'],
  template: '<div data-testid="alc-measurement-stub" />',
})

const APPROVED_EMPLOYEE = { id: 'emp-1', name: '山田太郎', face_approval_status: 'approved' }

async function mountNfcStep() {
  const wrapper = await mountSuspended(NormalMeasurement, {
    global: { stubs: { NfcStatus: NfcStatusStub, BleStatus: true, ClientOnly: false, Teleport: true } },
  })
  return wrapper
}

/** NfcStatus の read を発火させ、onNfcRead の await を消化する */
async function touch(wrapper: Awaited<ReturnType<typeof mountNfcStep>>, nfcId: string) {
  wrapper.findComponent(NfcStatusStub).vm.$emit('read', nfcId)
  await new Promise(resolve => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
}

/** choice 段 (免許証タッチの直後) のボタンを押す */
async function chooseType(wrapper: Awaited<ReturnType<typeof mountNfcStep>>, testid: string) {
  await wrapper.find(`[data-testid="${testid}"]`).trigger('click')
  await wrapper.vm.$nextTick()
}

/**
 * NFC タッチ → 種別の選択 (始業点呼) まで進め、vehicle 段に入る。
 * 車検証の段を見る既存のテスト用 (choice を挟むようになった、Refs ippoan/alc-app-s3#135)
 */
async function touchToVehicle(wrapper: Awaited<ReturnType<typeof mountNfcStep>>, nfcId: string) {
  await touch(wrapper, nfcId)
  await chooseType(wrapper, 'choice-pre-operation')
}

/**
 * 今日から `days` 日ずらした "YYYY-MM-DD" (テストには合成値だけを使う)。
 * 「あと N 日 / N 日前」を固定値で確かめるため、期待値も同じ関数から作る
 */
function dateStrOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** パンくずの現在地 (青い丸) のラベル */
function activeStepLabel(wrapper: Awaited<ReturnType<typeof mountNfcStep>>): string | undefined {
  return wrapper.findAll('div.rounded-full').filter(d => d.classes('bg-blue-600'))[0]?.text()
}

/** vehicle 段のボタンを押して次 (medical) へ進める */
async function chooseVehicle(wrapper: Awaited<ReturnType<typeof mountNfcStep>>, testid: string) {
  await wrapper.find(`[data-testid="${testid}"]`).trigger('click')
  await wrapper.vm.$nextTick()
}

describe('NormalMeasurement — NFC ステップの乗務員照合', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 「端末未登録」の案内は index.vue の DeviceUnregisteredBanner 1 つに寄せた (Refs #238)。
  // 同じ画面に 2 本出ないよう、ここ (NormalMeasurement 内) の帯は削除済み — 表示条件の
  // テストは tests/components/DeviceUnregisteredBanner.test.ts へ移した。

  it('免許証が乗務員に未登録 (by-nfc が失敗) なら赤枠に理由と次の操作を出す', async () => {
    getEmployeeByNfcIdMock.mockRejectedValue(new Error('404'))
    const wrapper = await mountNfcStep()

    await touch(wrapper, '2601012901010')

    const alert = wrapper.find('.bg-red-50')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toBe(employeeNotFoundByNfc('2601012901010'))
    // 進まない
    expect(wrapper.text()).toContain('乗務員ID')
    wrapper.unmount()
  })

  it('乗務員が引ければ赤枠を出さずに次のステップへ進む', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountNfcStep()

    await touch(wrapper, '2601012901010')

    expect(wrapper.find('.bg-red-50').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('この免許証は乗務員に登録されていません')
    // NFC ステップを抜けている
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(false)
    expect(faceSyncMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('乗務員が引ければ顔認証を経ずに車検証ステップへ進む (Refs ippoan/alc-app-s3#135)', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountNfcStep()

    await touchToVehicle(wrapper, '2601012901010')

    // 現在ステップのパンくず (青) が「車検証」
    const active = wrapper.findAll('div.rounded-full').filter(d => d.classes('bg-blue-600'))
    expect(active).toHaveLength(1)
    expect(active[0]!.text()).toBe('車検証')
    expect(wrapper.text()).toContain('電子車検証をタップしてください')
    wrapper.unmount()
  })

  it('車検証ステップで [スキップ] を押すと体温ステップへ進む (血圧は隠す、Refs #238)', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountNfcStep()

    await touchToVehicle(wrapper, '2601012901010')
    await chooseVehicle(wrapper, 'vehicle-skip')

    // 現在ステップのパンくず (青) が「体温」(血圧は隠しているのでラベルからも落ちる)
    const active = wrapper.findAll('div.rounded-full').filter(d => d.classes('bg-blue-600'))
    expect(active).toHaveLength(1)
    expect(active[0]!.text()).toBe('体温')
    expect(wrapper.text()).toContain('体温')
    wrapper.unmount()
  })

  it('通常点呼では顔データの承認 gate を通さない', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue({ ...APPROVED_EMPLOYEE, face_approval_status: 'pending' })
    const wrapper = await mountNfcStep()

    await touch(wrapper, '2601012901010')

    expect(checkFaceApprovalMock).not.toHaveBeenCalled()
    expect(wrapper.find('.bg-red-50').exists()).toBe(false)
    wrapper.unmount()
  })

  // 種別を選ぶ前 (= アルコールチェックと同じ 'normal') は車検証の段を通らないので、
  // パンくずからも「車検証」が落ちる (Refs ippoan/alc-app-s3#135)
  it('パンくずに「顔認証」が無い', async () => {
    const wrapper = await mountNfcStep()

    const labels = wrapper.findAll('div.rounded-full').map(d => d.text())
    expect(labels).toEqual(['NFC', '体温', '測定', '結果'])
    wrapper.unmount()
  })

  it('赤枠は次のタッチで消える', async () => {
    getEmployeeByNfcIdMock.mockRejectedValueOnce(new Error('404'))
    const wrapper = await mountNfcStep()

    await touch(wrapper, '2601012901010')
    expect(wrapper.find('.bg-red-50').exists()).toBe(true)

    getEmployeeByNfcIdMock.mockResolvedValueOnce(APPROVED_EMPLOYEE)
    await touch(wrapper, '2701013001011')
    expect(wrapper.find('.bg-red-50').exists()).toBe(false)
    wrapper.unmount()
  })

  it('below-card slot の中身は「顔登録」「メンテナンス」のリンクより前 (画面上で上) に出る (Refs #238)', async () => {
    const wrapper = await mountSuspended(NormalMeasurement, {
      global: { stubs: { NfcStatus: NfcStatusStub, BleStatus: true, ClientOnly: false, Teleport: true } },
      slots: { 'below-card': '<div data-testid="below-card-content">打刻履歴スロット</div>' },
    })

    const html = wrapper.html()
    const slotIndex = html.indexOf('below-card-content')
    const linkIndex = html.indexOf('顔登録')
    expect(slotIndex).toBeGreaterThan(-1)
    expect(linkIndex).toBeGreaterThan(-1)
    expect(slotIndex).toBeLessThan(linkIndex)
    wrapper.unmount()
  })
})

describe('NormalMeasurement — PC の段を CoreS3 に送る (useCoreS3Stage、Refs #238)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function mountWithStubs() {
    return await mountSuspended(NormalMeasurement, {
      global: {
        stubs: {
          NfcStatus: NfcStatusStub,
          BleStatus: BleStatusStub,
          AlcMeasurement: AlcMeasurementStub,
          ClientOnly: false,
          Teleport: true,
        },
      },
    })
  }

  // watch(step, syncStep, { immediate: true }) は Vue の watch コールバック引数
  // (newValue, oldValue, onCleanup) をそのまま syncStep に渡すので、見るのは 1 番目の引数だけ
  function stepArgOf(call: unknown[]): unknown {
    return call[0]
  }

  it('mount 時 (nfc ステップ) に syncStep が呼ばれる', async () => {
    const wrapper = await mountWithStubs()
    expect(syncStepMock.mock.calls.map(stepArgOf)).toContain('nfc')
    wrapper.unmount()
  })

  it('ステップが変わるたびに syncStep が呼ばれる (nfc → choice → vehicle → medical → measuring)', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountWithStubs()

    await touch(wrapper, '2601012901010')
    expect(syncStepMock.mock.calls.map(stepArgOf)).toContain('choice')

    await chooseType(wrapper, 'choice-pre-operation')
    expect(syncStepMock.mock.calls.map(stepArgOf)).toContain('vehicle')

    await chooseVehicle(wrapper, 'vehicle-skip')
    expect(syncStepMock.mock.calls.map(stepArgOf)).toContain('medical')

    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()
    expect(syncStepMock.mock.calls.map(stepArgOf)).toContain('measuring')
    wrapper.unmount()
  })

  it('測定結果が出ると sendResult が呼ばれる', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountWithStubs()

    await touchToVehicle(wrapper, '2601012901010')
    await chooseVehicle(wrapper, 'vehicle-skip')
    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()

    const result = {
      employeeId: 'emp-1',
      alcoholValue: 0.1,
      resultType: 'normal',
      deviceUseCount: 1,
      measuredAt: new Date('2026-01-01'),
    }
    wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', result)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(sendResultMock).toHaveBeenCalledTimes(1)
    expect(sendResultMock.mock.calls[0]![0]).toMatchObject({ alcoholValue: 0.1, resultType: 'normal' })
    wrapper.unmount()
  })
})

describe('NormalMeasurement — 録画カメラプレビュー (v-show、Refs #238)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('測定ステップでは、カメラ未起動 (isActive: false) でも video 要素はマウント済み (v-show で隠れているだけ)', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountSuspended(NormalMeasurement, {
      global: {
        stubs: {
          NfcStatus: NfcStatusStub,
          BleStatus: BleStatusStub,
          AlcMeasurement: AlcMeasurementStub,
          ClientOnly: false,
          Teleport: true,
        },
      },
    })

    await touchToVehicle(wrapper, '2601012901010')
    await chooseVehicle(wrapper, 'vehicle-skip')
    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()

    // useCamera のモックは isActive: ref(false) なので、v-if だった頃はここで要素が消えていた
    expect(wrapper.find('video').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('NormalMeasurement — record_as_tenko (Refs #238)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    bleTemperatureRef.value = null
  })

  async function mountWithStubs() {
    return await mountSuspended(NormalMeasurement, {
      global: {
        stubs: {
          NfcStatus: NfcStatusStub,
          BleStatus: BleStatusStub,
          AlcMeasurement: AlcMeasurementStub,
          ClientOnly: false,
          Teleport: true,
        },
      },
    })
  }

  // 種別は choice の段で決まる (車検証の段では上書きしない、Refs ippoan/alc-app-s3#135)
  it('完了の PUT (measuring 終了時) には record_as_tenko: true と tenko_type: normal (アルコールチェック) が入る', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountWithStubs()

    await touch(wrapper, '2601012901010')
    await chooseType(wrapper, 'choice-alcohol')
    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()

    const result = {
      employeeId: 'emp-1',
      alcoholValue: 0.1,
      resultType: 'normal',
      deviceUseCount: 1,
      measuredAt: new Date('2026-01-01'),
    }
    wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', result)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const completedCall = vi.mocked(updateMeasurement).mock.calls.find(
      call => (call[1] as Record<string, unknown>).status === 'completed',
    )
    expect(completedCall).toBeDefined()
    expect(completedCall![0]).toBe('measurement-1')
    expect((completedCall![1] as Record<string, unknown>).record_as_tenko).toBe(true)
    expect((completedCall![1] as Record<string, unknown>).tenko_type).toBe('normal')
    wrapper.unmount()
  })

  // 始業は車検証の段を通り、終業はそのまま体温へ直行する (段は違っても種別は choice で決まる)
  it.each([
    ['choice-pre-operation', 'pre_operation', true],
    ['choice-post-operation', 'post_operation', false],
  ])('choice 段で %s を選ぶと完了の PUT の tenko_type が %s になる', async (testid, expected, viaVehicle) => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountWithStubs()

    await touch(wrapper, '2601012901010')
    await chooseType(wrapper, testid)
    if (viaVehicle) await chooseVehicle(wrapper, 'vehicle-skip')
    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()

    const result = {
      employeeId: 'emp-1',
      alcoholValue: 0.1,
      resultType: 'normal',
      deviceUseCount: 1,
      measuredAt: new Date('2026-01-01'),
    }
    wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', result)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const completedCall = vi.mocked(updateMeasurement).mock.calls.find(
      call => (call[1] as Record<string, unknown>).status === 'completed',
    )
    expect((completedCall![1] as Record<string, unknown>).tenko_type).toBe(expected)
    wrapper.unmount()
  })

  it('測定途中 (BLE 体温) の PUT には record_as_tenko も tenko_type も入らない', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountWithStubs()

    await touch(wrapper, '2601012901010')

    bleTemperatureRef.value = { value: 36.5, unit: 'celsius', measuredAt: new Date('2026-01-01') }
    await wrapper.vm.$nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(vi.mocked(updateMeasurement)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(updateMeasurement).mock.calls[0]![0]).toBe('measurement-1')
    const body = vi.mocked(updateMeasurement).mock.calls[0]![1] as Record<string, unknown>
    expect(body.temperature).toBe(36.5)
    expect(body).not.toHaveProperty('record_as_tenko')
    expect(body).not.toHaveProperty('tenko_type')
    wrapper.unmount()
  })
})

describe('NormalMeasurement — vehicle 段の NFC_CARINS 受け口 (番号を保持して段に留まる、Refs ippoan/alc-app-s3#110)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    carinsHandler = null
    lookupCarInspectionMock.mockResolvedValue(null)
  })

  async function mountWithStubs() {
    return await mountSuspended(NormalMeasurement, {
      global: {
        stubs: {
          NfcStatus: NfcStatusStub,
          BleStatus: BleStatusStub,
          AlcMeasurement: AlcMeasurementStub,
          ClientOnly: false,
          Teleport: true,
        },
      },
    })
  }

  it('mgno/carid を受けても段は vehicle のまま。番号で lookupCarInspection を呼ぶ', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountWithStubs()

    await touchToVehicle(wrapper, '2601012901010')
    expect(wrapper.text()).toContain('電子車検証をタップしてください')

    carinsHandler!('NFC_CARINS', ['mgno=000000000001', 'carid=TESTCARID00001'])
    await wrapper.vm.$nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    // 段は進まない (medical の見出しに切り替わらない)
    expect(wrapper.text()).toContain('電子車検証をタップしてください')
    expect(wrapper.text()).toContain('車検証: 読取済み')
    expect(lookupCarInspectionMock).toHaveBeenCalledWith('000000000001', 'TESTCARID00001')
    wrapper.unmount()
  })

  it('rc= (読み取り失敗) は再タップを促す文言を出し、lookupCarInspection を呼ばない', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountWithStubs()

    await touchToVehicle(wrapper, '2601012901010')
    carinsHandler!('NFC_CARINS', ['rc=timeout'])
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('読み取れませんでした')
    expect(wrapper.text()).toContain('もう一度タップしてください')
    expect(lookupCarInspectionMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('引数なし (旧 firmware) は番号なしのまま段に留まる', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountWithStubs()

    await touchToVehicle(wrapper, '2601012901010')
    carinsHandler!('NFC_CARINS', [])
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('電子車検証をタップしてください')
    expect(wrapper.text()).not.toContain('車検証: 読取済み')
    expect(lookupCarInspectionMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('lookupCarInspection が reject しても警告を出さず進める', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    lookupCarInspectionMock.mockRejectedValueOnce(new Error('network error'))
    const wrapper = await mountWithStubs()

    await touchToVehicle(wrapper, '2601012901010')
    carinsHandler!('NFC_CARINS', ['mgno=000000000001', 'carid=TESTCARID00001'])
    await wrapper.vm.$nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('車検証: 読取済み')
    expect(wrapper.text()).not.toContain('エラー')
    // [スキップ] で進める (点呼は止まらない)
    await chooseVehicle(wrapper, 'vehicle-skip')
    expect(wrapper.text()).toContain('体温')
    wrapper.unmount()
  })

  // 期限の帯は 5 通りのどれかを必ず 1 つ出す (以前は有効なときと期限が取れないときに
  // 何も出なかった。本番で 2 回報告、Refs ippoan/alc-app-s3#135)
  /** 車検証を読ませて期限の帯を取り出す */
  async function readCarinsBanner(wrapper: Awaited<ReturnType<typeof mountWithStubs>>) {
    await touchToVehicle(wrapper, '2601012901010')
    carinsHandler!('NFC_CARINS', ['mgno=000000000001', 'carid=TESTCARID00001'])
    await wrapper.vm.$nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()
    return wrapper.find('[data-testid="carins-expiry"]')
  }

  it('有効な車検の期限を日付と残り日数で緑に出す', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const validOn = dateStrOffset(247)
    lookupCarInspectionMock.mockResolvedValue({ expires_on: validOn, matched_by: 'cert_no', car_no: 'TEST-1' })
    const wrapper = await mountWithStubs()

    const banner = await readCarinsBanner(wrapper)

    expect(banner.text()).toBe(`車検: ${validOn.replace(/-/g, '/')} まで (あと 247 日)`)
    expect(banner.classes()).toContain('bg-green-50')
    wrapper.unmount()
  })

  it('期限切れの車検を日付と経過日数で赤に出す', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const expiredOn = dateStrOffset(-247)
    lookupCarInspectionMock.mockResolvedValue({ expires_on: expiredOn, matched_by: 'cert_no', car_no: null })
    const wrapper = await mountWithStubs()

    const banner = await readCarinsBanner(wrapper)

    expect(banner.text()).toBe(`車検の有効期限が切れています (${expiredOn.replace(/-/g, '/')}、247 日前)`)
    expect(banner.classes()).toContain('bg-red-50')
    wrapper.unmount()
  })

  it('期限間近の車検を黄で出す', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const soonOn = dateStrOffset(24)
    lookupCarInspectionMock.mockResolvedValue({ expires_on: soonOn, matched_by: 'car_id', car_no: 'TEST-1' })
    const wrapper = await mountWithStubs()

    const banner = await readCarinsBanner(wrapper)

    expect(banner.text()).toBe(`車検: ${soonOn.replace(/-/g, '/')} まで (あと 24 日)`)
    expect(banner.classes()).toContain('bg-amber-50')
    expect(wrapper.text()).toContain('登録番号 = TEST-1')
    wrapper.unmount()
  })

  it('照合は当たったが期限が取れないとき灰で出す', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    lookupCarInspectionMock.mockResolvedValue({ expires_on: null, matched_by: 'cert_no', car_no: 'TEST-1' })
    const wrapper = await mountWithStubs()

    const banner = await readCarinsBanner(wrapper)

    expect(banner.text()).toBe('車検の有効期限を取得できませんでした')
    expect(banner.classes()).toContain('bg-gray-50')
    wrapper.unmount()
  })

  it('matched_by が "none" (carins に無い車) は「車検証データ未登録」', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    lookupCarInspectionMock.mockResolvedValue({ expires_on: null, matched_by: 'none', car_no: null })
    const wrapper = await mountWithStubs()

    const banner = await readCarinsBanner(wrapper)

    expect(banner.text()).toBe('車検証データ未登録')
    expect(banner.classes()).toContain('bg-gray-50')
    wrapper.unmount()
  })

  it('始業で入った人が車検証をスキップしても tenko_type は pre_operation', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountSuspended(NormalMeasurement, {
      global: {
        stubs: { NfcStatus: NfcStatusStub, BleStatus: BleStatusStub, AlcMeasurement: AlcMeasurementStub, ClientOnly: false, Teleport: true },
      },
    })

    await touchToVehicle(wrapper, '2601012901010')
    carinsHandler!('NFC_CARINS', ['mgno=000000000001', 'carid=TESTCARID00001'])
    await wrapper.vm.$nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await chooseVehicle(wrapper, 'vehicle-skip')
    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()

    const result = {
      employeeId: 'emp-1', alcoholValue: 0.1, resultType: 'normal', deviceUseCount: 1, measuredAt: new Date('2026-01-01'),
    }
    wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', result)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const completedCall = vi.mocked(updateMeasurement).mock.calls.find(
      call => (call[1] as Record<string, unknown>).status === 'completed',
    )
    expect(completedCall).toBeDefined()
    expect((completedCall![1] as Record<string, unknown>).tenko_type).toBe('pre_operation')
    expect((completedCall![1] as Record<string, unknown>).carins_cert_no).toBe('000000000001')
    expect((completedCall![1] as Record<string, unknown>).carins_vehicle_id).toBe('TESTCARID00001')
    wrapper.unmount()
  })

  it('[スキップ] でも完了の PUT に carins の番号が乗る', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountSuspended(NormalMeasurement, {
      global: {
        stubs: { NfcStatus: NfcStatusStub, BleStatus: BleStatusStub, AlcMeasurement: AlcMeasurementStub, ClientOnly: false, Teleport: true },
      },
    })

    await touchToVehicle(wrapper, '2601012901010')
    carinsHandler!('NFC_CARINS', ['mgno=000000000001', 'carid=TESTCARID00001'])
    await wrapper.vm.$nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await chooseVehicle(wrapper, 'vehicle-skip')
    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()

    const result = {
      employeeId: 'emp-1', alcoholValue: 0.1, resultType: 'normal', deviceUseCount: 1, measuredAt: new Date('2026-01-01'),
    }
    wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', result)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const completedCall = vi.mocked(updateMeasurement).mock.calls.find(
      call => (call[1] as Record<string, unknown>).status === 'completed',
    )
    expect((completedCall![1] as Record<string, unknown>).carins_cert_no).toBe('000000000001')
    expect((completedCall![1] as Record<string, unknown>).carins_vehicle_id).toBe('TESTCARID00001')
    wrapper.unmount()
  })

  // 読めたら手で押さずに次の段へ進む (Refs ippoan/alc-app-s3#135)。
  // touch() が実タイマーの setTimeout(0) を使うので、偽タイマーは vehicle 段に入ってから被せる
  it('車検証を読んだら自動で体温へ進む', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    lookupCarInspectionMock.mockResolvedValue({ expires_on: dateStrOffset(247), matched_by: 'cert_no', car_no: 'TEST-1' })
    const wrapper = await mountWithStubs()
    await touchToVehicle(wrapper, '2601012901010')

    vi.useFakeTimers()
    try {
      carinsHandler!('NFC_CARINS', ['mgno=000000000001', 'carid=TESTCARID00001'])
      await vi.advanceTimersByTimeAsync(0)
      await wrapper.vm.$nextTick()

      // 期限の帯を読む時間があり、すぐには進まない
      expect(wrapper.text()).toContain('電子車検証をタップしてください')
      expect(wrapper.find('[data-testid="carins-expiry"]').exists()).toBe(true)

      await vi.advanceTimersByTimeAsync(1500)
      await wrapper.vm.$nextTick()

      expect(wrapper.text()).not.toContain('電子車検証をタップしてください')
      expect(activeStepLabel(wrapper)).toBe('体温')
    }
    finally {
      vi.useRealTimers()
    }
    wrapper.unmount()
  })

  it('読み取り失敗のときは自動で進まない', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountWithStubs()
    await touchToVehicle(wrapper, '2601012901010')

    vi.useFakeTimers()
    try {
      carinsHandler!('NFC_CARINS', ['rc=timeout'])
      await vi.advanceTimersByTimeAsync(5000)
      await wrapper.vm.$nextTick()

      expect(wrapper.text()).toContain('もう一度タップしてください')
      expect(activeStepLabel(wrapper)).toBe('車検証')
    }
    finally {
      vi.useRealTimers()
    }
    wrapper.unmount()
  })

  it('自動で進む前に段が変わってもタイマーが残らない', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    lookupCarInspectionMock.mockResolvedValue({ expires_on: dateStrOffset(247), matched_by: 'cert_no', car_no: 'TEST-1' })
    const wrapper = await mountWithStubs()
    await touchToVehicle(wrapper, '2601012901010')

    vi.useFakeTimers()
    try {
      carinsHandler!('NFC_CARINS', ['mgno=000000000001', 'carid=TESTCARID00001'])
      await vi.advanceTimersByTimeAsync(0)
      await wrapper.vm.$nextTick()

      // 自動で進む前に手で進め、さらに次の段 (測定) まで行く
      await chooseVehicle(wrapper, 'vehicle-skip')
      wrapper.findComponent(BleStatusStub).vm.$emit('skip')
      await wrapper.vm.$nextTick()
      expect(activeStepLabel(wrapper)).toBe('測定')

      // 残ったタイマーが発火すると測定から体温へ戻ってしまう
      await vi.advanceTimersByTimeAsync(5000)
      await wrapper.vm.$nextTick()
      expect(activeStepLabel(wrapper)).toBe('測定')
    }
    finally {
      vi.useRealTimers()
    }
    wrapper.unmount()
  })

  it('vehicle 以外の段で NFC_CARINS が来ても何も起きない', async () => {
    const wrapper = await mountNfcStep()

    carinsHandler!('NFC_CARINS', ['mgno=000000000001'])
    await wrapper.vm.$nextTick()

    // NFC ステップのまま
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(lookupCarInspectionMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('「最初からやり直す」(reset) で番号・表示が消える', async () => {
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountWithStubs()

    await touchToVehicle(wrapper, '2601012901010')
    carinsHandler!('NFC_CARINS', ['mgno=000000000001', 'carid=TESTCARID00001'])
    await wrapper.vm.$nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('車検証: 読取済み')

    const resetButton = wrapper.findAll('button').find(b => b.text() === '最初からやり直す')
    await resetButton!.trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(wrapper.text()).not.toContain('車検証: 読取済み')
    wrapper.unmount()
  })

  it('unmount で onEvent の解除が呼ばれる (解除は useCoreS3Serial.onEvent 側で検証済み)', async () => {
    const wrapper = await mountWithStubs()
    expect(carinsOffMock).not.toHaveBeenCalled()

    wrapper.unmount()

    expect(carinsOffMock).toHaveBeenCalledTimes(1)
  })
})

describe('NormalMeasurement — 打刻と種別の選択 (Refs ippoan/alc-app-s3#135)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOnlineRef.value = true
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
  })

  async function mountWithStubs() {
    return await mountSuspended(NormalMeasurement, {
      global: {
        stubs: {
          NfcStatus: NfcStatusStub,
          BleStatus: BleStatusStub,
          AlcMeasurement: AlcMeasurementStub,
          ClientOnly: false,
          Teleport: true,
        },
      },
    })
  }

  /** 段のガードを跨いで 2 回届くタップ (1 回目の応答を待たずに 2 回目が来る) */
  async function touchTwiceAtOnce(wrapper: Awaited<ReturnType<typeof mountNfcStep>>, nfcId: string) {
    const stub = wrapper.findComponent(NfcStatusStub)
    stub.vm.$emit('read', nfcId)
    stub.vm.$emit('read', nfcId)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()
  }

  it('免許証タッチで打刻し、種別の 3 ボタンを出す', async () => {
    const wrapper = await mountNfcStep()

    await touch(wrapper, '2601012901010')

    // 打刻は NFC の段から既存の打刻の口へ、NfcStatus が emit した生の値で飛ぶ
    expect(punchTimecardMock).toHaveBeenCalledTimes(1)
    expect(punchTimecardMock).toHaveBeenCalledWith('2601012901010')

    expect(wrapper.find('[data-testid="choice-alcohol"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="choice-pre-operation"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="choice-post-operation"]').exists()).toBe(true)

    // 打刻の結果と乗務員名を段の上に出す
    const done = wrapper.find('[data-testid="punch-done"]')
    expect(done.exists()).toBe(true)
    expect(done.text()).toMatch(/^打刻しました \d{2}:\d{2}$/)
    expect(wrapper.text()).toContain(APPROVED_EMPLOYEE.name)
    wrapper.unmount()
  })

  it('打刻が失敗しても種別選択へ進む', async () => {
    punchTimecardMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { punchFailure: 'failed', status: 500 }))
    const wrapper = await mountNfcStep()

    await touch(wrapper, '2601012901010')

    expect(wrapper.find('[data-testid="choice-alcohol"]').exists()).toBe(true)
    const failed = wrapper.find('[data-testid="punch-failed"]')
    expect(failed.exists()).toBe(true)
    expect(failed.text()).toBe('打刻に失敗しました (500)')
    expect(wrapper.find('[data-testid="punch-done"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('同じカードの連続タップで 2 回打刻しない', async () => {
    const wrapper = await mountNfcStep()

    await touchTwiceAtOnce(wrapper, '2601012901010')

    expect(punchTimecardMock).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="choice-alcohol"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('アルコールチェックは車検証の段を飛ばす', async () => {
    const wrapper = await mountWithStubs()

    await touch(wrapper, '2601012901010')
    await chooseType(wrapper, 'choice-alcohol')

    expect(wrapper.text()).not.toContain('電子車検証をタップしてください')
    // パンくずからも「車検証」が落ち、現在地は「体温」
    const labels = wrapper.findAll('div.rounded-full').map(d => d.text())
    expect(labels).toEqual(['NFC', '体温', '測定', '結果'])
    const active = wrapper.findAll('div.rounded-full').filter(d => d.classes('bg-blue-600'))
    expect(active).toHaveLength(1)
    expect(active[0]!.text()).toBe('体温')
    wrapper.unmount()
  })

  it('始業点呼を選ぶと完了 PUT の tenko_type が pre_operation', async () => {
    const wrapper = await mountWithStubs()

    await touch(wrapper, '2601012901010')
    await chooseType(wrapper, 'choice-pre-operation')
    // 車検証の段へ入る (アルコールチェックだけが飛ばす)
    expect(wrapper.text()).toContain('電子車検証をタップしてください')
    // 車検証の段には [スキップ] しか無い。種別は choice で決まっているので上書きされない
    await chooseVehicle(wrapper, 'vehicle-skip')

    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', {
      employeeId: 'emp-1',
      alcoholValue: 0,
      resultType: 'normal',
      deviceUseCount: 1,
      measuredAt: new Date('2026-01-01'),
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const completedCall = vi.mocked(updateMeasurement).mock.calls.find(
      call => (call[1] as Record<string, unknown>).status === 'completed',
    )
    expect((completedCall![1] as Record<string, unknown>).tenko_type).toBe('pre_operation')
    wrapper.unmount()
  })

  it('オフラインでは打刻せず、その旨を出す', async () => {
    isOnlineRef.value = false
    const wrapper = await mountNfcStep()

    await touch(wrapper, '2601012901010')

    expect(punchTimecardMock).not.toHaveBeenCalled()
    const skipped = wrapper.find('[data-testid="punch-skipped"]')
    expect(skipped.exists()).toBe(true)
    expect(skipped.text()).toBe('オフライン — 打刻は記録されません')
    // 打刻が無くても種別は選べる
    expect(wrapper.find('[data-testid="choice-alcohol"]').exists()).toBe(true)
    wrapper.unmount()
    isOnlineRef.value = true
  })

  it('手入力では打刻しない', async () => {
    getEmployeeByCodeMock.mockResolvedValue(APPROVED_EMPLOYEE)
    const wrapper = await mountNfcStep()

    const toManual = wrapper.findAll('button').find(b => b.text() === '手動でIDを入力する')
    await toManual!.trigger('click')
    await wrapper.find('input[type="text"]').setValue('0001')
    const next = wrapper.findAll('button').find(b => b.text() === '次へ')
    await next!.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(getEmployeeByCodeMock).toHaveBeenCalledWith('0001')
    expect(punchTimecardMock).not.toHaveBeenCalled()
    const skipped = wrapper.find('[data-testid="punch-skipped"]')
    expect(skipped.exists()).toBe(true)
    expect(skipped.text()).toBe('手入力では打刻されません')
    expect(wrapper.find('[data-testid="choice-alcohol"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('choice の段のタップは段を巻き戻さない', async () => {
    const wrapper = await mountNfcStep()

    await touch(wrapper, '2601012901010')
    expect(getEmployeeByNfcIdMock).toHaveBeenCalledTimes(1)

    // 種別を選ぶ前にもう一度タッチしても段は choice のまま (照合も打刻も走らない)。
    // NfcStatus は段を抜けた時点で消えているので、控えておいた emit 口から流す
    emitNfcRead!('2701013001011')
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(getEmployeeByNfcIdMock).toHaveBeenCalledTimes(1)
    expect(punchTimecardMock).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="choice-alcohol"]').exists()).toBe(true)
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(false)
    wrapper.unmount()
  })

  it('終業点呼を選ぶと車検証の段を飛ばして体温へ進む', async () => {
    const wrapper = await mountWithStubs()

    await touch(wrapper, '2601012901010')
    await chooseType(wrapper, 'choice-post-operation')

    // 終業に車検証は要らない (ユーザー判断) — 段も見出しも飛ばす。車検証へ進むのは始業だけ
    expect(wrapper.text()).not.toContain('電子車検証をタップしてください')
    const labels = wrapper.findAll('div.rounded-full').map(d => d.text())
    expect(labels).toEqual(['NFC', '体温', '測定', '結果'])
    const active = wrapper.findAll('div.rounded-full').filter(d => d.classes('bg-blue-600'))
    expect(active).toHaveLength(1)
    expect(active[0]!.text()).toBe('体温')
    wrapper.unmount()
  })

  it('終業点呼でも完了 PUT の tenko_type が post_operation', async () => {
    const wrapper = await mountWithStubs()

    await touch(wrapper, '2601012901010')
    await chooseType(wrapper, 'choice-post-operation')

    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', {
      employeeId: 'emp-1',
      alcoholValue: 0,
      resultType: 'normal',
      deviceUseCount: 1,
      measuredAt: new Date('2026-01-01'),
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    // 段を飛ばしても種別は残る
    const completedCall = vi.mocked(updateMeasurement).mock.calls.find(
      call => (call[1] as Record<string, unknown>).status === 'completed',
    )
    expect((completedCall![1] as Record<string, unknown>).tenko_type).toBe('post_operation')
    wrapper.unmount()
  })
})

describe('NormalMeasurement — 社員を指定して測定へ入る (IC カードの打刻から、Refs ippoan/rust-alc-api#644)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOnlineRef.value = true
    getEmployeeByNfcIdMock.mockResolvedValue(APPROVED_EMPLOYEE)
  })

  /** defineExpose した入口 (呼び出し元は index.vue の ref から呼ぶ) */
  function exposed(wrapper: Awaited<ReturnType<typeof mountNfcStep>>) {
    return wrapper.vm as unknown as {
      isIdle: boolean
      startForEmployee: (id: string, name: string) => Promise<boolean>
    }
  }

  // IC カードの打刻は免許証の確認を経ていないので、点呼 (始業/終業) には入れない。
  // 選択画面 (choice) を飛ばし、種別なし ('normal') の測定として体温の段へ直行する
  // (Refs ippoan/rust-alc-api#644)
  it('IC カードで始めると選択画面を飛ばして体温の段へ進む', async () => {
    const wrapper = await mountNfcStep()
    expect(exposed(wrapper).isIdle).toBe(true)

    const started = await exposed(wrapper).startForEmployee('emp-9', '佐藤花子')
    await wrapper.vm.$nextTick()

    expect(started).toBe(true)
    // IC カードの打刻はサーバ側で済んでいる — **二重打刻になるので打たない**
    expect(punchTimecardMock).not.toHaveBeenCalled()
    // 社員は打刻の行から分かっているので照合もしない
    expect(getEmployeeByNfcIdMock).not.toHaveBeenCalled()
    // 測定レコードと顔データ同期は免許証のタッチと同じように走る
    expect(vi.mocked(startMeasurement)).toHaveBeenCalledWith('emp-9')
    expect(faceSyncMock).toHaveBeenCalled()

    // 選択画面 (choice) を飛ばして体温 (medical) へ直行する — 始業/終業のボタンは出ない
    expect(wrapper.find('[data-testid="choice-alcohol"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="choice-pre-operation"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="choice-post-operation"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('体温')
    expect(wrapper.text()).toContain('佐藤花子')
    // 打刻の帯は出さない (この画面では打っていない)
    expect(wrapper.find('[data-testid="punch-done"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="punch-failed"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="punch-skipped"]').exists()).toBe(false)
    expect(exposed(wrapper).isIdle).toBe(false)
    wrapper.unmount()
  })

  it('IC カードで始めると点呼の種別は normal になる (完了の PUT に載る)', async () => {
    const wrapper = await mountSuspended(NormalMeasurement, {
      global: {
        stubs: {
          NfcStatus: NfcStatusStub,
          BleStatus: BleStatusStub,
          AlcMeasurement: AlcMeasurementStub,
          ClientOnly: false,
          Teleport: true,
        },
      },
    })

    await exposed(wrapper).startForEmployee('emp-9', '佐藤花子')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()

    const result = {
      employeeId: 'emp-9',
      alcoholValue: 0.1,
      resultType: 'normal',
      deviceUseCount: 1,
      measuredAt: new Date('2026-01-01'),
    }
    wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', result)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const completedCall = vi.mocked(updateMeasurement).mock.calls.find(
      call => (call[1] as Record<string, unknown>).status === 'completed',
    )
    expect(completedCall).toBeDefined()
    expect((completedCall![1] as Record<string, unknown>).record_as_tenko).toBe(true)
    expect((completedCall![1] as Record<string, unknown>).tenko_type).toBe('normal')
    wrapper.unmount()
  })

  it('待機中でないとき (測定中) に呼ばれても段は動かない — onNfcRead と同じガード', async () => {
    const wrapper = await mountNfcStep()
    await touch(wrapper, '2601012901010')
    expect(wrapper.text()).toContain('山田太郎')
    expect(exposed(wrapper).isIdle).toBe(false)

    const started = await exposed(wrapper).startForEmployee('emp-9', '佐藤花子')
    await wrapper.vm.$nextTick()

    expect(started).toBe(false)
    // 別人に差し替わらない (免許証でタッチした人のまま)
    expect(wrapper.text()).toContain('山田太郎')
    expect(wrapper.text()).not.toContain('佐藤花子')
    expect(vi.mocked(startMeasurement)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(startMeasurement)).toHaveBeenCalledWith('emp-1')
    wrapper.unmount()
  })
})
