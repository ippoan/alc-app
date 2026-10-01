import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, readonly, defineComponent } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import NormalMeasurement from '~/components/NormalMeasurement.vue'

// 通常点呼の中で IT点呼 を選ぶ段 (`itSelectable`) と、**`itSelectable` を付けない通常点呼が
// 今までと変わらないこと**を固定する (Refs ippoan/alc-app#387)。alc-app は main へのマージから
// 数分で本番に出るので、「印が無い端末 = `itSelectable` なし」の挙動 (送る body・通信の本数・
// 画面) をここで釘付けにする。モックと stub は NormalMeasurement.itMode.test.ts と同じ形。
// 既存の NormalMeasurement.test.ts / NormalMeasurement.itMode.test.ts は 1 行も書き換えていない。

// --- API のモック ---

const getEmployeeByNfcIdMock = vi.fn()
const getEmployeeByCodeMock = vi.fn()
const punchTimecardMock = vi.fn(async () => {})
const startMeasurementMock = vi.fn(async () => ({ id: 'measurement-1' }))
const updateMeasurementMock = vi.fn()

vi.mock('~/utils/api', () => ({
  getEmployeeByNfcId: (nfcId: string) => getEmployeeByNfcIdMock(nfcId),
  getEmployeeByCode: (code: string) => getEmployeeByCodeMock(code),
  punchTimecard: (cardId: string) => punchTimecardMock(cardId),
  startMeasurement: (employeeId: string) => startMeasurementMock(employeeId),
  updateMeasurement: (id: string, data: Record<string, unknown>) => updateMeasurementMock(id, data),
  uploadBlowVideo: vi.fn(async () => 'https://example.com/blow.webm'),
  lookupCarInspection: vi.fn(async () => null),
}))

vi.mock('~/utils/video-store', () => ({
  saveVideo: vi.fn(async () => 'video-1'),
  markVideoUploaded: vi.fn(async () => {}),
  getPendingVideos: vi.fn(async () => []),
  cleanupOldVideos: vi.fn(async () => {}),
}))

// --- composable のモック ---

const demoModeRef = ref(false)
mockNuxtImport('useDemoMode', () => () => ({ isDemoMode: demoModeRef }))

const isOnlineRef = ref(true)
const offlineSaveMock = vi.fn(async (..._args: unknown[]) => 'queued' as const)
mockNuxtImport('useOfflineSync', () => () => ({
  isOnline: isOnlineRef,
  pending: ref(0),
  isSyncing: ref(false),
  save: offlineSaveMock,
  syncQueue: vi.fn(),
}))

mockNuxtImport('useFaceSync', () => () => ({ isSyncing: ref(false), sync: vi.fn(async () => {}) }))

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

mockNuxtImport('useBleGateway', () => () => ({
  latestTemperature: readonly(ref(null)),
  latestBloodPressure: readonly(ref(null)),
  hasBpHardware: readonly(ref(false)),
}))
mockNuxtImport('useBpUiEnabled', () => () => ({ bpUiState: ref('unused'), showBpUi: ref(false) }))
mockNuxtImport('useStrayAlcohol', () => () => ({ latest: readonly(ref(null)) }))
mockNuxtImport('useCoreS3Stage', () => () => ({ syncStep: vi.fn(), sendResult: vi.fn() }))
mockNuxtImport('useCoreS3Serial', () => () => ({ onEvent: () => () => {} }))

