import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly, defineComponent } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import NormalMeasurement from '~/components/NormalMeasurement.vue'

// IT点呼 (`itMode`) と、**`itMode` を付けない通常点呼が今までと変わらないこと**を固定する
// (Refs ippoan/alc-app#387)。alc-app は main へのマージから数分で本番に出るので、
// 「印が無い端末 = `itMode` なし」の挙動 (送る body・通信の本数・画面) をここで釘付けにする。
// 既存の tests/components/NormalMeasurement.test.ts は 1 行も書き換えていない。

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
const IT_LICENSE_ONLY = 'IT点呼は免許証で本人確認してください'
const IT_CALL_NOT_STARTED = 'IT点呼の通話を始められませんでした。運行管理者に連絡してください'

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
type CardType = 'driver_license' | 'car_inspection' | 'other' | undefined

async function mountIt(itMode: boolean) {
  return await mountSuspended(NormalMeasurement, {
    props: itMode ? { itMode: true } : {},
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

/** 免許証のタッチから測定結果が出るところまで進める */
async function runToResult(wrapper: Wrapper, resultType: 'normal' | 'over' = 'normal') {
  await touch(wrapper, 'driver_license')
  await wrapper.find('[data-testid="choice-alcohol"]').trigger('click')
  await wrapper.vm.$nextTick()
  wrapper.findComponent(BleStatusStub).vm.$emit('skip')
  await wrapper.vm.$nextTick()
  wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', measurementResult(resultType))
  await flush(wrapper)
}

function completedBodies() {
  return updateMeasurementMock.mock.calls
    .map(call => call[1] as Record<string, unknown>)
    .filter(body => body.status === 'completed')
}

function nextButton(wrapper: Wrapper) {
  return wrapper.findAll('button').find(b => b.text() === '次の測定へ')
}

function manualButton(wrapper: Wrapper) {
  return wrapper.findAll('button').find(b => b.text() === '手動でIDを入力する')
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

beforeEach(() => {
  vi.clearAllMocks()
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

describe('NormalMeasurement — itMode なし (通常点呼は今までと 1 つも変わらない)', () => {
  it('★ 通話の composable を生成しない (useItTenkoCall も useWebRtc も)', async () => {
    const wrapper = await mountIt(false)
    await runToResult(wrapper)

    expect(useItTenkoCallSpy).not.toHaveBeenCalled()
    expect(useWebRtcSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('★ 完了の PUT の body は今までと同じ key だけ (tenko_method を足さない)。通信の本数も同じ', async () => {
    const wrapper = await mountIt(false)
    await runToResult(wrapper)

    expect(completedBodies()).toHaveLength(1)
    const body = completedBodies()[0]!
    // 今までの key の後ろに、本人確認の方法が 1 つ付く (IT点呼 に限らず送る)
    expect(Object.keys(body)).toEqual([...COMPLETED_BODY_KEYS, 'identity_method'])
    expect('tenko_method' in body).toBe(false)
    expect(body).toMatchObject({
      status: 'completed',
      alcohol_value: 0,
      result_type: 'normal',
      record_as_tenko: true,
      tenko_type: 'normal',
    })
    // 測定の開始 1 本 + 完了 1 本。応答に点呼の記録の id が載っていても、それで何も始めない
    expect(startMeasurementMock).toHaveBeenCalledTimes(1)
    expect(updateMeasurementMock).toHaveBeenCalledTimes(1)
    expect(itCall.start).not.toHaveBeenCalled()
    expect(offlineSaveMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('★ 結果画面は今までどおり — 保存の応答に点呼の記録の id があっても通話の画面を出さず、「次の測定へ」が出る', async () => {
    const wrapper = await mountIt(false)
    await runToResult(wrapper)

    expect(nextButton(wrapper)).toBeTruthy()
    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="it-judgment"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="it-call-not-started"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('アルコールチェッカー')

    await nextButton(wrapper)!.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    wrapper.unmount()
  })

  it('保存中も「次の測定へ」は出ている (今までどおり)', async () => {
    updateMeasurementMock.mockReturnValue(new Promise(() => {}))
    const wrapper = await mountIt(false)
    await runToResult(wrapper)

    expect(wrapper.text()).toContain('保存中...')
    expect(nextButton(wrapper)).toBeTruthy()
    wrapper.unmount()
  })

  it.each(['other', 'car_inspection', undefined, 'driver_license'] as const)(
    '★ NFC の第 4 引数 (card_type = %s) を見ない — どれでも今までどおり進み、打刻する',
    async (cardType) => {
      const wrapper = await mountIt(false)

      await touch(wrapper, cardType)

      expect(getEmployeeByNfcIdMock).toHaveBeenCalledWith(LICENSE_ID)
      expect(punchTimecardMock).toHaveBeenCalledWith(LICENSE_ID)
      expect(wrapper.find('[data-testid="choice-alcohol"]').exists()).toBe(true)
      expect(wrapper.text()).not.toContain(IT_LICENSE_ONLY)
      wrapper.unmount()
    },
  )

  it('★ 手入力の入口が今までどおり出て、社員番号で進める', async () => {
    const wrapper = await mountIt(false)

    await manualButton(wrapper)!.trigger('click')
    await wrapper.find('input[type="text"]').setValue('0001')
    await wrapper.findAll('button').find(b => b.text() === '次へ')!.trigger('click')
    await flush(wrapper)

    expect(getEmployeeByCodeMock).toHaveBeenCalledWith('0001')
    expect(wrapper.find('[data-testid="choice-alcohol"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('URL のデモモードでは今までどおり手入力のフォームが出る', async () => {
    demoModeRef.value = true
    const wrapper = await mountIt(false)

    expect(wrapper.find('[data-testid="it-demo-blocked"]').exists()).toBe(false)
    expect(wrapper.find('input[type="text"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('IC カードからの開始 (startForEmployee) は今までどおり始まる', async () => {
    const wrapper = await mountIt(false)

    expect(await exposed(wrapper).startForEmployee('emp-9', '佐藤花子')).toBe(true)
    expect(startMeasurementMock).toHaveBeenCalledWith('emp-9')
    wrapper.unmount()
  })

  it('オフラインでは今までどおりオフライン保存だけが走る', async () => {
    const wrapper = await mountIt(false)
    await touch(wrapper, 'driver_license')
    isOnlineRef.value = false
    await wrapper.find('[data-testid="choice-alcohol"]').trigger('click')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', measurementResult())
    await flush(wrapper)

    expect(updateMeasurementMock).not.toHaveBeenCalled()
    expect(offlineSaveMock).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="it-call-not-started"]').exists()).toBe(false)
    expect(nextButton(wrapper)).toBeTruthy()
    wrapper.unmount()
  })
})

describe('NormalMeasurement — itMode: 本人確認は免許証だけ', () => {
  it.each(['other', 'car_inspection', undefined] as const)(
    '★ 免許証でないタップ (card_type = %s) を断る — 照合も打刻もしない',
    async (cardType) => {
      const wrapper = await mountIt(true)

      await touch(wrapper, cardType)

      expect(wrapper.find('.bg-red-50').text()).toBe(IT_LICENSE_ONLY)
      expect(getEmployeeByNfcIdMock).not.toHaveBeenCalled()
      expect(punchTimecardMock).not.toHaveBeenCalled()
      expect(startMeasurementMock).not.toHaveBeenCalled()
      // 進まない
      expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
      expect(wrapper.find('[data-testid="choice-alcohol"]').exists()).toBe(false)
      wrapper.unmount()
    },
  )

  it('★ 免許証 (card_type = driver_license) は進む。断りの文言は次のタッチで消える', async () => {
    const wrapper = await mountIt(true)
    await touch(wrapper, 'other')
    expect(wrapper.text()).toContain(IT_LICENSE_ONLY)

    await touch(wrapper, 'driver_license')

    expect(wrapper.text()).not.toContain(IT_LICENSE_ONLY)
    expect(getEmployeeByNfcIdMock).toHaveBeenCalledWith(LICENSE_ID)
    expect(punchTimecardMock).toHaveBeenCalledWith(LICENSE_ID)
    expect(wrapper.find('[data-testid="choice-alcohol"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('★ 手入力の入口が無い', async () => {
    const wrapper = await mountIt(true)

    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(manualButton(wrapper)).toBeUndefined()
    expect(wrapper.find('input[type="text"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('IT点呼')
    wrapper.unmount()
  })

  it('★ IC カードからの開始 (startForEmployee) を受けない', async () => {
    const wrapper = await mountIt(true)

    expect(await exposed(wrapper).startForEmployee('emp-9', '佐藤花子')).toBe(false)

    expect(startMeasurementMock).not.toHaveBeenCalled()
    expect(exposed(wrapper).isIdle).toBe(true)
    wrapper.unmount()
  })

  it('★ URL のデモモードでは先へ進めない (手入力のフォームも NFC も出さない)', async () => {
    demoModeRef.value = true
    const wrapper = await mountIt(true)

    expect(wrapper.find('[data-testid="it-demo-blocked"]').text()).toBe('IT点呼はデモモードでは使えません')
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(false)
    expect(wrapper.find('input[type="text"]').exists()).toBe(false)
    expect(wrapper.findAll('button').find(b => b.text() === '次へ')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('NormalMeasurement — itMode: 保存と通話', () => {
  it('通話の composable を 1 つだけ生成する', async () => {
    const wrapper = await mountIt(true)

    expect(useItTenkoCallSpy).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('★ 完了の PUT に tenko_method: IT点呼 が足される (ほかの key は通常点呼と同じ)', async () => {
    const wrapper = await mountIt(true)
    await runToResult(wrapper)

    expect(completedBodies()).toHaveLength(1)
    const body = completedBodies()[0]!
    expect(Object.keys(body)).toEqual([...COMPLETED_BODY_KEYS, 'tenko_method', 'identity_method'])
    expect(body.identity_method).toBe('license')
    expect(body.tenko_method).toBe('IT点呼')
    expect(body.record_as_tenko).toBe(true)
    wrapper.unmount()
  })

  it('★ 応答の tenko_session_id で通話が始まり、判定が付くまで「次の測定へ」が無い', async () => {
    const wrapper = await mountIt(true)
    await runToResult(wrapper)

    expect(itCall.start).toHaveBeenCalledTimes(1)
    expect(itCall.start).toHaveBeenCalledWith('session-1')
    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="video-call-stub"]').exists()).toBe(true)
    expect(nextButton(wrapper)).toBeUndefined()
    expect(wrapper.find('[data-testid="it-call-not-started"]').exists()).toBe(false)
    // 切れていなければ再接続のボタンは無い
    expect(wrapper.find('[data-testid="it-call-reconnect"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('★ 判定待ちのあいだは常に「未完了のまま終了」が出て、押すと通話と判定待ちを止めて待機へ戻る', async () => {
    const wrapper = await mountIt(true)
    await runToResult(wrapper)

    // 通話は切れていない (運行管理者がまだ入ってきていないだけ) — それでも出られる
    expect(itCall.isDisconnected.value).toBe(false)
    const end = wrapper.find('[data-testid="it-call-end"]')
    expect(end.text()).toBe('未完了のまま終了')
    expect(wrapper.find('[data-testid="it-call-panel"]').text()).toContain('運行管理者の確認が済むまで、この点呼は未完了です')

    await end.trigger('click')
    await wrapper.vm.$nextTick()

    expect(itCall.stop).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('開いている途中 (connecting) でも「未完了のまま終了」は出る', async () => {
    itCall.start.mockImplementationOnce(async () => { itCall.state.value = 'connecting' })
    const wrapper = await mountIt(true)
    await runToResult(wrapper)

    expect(wrapper.find('[data-testid="it-call-end"]').exists()).toBe(true)
    expect(nextButton(wrapper)).toBeUndefined()
    wrapper.unmount()
  })

  it.each([
    { judgment: 'ok' as const, reason: null, text: '運行管理者の判定: OK' },
    { judgment: 'ng' as const, reason: '顔色が悪い', text: '運行管理者の判定: NG (顔色が悪い)' },
  ])('★ 判定 ($judgment) が付いたら結果と判定を出し、「次の測定へ」で待機へ戻る', async ({ judgment, reason, text }) => {
    const wrapper = await mountIt(true)
    await runToResult(wrapper)

    itCall.state.value = 'judged'
    itCall.judgment.value = { judgment, reason }
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="it-judgment"]').text()).toBe(text)
    expect(wrapper.text()).toContain('測定結果')
    expect(nextButton(wrapper)).toBeTruthy()

    await nextButton(wrapper)!.trigger('click')
    await wrapper.vm.$nextTick()

    expect(itCall.stop).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(wrapper.find('[data-testid="it-judgment"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('★ 検知あり (中止) でも、点呼の記録があれば通話に進む (判定は運行管理者がする)', async () => {
    const wrapper = await mountIt(true)
    await runToResult(wrapper, 'over')

    expect(itCall.start).toHaveBeenCalledWith('session-1')
    expect(nextButton(wrapper)).toBeUndefined()
    wrapper.unmount()
  })

  it('保存が終わるまでは「次の測定へ」を出さず、通話も始めない', async () => {
    updateMeasurementMock.mockReturnValue(new Promise(() => {}))
    const wrapper = await mountIt(true)
    await runToResult(wrapper)

    expect(wrapper.text()).toContain('保存中...')
    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="video-call-stub"]').exists()).toBe(false)
    expect(nextButton(wrapper)).toBeUndefined()
    // 保存中は「未完了のまま終了」も出さない (戻ったあとの画面で通話が始まるのを防ぐ)
    expect(wrapper.find('[data-testid="it-call-end"]').exists()).toBe(false)
    expect(itCall.start).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it.each([
    { name: 'null', response: { id: 'measurement-1', tenko_session_id: null } },
    { name: '欄が無い (古い backend)', response: { id: 'measurement-1' } },
  ])('★ tenko_session_id が $name なら通話に進まず、案内と「次の測定へ」を出す', async ({ response }) => {
    updateMeasurementMock.mockResolvedValue(response)
    const wrapper = await mountIt(true)
    await runToResult(wrapper)

    expect(itCall.start).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="it-call-not-started"]').text()).toBe(IT_CALL_NOT_STARTED)
    expect(nextButton(wrapper)).toBeTruthy()
    // オフライン保存には回さない (PUT は通っている)
    expect(offlineSaveMock).not.toHaveBeenCalled()

    // 待機へ戻れば案内も消える
    await nextButton(wrapper)!.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="it-call-not-started"]').exists()).toBe(false)
    wrapper.unmount()
  })

  /** 通常点呼 (`itMode` なし) で同じ操作をしたときに、オフライン保存へ渡る引数 */
  async function offlineArgsOfNormal(prepare: () => void) {
    prepare()
    const wrapper = await mountIt(false)
    await touch(wrapper, 'driver_license')
    await wrapper.find('[data-testid="choice-alcohol"]').trigger('click')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', measurementResult())
    await flush(wrapper)
    wrapper.unmount()
    const args = offlineSaveMock.mock.calls[0]!
    offlineSaveMock.mockClear()
    updateMeasurementMock.mockClear()
    return args
  }

  it('★ オフラインなら通話に進まず案内を出す。オフライン保存に渡る内容は通常点呼と同じ', async () => {
    const expected = await offlineArgsOfNormalAfterOffline()
    isOnlineRef.value = true

    const wrapper = await mountIt(true)
    await touch(wrapper, 'driver_license')
    // 本人確認のあとで通信が切れた体にする (測定の開始は済んでいる)
    isOnlineRef.value = false
    await wrapper.find('[data-testid="choice-alcohol"]').trigger('click')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', measurementResult())
    await flush(wrapper)

    expect(updateMeasurementMock).not.toHaveBeenCalled()
    expect(offlineSaveMock).toHaveBeenCalledTimes(1)
    expect(offlineSaveMock.mock.calls[0]).toEqual(expected)
    // 再送に IT点呼 を運ばない (通常点呼として記録される)
    expect(JSON.stringify(offlineSaveMock.mock.calls[0])).not.toContain('IT点呼')
    expect(JSON.stringify(offlineSaveMock.mock.calls[0])).not.toContain('tenko_method')
    expect(itCall.start).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="it-call-not-started"]').text()).toBe(IT_CALL_NOT_STARTED)
    expect(nextButton(wrapper)).toBeTruthy()
    wrapper.unmount()
  })

  /** 通常点呼で「本人確認のあとにオフラインになった」ときのオフライン保存の引数 */
  async function offlineArgsOfNormalAfterOffline() {
    const wrapper = await mountIt(false)
    await touch(wrapper, 'driver_license')
    isOnlineRef.value = false
    await wrapper.find('[data-testid="choice-alcohol"]').trigger('click')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(BleStatusStub).vm.$emit('skip')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(AlcMeasurementStub).vm.$emit('result', measurementResult())
    await flush(wrapper)
    wrapper.unmount()
    const args = offlineSaveMock.mock.calls[0]!
    vi.clearAllMocks()
    return args
  }

  it('★ 保存に失敗したら通話に進まず案内を出す。オフライン保存に渡る内容は通常点呼と同じ', async () => {
    const expected = await offlineArgsOfNormal(() => {
      updateMeasurementMock.mockRejectedValue(new Error('500'))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const wrapper = await mountIt(true)
    await runToResult(wrapper)

    expect(completedBodies()).toHaveLength(1)
    expect(offlineSaveMock).toHaveBeenCalledTimes(1)
    expect(offlineSaveMock.mock.calls[0]).toEqual(expected)
    expect(JSON.stringify(offlineSaveMock.mock.calls[0])).not.toContain('tenko_method')
    expect(itCall.start).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="it-call-not-started"]').text()).toBe(IT_CALL_NOT_STARTED)
    expect(nextButton(wrapper)).toBeTruthy()
    wrapper.unmount()
  })

  it('通話を開けなかった (カメラ・signaling) ときも案内と「次の測定へ」を出し、つなぎ直せる', async () => {
    itCall.start.mockImplementationOnce(async () => { itCall.state.value = 'unavailable' })
    const wrapper = await mountIt(true)
    await runToResult(wrapper)

    expect(wrapper.find('[data-testid="it-call-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="it-call-not-started"]').text()).toContain(IT_CALL_NOT_STARTED)
    expect(nextButton(wrapper)).toBeTruthy()

    await wrapper.find('[data-testid="it-call-retry"]').trigger('click')
    expect(itCall.reconnect).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('通話が切れたら再接続のボタンを出す (「未完了のまま終了」で待機へ戻れるのは同じ)', async () => {
    const wrapper = await mountIt(true)
    await runToResult(wrapper)

    itCall.isDisconnected.value = true
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-testid="it-call-reconnect"]').trigger('click')
    expect(itCall.reconnect).toHaveBeenCalledTimes(1)

    await wrapper.find('[data-testid="it-call-end"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(itCall.stop).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    wrapper.unmount()
  })

  it('signaling に断られたら文言と再接続のボタンを出す', async () => {
    const wrapper = await mountIt(true)
    await runToResult(wrapper)

    itCall.error.value = 'この通話には参加できません'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="it-call-error"]').text()).toBe('この通話には参加できません')
    expect(wrapper.find('[data-testid="it-call-reconnect"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="it-call-end"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