// IT点呼 の通話。**生成されたか**と、渡された点呼の記録の id を見る
type CallState = 'idle' | 'connecting' | 'calling' | 'judged' | 'unavailable'
const itCall = {
  state: ref<CallState>('idle'),
  judgment: ref<{ judgment: 'ok' | 'ng', reason: string | null } | null>(null),
  isDisconnected: ref(false),
  error: ref<string | null>(null),
  start: vi.fn(async (_id: string) => { itCall.state.value = 'calling' }),
  reconnect: vi.fn(async () => {}),
  stop: vi.fn(() => {
    itCall.state.value = 'idle'
    itCall.judgment.value = null
  }),
}
const useItTenkoCallSpy = vi.fn()
mockNuxtImport('useItTenkoCall', () => () => {
  useItTenkoCallSpy()
  return {
    state: itCall.state,
    judgment: itCall.judgment,
    localStream: ref(null),
    remoteStream: ref(null),
    isConnected: ref(false),
    isPeerConnected: ref(false),
    isDisconnected: itCall.isDisconnected,
    error: itCall.error,
    start: itCall.start,
    reconnect: itCall.reconnect,
    stop: itCall.stop,
  }
})
// 通常点呼の画面が通話の層を直接作っていないことも見る
const useWebRtcSpy = vi.fn()
mockNuxtImport('useWebRtc', () => () => {
  useWebRtcSpy()
  return {
    isConnected: ref(false),
    isPeerConnected: ref(false),
    remoteStream: ref(null),
    error: ref(null),
    connect: vi.fn(),
    startStreaming: vi.fn(),
    disconnect: vi.fn(),
  }
})

// --- 子 component のスタブ ---

const NfcStatusStub = defineComponent({
  name: 'NfcStatus',
  emits: ['read'],
  template: '<div data-testid="nfc-stub" />',
})
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
const TenkoVideoCallStub = defineComponent({
  name: 'TenkoVideoCall',
  template: '<div data-testid="video-call-stub" />',
})

const EMPLOYEE = { id: 'emp-1', name: '山田太郎', face_approval_status: 'approved' }
const LICENSE_ID = '2601012901010'
const IT_CALL_NOT_STARTED = 'IT点呼の通話を始められませんでした。運行管理者に連絡してください'

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
type CardType = 'driver_license' | 'car_inspection' | 'other' | undefined

type Props = { itMode?: boolean, itSelectable?: boolean }

async function mountNm(props: Props = {}) {
  return await mountSuspended(NormalMeasurement, {
    props,
    global: {
      stubs: {
        NfcStatus: NfcStatusStub,
        BleStatus: BleStatusStub,
        AlcMeasurement: AlcMeasurementStub,
        TenkoVideoCall: TenkoVideoCallStub,
        ClientOnly: false,
        Teleport: true,
      },
    },
  })
}

async function flush(wrapper: Wrapper) {
  await new Promise(resolve => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
}

/** NfcStatus の read を、第 4 引数 (card_type) つきで発火させる */
async function touch(wrapper: Wrapper, cardType: CardType, nfcId = LICENSE_ID) {
  wrapper.findComponent(NfcStatusStub).vm.$emit('read', nfcId, undefined, 'bridge', cardType)
  await flush(wrapper)
}

function measurementResult(resultType: 'normal' | 'over' = 'normal') {
  return {
    employeeId: 'emp-1',
    alcoholValue: resultType === 'over' ? 0.3 : 0,
    resultType,
    deviceUseCount: 1,
    measuredAt: new Date('2026-01-01T00:00:00Z'),
  }
}

type Choice = 'alcohol' | 'pre-operation' | 'post-operation'

/** 種別を選んだところから測定結果が届くところまで進める (始業だけ車検証の段を飛ばす) */
async function measure(wrapper: Wrapper, choice: Choice = 'alcohol', resultType: 'normal' | 'over' = 'normal') {
  await wrapper.find(`[data-testid="choice-${choice}"]`).trigger('click')
  await wrapper.vm.$nextTick()
  if (choice === 'pre-operation') {
    await wrapper.find('[data-testid="vehicle-skip"]').trigger('click')
    await wrapper.vm.$nextTick()
  }
  wrapper.findComponent(BleStatusStub).vm.$emit('skip')
  await wrapper.vm.$nextTick()
  wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', measurementResult(resultType))
  await flush(wrapper)
}

/** 免許証のタッチから測定結果が届くところまで進める */
async function runToResult(wrapper: Wrapper, choice: Choice = 'alcohol') {
  await touch(wrapper, 'driver_license')
  await measure(wrapper, choice)
}

function completedBodies() {
  return updateMeasurementMock.mock.calls
    .map(call => call[1] as Record<string, unknown>)
    .filter(body => body.status === 'completed')
}

function nextButton(wrapper: Wrapper) {
  return wrapper.findAll('button').find(b => b.text() === '次の測定へ')
}

function exposed(wrapper: Wrapper) {
  return wrapper.vm as unknown as {
    isIdle: boolean
    startForEmployee: (id: string, name: string) => Promise<boolean>
  }
}

/** 通常点呼の完了の PUT が今まで送っていた key (この並びのまま) */
const COMPLETED_BODY_KEYS = [
  'status',
  'alcohol_value',
  'result_type',
  'device_use_count',
  'face_photo_url',
  'measured_at',
  'temperature',
  'systolic',
  'diastolic',
  'pulse',
  'medical_measured_at',
  'face_verified',
  'medical_manual_input',
  'record_as_tenko',
  'tenko_type',
  'carins_cert_no',
  'carins_vehicle_id',
]

const panel = (wrapper: Wrapper) => wrapper.find('[data-testid="it-choice-panel"]')
const saveButton = (wrapper: Wrapper) => wrapper.find('[data-testid="it-choice-save"]')
const itButton = (wrapper: Wrapper) => wrapper.find('[data-testid="it-choice-it"]')

/** 選択の段の 30 秒だけを偽の時計にする (flush の setTimeout は本物のまま) */
function fakeInterval() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
}

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  vi.clearAllMocks()
  startMeasurementMock.mockImplementation(async () => ({ id: 'measurement-1' }))
  demoModeRef.value = false
  isOnlineRef.value = true
  itCall.state.value = 'idle'
  itCall.judgment.value = null
  itCall.isDisconnected.value = false
  itCall.error.value = null
  getEmployeeByNfcIdMock.mockResolvedValue(EMPLOYEE)
  getEmployeeByCodeMock.mockResolvedValue(EMPLOYEE)
  // backend は完了の PUT に点呼の記録の id を返す。**通常点呼はこれを見ない**
  updateMeasurementMock.mockImplementation(async () => ({ id: 'measurement-1', tenko_session_id: 'session-1' }))
})

describe('NormalMeasurement — itSelectable なし (通常点呼は今までと 1 つも変わらない)', () => {
  it('★ prop なし: 免許証で本人確認しても選択の段は出ず、測定の結果で即保存する', async () => {
    const wrapper = await mountNm()
    await runToResult(wrapper)

    expect(panel(wrapper).exists()).toBe(false)
    expect(completedBodies()).toHaveLength(1)
    expect(Object.keys(completedBodies()[0]!)).toEqual(COMPLETED_BODY_KEYS)
    expect(updateMeasurementMock).toHaveBeenCalledTimes(1)
    expect(nextButton(wrapper)).toBeTruthy()
    // 通話の composable も作らない
    expect(useItTenkoCallSpy).not.toHaveBeenCalled()
    expect(useWebRtcSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('★ itSelectable = false (印が無い端末に index.vue が渡す値): 結果の画面の DOM は prop なしと同一', async () => {
    const plain = await mountNm()
    await runToResult(plain)
    const expected = plain.html()
    plain.unmount()
    vi.clearAllMocks()

    const wrapper = await mountNm({ itSelectable: false })
    await runToResult(wrapper)

    expect(wrapper.html()).toBe(expected)
    expect(panel(wrapper).exists()).toBe(false)
    expect(completedBodies()).toHaveLength(1)
    expect(Object.keys(completedBodies()[0]!)).toEqual(COMPLETED_BODY_KEYS)
    expect(useItTenkoCallSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('mount の後で itSelectable が立っても、その画面では選択の段を出さない (通話の composable を作っていない)', async () => {
    const wrapper = await mountNm()
    await wrapper.setProps({ itSelectable: true })
    await runToResult(wrapper)

    expect(panel(wrapper).exists()).toBe(false)
    expect(completedBodies()).toHaveLength(1)
    expect('tenko_method' in completedBodies()[0]!).toBe(false)
    wrapper.unmount()
  })
})

describe('NormalMeasurement — itSelectable: 選択の段が出る条件', () => {
  it('★ 免許証で本人確認した回は、測定の結果のあとに選択の段が出て、PUT はまだ呼ばれていない', async () => {
    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper)

    expect(panel(wrapper).exists()).toBe(true)
    expect(saveButton(wrapper).text()).toBe('このまま保存')
    expect(itButton(wrapper).text()).toBe('IT点呼 (運行管理者と通話)')
    expect(wrapper.find('[data-testid="it-choice-countdown"]').text()).toBe('あと 30 秒でこのまま保存します')
    expect(completedBodies()).toHaveLength(0)
    expect(offlineSaveMock).not.toHaveBeenCalled()
    // まだ保存していないので「次の測定へ」も、通話の画面も、保存中の表示も無い
    expect(nextButton(wrapper)).toBeUndefined()
    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('保存中...')
    expect(itCall.start).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('★ 見出しと進み具合の表示は prop なしの結果の画面と同じ (段を増やさない)。本人確認の入口も狭めない', async () => {
    const plain = await mountNm()
    const idleHtml = plain.html()
    await runToResult(plain)
    const header = plain.find('header').html()
    plain.unmount()

    const wrapper = await mountNm({ itSelectable: true })
    // 待機の画面 (手入力の入口を含む) は prop なしと同一
    expect(wrapper.html()).toBe(idleHtml)
    await runToResult(wrapper)

    expect(wrapper.find('header').html()).toBe(header)
    expect(wrapper.find('header').text()).toContain('アルコールチェッカー')
    wrapper.unmount()
  })

  it.each(['other', 'car_inspection', undefined] as const)(
    '★ 免許証でないタップ (card_type = %s) は断らずに進み、選択の段を出さず即保存する',
    async (cardType) => {
      const wrapper = await mountNm({ itSelectable: true })
      await touch(wrapper, cardType)
      await measure(wrapper)

      expect(panel(wrapper).exists()).toBe(false)
      expect(completedBodies()).toHaveLength(1)
      expect(Object.keys(completedBodies()[0]!)).toEqual(COMPLETED_BODY_KEYS)
      expect(nextButton(wrapper)).toBeTruthy()
      wrapper.unmount()
    },
  )

  it('★ IC カードの直行 (startForEmployee) は選択の段を出さず即保存する', async () => {
    const wrapper = await mountNm({ itSelectable: true })

    expect(await exposed(wrapper).startForEmployee('emp-9', '佐藤花子')).toBe(true)
    await wrapper.vm.$nextTick()
    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', measurementResult())
    await flush(wrapper)

    expect(panel(wrapper).exists()).toBe(false)
    expect(completedBodies()).toHaveLength(1)
    expect('tenko_method' in completedBodies()[0]!).toBe(false)
    wrapper.unmount()
  })

  it('★ 手入力は選択の段を出さず即保存する', async () => {
    const wrapper = await mountNm({ itSelectable: true })

    await wrapper.findAll('button').find(b => b.text() === '手動でIDを入力する')!.trigger('click')
    await wrapper.find('input[type="text"]').setValue('0001')
    await wrapper.findAll('button').find(b => b.text() === '次へ')!.trigger('click')
    await flush(wrapper)
    await measure(wrapper)

    expect(panel(wrapper).exists()).toBe(false)
    expect(completedBodies()).toHaveLength(1)
    expect('tenko_method' in completedBodies()[0]!).toBe(false)
    wrapper.unmount()
  })

  it('★ オフラインでは選択の段を出さず、今までどおり端末に保存する', async () => {
    const wrapper = await mountNm({ itSelectable: true })
    await touch(wrapper, 'driver_license')
    isOnlineRef.value = false
    await measure(wrapper)

    expect(panel(wrapper).exists()).toBe(false)
    expect(updateMeasurementMock).not.toHaveBeenCalled()
    expect(offlineSaveMock).toHaveBeenCalledTimes(1)
    // 選んでいないので「IT点呼 にならなかった」の案内も出さない
    expect(wrapper.find('[data-testid="it-call-not-started"]').exists()).toBe(false)
    expect(nextButton(wrapper)).toBeTruthy()
    wrapper.unmount()
  })

  it('★ デモモードでは選択の段を出さない', async () => {
    const wrapper = await mountNm({ itSelectable: true })
    await touch(wrapper, 'driver_license')
    await wrapper.find('[data-testid="choice-alcohol"]').trigger('click')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()
    // 免許証で入ったあとでデモに切り替わった体にする (デモの入口は手入力だけなので、
    // 免許証の印とデモが同時に立つのはこの形だけ)
    demoModeRef.value = true
    wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', measurementResult())
    await flush(wrapper)

    expect(panel(wrapper).exists()).toBe(false)
    expect(completedBodies()).toHaveLength(1)
    expect('tenko_method' in completedBodies()[0]!).toBe(false)
    wrapper.unmount()
  })

  it('測定の開始レコードが無い回 (保存が端末のキューへ回る) は選択の段を出さない', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    startMeasurementMock.mockRejectedValue(new Error('500'))
    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper)

    expect(panel(wrapper).exists()).toBe(false)
    expect(offlineSaveMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it.each([
    { name: 'itMode だけ', props: { itMode: true } },
    { name: 'itMode と itSelectable の両方', props: { itMode: true, itSelectable: true } },
  ])('★ $name: 選択の段は出ず、最初から IT点呼 として保存する (回帰)', async ({ props }) => {
    const wrapper = await mountNm(props)
    await runToResult(wrapper)

    expect(panel(wrapper).exists()).toBe(false)
    expect(completedBodies()).toHaveLength(1)
    expect(completedBodies()[0]!.tenko_method).toBe('IT点呼')
    expect(itCall.start).toHaveBeenCalledWith('session-1')
    expect(useItTenkoCallSpy).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

describe('NormalMeasurement — itSelectable: 「このまま保存」', () => {
  it('★ PUT の body は今までと同じ key だけ (tenko_method の key が無い)。通話は始めず「次の測定へ」が出る', async () => {
    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper)

    await saveButton(wrapper).trigger('click')
    await flush(wrapper)

    expect(completedBodies()).toHaveLength(1)
    const body = completedBodies()[0]!
    expect(Object.keys(body)).toEqual(COMPLETED_BODY_KEYS)
    expect('tenko_method' in body).toBe(false)
    expect(updateMeasurementMock).toHaveBeenCalledTimes(1)
    expect(offlineSaveMock).not.toHaveBeenCalled()
    // 応答に点呼の記録の id が載っていても、それで何も始めない
    expect(itCall.start).not.toHaveBeenCalled()
    expect(panel(wrapper).exists()).toBe(false)
    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="it-call-not-started"]').exists()).toBe(false)
    expect(nextButton(wrapper)).toBeTruthy()
    wrapper.unmount()
  })

  it('保存中は通常点呼と同じ画面 (「保存中...」と「次の測定へ」。判定待ちの画面にはしない)', async () => {
    updateMeasurementMock.mockReturnValue(new Promise(() => {}))
    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper)

    await saveButton(wrapper).trigger('click')
    await flush(wrapper)

    expect(wrapper.text()).toContain('保存中...')
    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(false)
    expect(nextButton(wrapper)).toBeTruthy()
    wrapper.unmount()
  })

  it('保存したあとの結果の画面の DOM は prop なしの通常点呼と同一', async () => {
    const plain = await mountNm()
    await runToResult(plain)
    const expected = plain.html()
    plain.unmount()

    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper)
    await saveButton(wrapper).trigger('click')
    await flush(wrapper)

    expect(wrapper.html()).toBe(expected)
    wrapper.unmount()
  })
})

describe('NormalMeasurement — itSelectable: 「IT点呼」', () => {
  it('★ PUT に tenko_method が足され、応答の tenko_session_id で通話が始まる', async () => {
    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper)

    await itButton(wrapper).trigger('click')
    await flush(wrapper)

    expect(completedBodies()).toHaveLength(1)
    const body = completedBodies()[0]!
    expect(Object.keys(body)).toEqual([...COMPLETED_BODY_KEYS, 'tenko_method'])
    expect(body.tenko_method).toBe('IT点呼')
    expect(itCall.start).toHaveBeenCalledTimes(1)
    expect(itCall.start).toHaveBeenCalledWith('session-1')
    // itMode と同じ判定待ちの画面
    expect(panel(wrapper).exists()).toBe(false)
    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="video-call-stub"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="it-call-end"]').text()).toBe('未完了のまま終了')
    expect(nextButton(wrapper)).toBeUndefined()
    wrapper.unmount()
  })

  it.each([
    { choice: 'alcohol' as const, tenkoType: 'normal' },
    { choice: 'pre-operation' as const, tenkoType: 'pre_operation' },
    { choice: 'post-operation' as const, tenkoType: 'post_operation' },
  ])('★ $tenkoType でも同じ段を通る — 選ぶ前は PUT が無く、IT点呼 を選ぶと tenko_method 付きで保存して通話へ', async ({ choice, tenkoType }) => {
    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper, choice)

    expect(panel(wrapper).exists()).toBe(true)
    expect(completedBodies()).toHaveLength(0)

    await itButton(wrapper).trigger('click')
    await flush(wrapper)

    expect(completedBodies()).toHaveLength(1)
    expect(completedBodies()[0]).toMatchObject({ tenko_type: tenkoType, tenko_method: 'IT点呼', record_as_tenko: true })
    expect(itCall.start).toHaveBeenCalledWith('session-1')
    wrapper.unmount()
  })

  it('★ 検知あり (over) の回でも選択の段が出て、IT点呼 を選べる (判定は運行管理者がする)', async () => {
    const wrapper = await mountNm({ itSelectable: true })
    await touch(wrapper, 'driver_license')
    await measure(wrapper, 'alcohol', 'over')

    expect(panel(wrapper).exists()).toBe(true)
    expect(completedBodies()).toHaveLength(0)

    await itButton(wrapper).trigger('click')
    await flush(wrapper)

    expect(completedBodies()).toHaveLength(1)
    expect(completedBodies()[0]).toMatchObject({ result_type: 'over', alcohol_value: 0.3, tenko_method: 'IT点呼' })
    expect(itCall.start).toHaveBeenCalledWith('session-1')
    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('判定が付いたら結果と判定を出し、「次の測定へ」で待機へ戻る', async () => {
    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper)
    await itButton(wrapper).trigger('click')
    await flush(wrapper)

    itCall.state.value = 'judged'
    itCall.judgment.value = { judgment: 'ok', reason: null }
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="it-judgment"]').text()).toBe('運行管理者の判定: OK')

    await nextButton(wrapper)!.trigger('click')
    await wrapper.vm.$nextTick()
    expect(itCall.stop).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    wrapper.unmount()
  })

  it('保存が終わるまでは判定待ちの画面で、「次の測定へ」も「未完了のまま終了」も出さない', async () => {
    updateMeasurementMock.mockReturnValue(new Promise(() => {}))
    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper)

    await itButton(wrapper).trigger('click')
    await flush(wrapper)

    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(true)
    expect(nextButton(wrapper)).toBeUndefined()
    expect(wrapper.find('[data-testid="it-call-end"]').exists()).toBe(false)
    expect(itCall.start).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('★ 保存に失敗したら通常点呼として端末に保存し、IT点呼 にならなかった案内を出す (itMode と同じ)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    updateMeasurementMock.mockRejectedValue(new Error('500'))
    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper)

    await itButton(wrapper).trigger('click')
    await flush(wrapper)

    expect(offlineSaveMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(offlineSaveMock.mock.calls[0])).not.toContain('tenko_method')
    expect(itCall.start).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="it-call-not-started"]').text()).toBe(IT_CALL_NOT_STARTED)
    expect(nextButton(wrapper)).toBeTruthy()
    wrapper.unmount()
  })

  it('★ 選択の段のあいだにオフラインに落ちたら、IT点呼 を選んでも通常点呼として端末に保存し案内を出す', async () => {
    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper)
    isOnlineRef.value = false

    await itButton(wrapper).trigger('click')
    await flush(wrapper)

    expect(updateMeasurementMock).not.toHaveBeenCalled()
    expect(offlineSaveMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(offlineSaveMock.mock.calls[0])).not.toContain('IT点呼')
    expect(itCall.start).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="it-call-not-started"]').text()).toBe(IT_CALL_NOT_STARTED)
    wrapper.unmount()
  })
})

describe('NormalMeasurement — itSelectable: 放置・reset・unmount', () => {
  it('★ 残り秒数が減り、30 秒の放置で通常点呼として保存する (それ以上は保存しない)', async () => {
    fakeInterval()
    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper)

    vi.advanceTimersByTime(29_000)
    await flush(wrapper)
    expect(wrapper.find('[data-testid="it-choice-countdown"]').text()).toBe('あと 1 秒でこのまま保存します')
    expect(completedBodies()).toHaveLength(0)

    vi.advanceTimersByTime(1_000)
    await flush(wrapper)

    expect(panel(wrapper).exists()).toBe(false)
    expect(completedBodies()).toHaveLength(1)
    expect(Object.keys(completedBodies()[0]!)).toEqual(COMPLETED_BODY_KEYS)
    expect(itCall.start).not.toHaveBeenCalled()
    expect(nextButton(wrapper)).toBeTruthy()

    // タイマーは止まっている
    vi.advanceTimersByTime(60_000)
    await flush(wrapper)
    expect(updateMeasurementMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('★ ボタンを押したらタイマーは止まる (30 秒を過ぎても 2 度目の保存は起きない)', async () => {
    fakeInterval()
    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper)
    await itButton(wrapper).trigger('click')
    await flush(wrapper)

    vi.advanceTimersByTime(60_000)
    await flush(wrapper)

    expect(updateMeasurementMock).toHaveBeenCalledTimes(1)
    expect(completedBodies()[0]!.tenko_method).toBe('IT点呼')
    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('★ 選択を待ったまま画面を離れたら (unmount)、通常点呼として保存してタイマーを止める', async () => {
    fakeInterval()
    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper)
    expect(completedBodies()).toHaveLength(0)

    wrapper.unmount()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(completedBodies()).toHaveLength(1)
    expect(Object.keys(completedBodies()[0]!)).toEqual(COMPLETED_BODY_KEYS)
    expect(updateMeasurementMock).toHaveBeenCalledWith('measurement-1', expect.anything())
    expect(itCall.start).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(updateMeasurementMock).toHaveBeenCalledTimes(1)
  })

  it('★ reset で state が戻る — IT点呼 を選んだ次の回が社員証なら、段は出ず tenko_method も付かない', async () => {
    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper)
    await itButton(wrapper).trigger('click')
    await flush(wrapper)
    await wrapper.find('[data-testid="it-call-end"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(itCall.stop).toHaveBeenCalledTimes(1)
    updateMeasurementMock.mockClear()
    itCall.start.mockClear()

    // 免許証の印も「IT点呼 を選んだ」も残っていない
    await touch(wrapper, 'other')
    await measure(wrapper)

    expect(panel(wrapper).exists()).toBe(false)
    expect(completedBodies()).toHaveLength(1)
    expect(Object.keys(completedBodies()[0]!)).toEqual(COMPLETED_BODY_KEYS)
    expect(itCall.start).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(false)
    expect(nextButton(wrapper)).toBeTruthy()
    wrapper.unmount()
  })

  it('reset のあと、次の回が免許証ならまた 30 秒から選択の段が出る', async () => {
    fakeInterval()
    const wrapper = await mountNm({ itSelectable: true })
    await runToResult(wrapper)
    vi.advanceTimersByTime(10_000)
    await flush(wrapper)
    await saveButton(wrapper).trigger('click')
    await flush(wrapper)
    await nextButton(wrapper)!.trigger('click')
    await wrapper.vm.$nextTick()

    await runToResult(wrapper)

    expect(wrapper.find('[data-testid="it-choice-countdown"]').text()).toBe('あと 30 秒でこのまま保存します')
    expect(completedBodies()).toHaveLength(1)
    wrapper.unmount()
  })
})
