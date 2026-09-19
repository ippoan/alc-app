import type { BpUiState } from '~/composables/useBloodPressureSetting'
import type { NfcReadEvent } from '~/types'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, computed, readonly } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import BloodPressureMeasurement from '~/components/BloodPressureMeasurement.vue'
import NfcStatus from '~/components/NfcStatus.vue'

// 測定台 (`?station=bp`) で血圧計が使えない (`bpUiState !== 'show'`) ときの USB 許可の導線
// (Refs ippoan/alc-app#353)。
//
// `show` に進む署名は ATOM S3 のシリアルから取り、シリアルを開くには USB の許可が要る。
// 許可ボタンは `NfcStatus` にしか無いので、案内だけの画面だと**許可が無い PC は永久に抜けられない**。
// ここでは `NfcStatus` を**本物のまま**描き、ボタンが実際に出ることまで見る
// (BloodPressureMeasurement.test.ts は NfcStatus を stub するので、この経路は見えない)。
// 従業員・カード番号はすべて合成値。

const { getEmployeeByNfcIdMock } = vi.hoisted(() => ({ getEmployeeByNfcIdMock: vi.fn() }))
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getEmployeeByNfcId: getEmployeeByNfcIdMock,
}))

const bpUiState = ref<BpUiState>('unregistered')
mockNuxtImport('useBpUiEnabled', () => () => ({
  bpUiState,
  showBpUi: computed(() => bpUiState.value === 'show'),
}))
mockNuxtImport('useBleGateway', () => () => ({ latestBloodPressure: ref(null) }))

// --- NfcStatus が使う composable (serial ブロックの表示条件だけを動かす) ---
// カードを読んだ通知は onRead に渡された handler を控えておき、テストから撃つ
const nfcReadHandlers: Array<(event: NfcReadEvent) => void> = []
mockNuxtImport('useNfcReader', () => () => ({
  isConnected: readonly(ref(false)),
  error: ref<string | null>(null),
  readers: ref<string[]>([]),
  bridgeVersion: ref<string | null>(null),
  connect: vi.fn(),
  onRead: (handler: (event: NfcReadEvent) => void) => { nfcReadHandlers.push(handler) },
  onLicenseRead: vi.fn(),
}))
mockNuxtImport('useNfcBridgeUpdate', () => () => ({
  latestVersion: ref<string | null>(null),
  checkLatestVersion: vi.fn(async () => {}),
  isUpdateAvailable: vi.fn(() => false),
}))
const requestPortMock = vi.fn(async () => true)
mockNuxtImport('useCoreS3Serial', () => () => ({
  isConnected: readonly(ref(false)),
  requestPort: requestPortMock,
}))
mockNuxtImport('useAtomS3Serial', () => () => ({ isConnected: readonly(ref(false)) }))
mockNuxtImport('useFingerprint', () => () => ({ isAndroidApp: ref(false), deviceModel: ref<string | null>(null) }))
mockNuxtImport('useKioskAccess', () => () => ({ isCheckingKioskAccess: ref(false) }))
vi.mock('~/utils/webserial', () => ({ isWebSerialSupported: () => true }))

const STATION_ROUTE = '/?role=driver&tab=bp&station=bp'
const USB_BUTTON = 'USB デバイスを選択'
const NOT_FOUND = '血圧計が見つかりません'
const NOT_SHOW_STATES: BpUiState[] = ['unused', 'unavailable', 'unregistered']

const FaceAuthStub = { name: 'FaceAuth', template: '<div class="face-stub" />', emits: ['result'] }
const BleStatusStub = { name: 'BleStatus', template: '<div class="ble-stub" />', emits: ['next', 'skip'] }

function mountBp(route?: string) {
  return mountSuspended(BloodPressureMeasurement, {
    route,
    global: { stubs: { FaceAuth: FaceAuthStub, BleStatus: BleStatusStub } },
  })
}

function usbButton(wrapper: Awaited<ReturnType<typeof mountBp>>) {
  return wrapper.findAll('button').find(b => b.text() === USB_BUTTON)
}

describe('BloodPressureMeasurement — 測定台で血圧計が使えないときの USB 許可 (Refs #353)', () => {
  beforeEach(() => {
    bpUiState.value = 'unregistered'
    nfcReadHandlers.length = 0
    getEmployeeByNfcIdMock.mockReset()
    requestPortMock.mockClear()
  })

  it.each(NOT_SHOW_STATES)('測定台 (%s): 案内を残したまま「USB デバイスを選択」を出す', async (state) => {
    bpUiState.value = state
    const wrapper = await mountBp(STATION_ROUTE)

    // 状況の説明は残す
    expect(wrapper.text()).toContain(NOT_FOUND)
    // 許可が無い PC はここから USB 許可へ辿り着ける (これが無いと永久に抜けられない)
    expect(wrapper.findComponent(NfcStatus).exists()).toBe(true)
    expect(usbButton(wrapper)).toBeTruthy()
    // 測定台向けの案内文 (CoreS3 ではなく ATOM S3 を名指しする)
    expect(wrapper.text()).toContain('測定台の ATOM S3 (VoiceS3R) が USB でつながっているか確認してください。')

    wrapper.unmount()
  })

  it('測定台: 押した許可ボタンが requestPort に届く', async () => {
    const wrapper = await mountBp(STATION_ROUTE)
    await usbButton(wrapper)!.trigger('click')
    expect(requestPortMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('測定台: この画面で読んだカードでは点呼にも測定にも進まない', async () => {
    const wrapper = await mountBp(STATION_ROUTE)
    expect(nfcReadHandlers.length).toBeGreaterThan(0)

    for (const handler of nfcReadHandlers) {
      handler({ employee_id: 'test-card-0001', source: 'bridge' } as NfcReadEvent)
    }
    await wrapper.vm.$nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    // 従業員を引きに行かない・顔認証の段へ進まない・案内のまま
    expect(getEmployeeByNfcIdMock).not.toHaveBeenCalled()
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
    expect(wrapper.text()).toContain(NOT_FOUND)

    wrapper.unmount()
  })

  it('測定台: checking の間は待つ (NfcStatus も案内も出さない)', async () => {
    bpUiState.value = 'checking'
    const wrapper = await mountBp(STATION_ROUTE)

    expect(wrapper.text()).toContain('血圧計を確認しています')
    expect(wrapper.text()).not.toContain(NOT_FOUND)
    expect(wrapper.findComponent(NfcStatus).exists()).toBe(false)

    wrapper.unmount()
  })

  it('測定台: show なら NfcStatus は 1 つだけ (カードの段。案内は出ない)', async () => {
    bpUiState.value = 'show'
    const wrapper = await mountBp(STATION_ROUTE)

    expect(wrapper.findAllComponents(NfcStatus)).toHaveLength(1)
    expect(wrapper.text()).not.toContain(NOT_FOUND)

    wrapper.unmount()
  })

  // --- 退行ガード: CoreS3 キオスク (`?station=bp` でない) は 1 字も変えない ---

  it.each(NOT_SHOW_STATES)('CoreS3 キオスク (%s): 従来どおり案内だけ (NfcStatus も USB 許可も出さない)', async (state) => {
    bpUiState.value = state
    const wrapper = await mountBp()

    expect(wrapper.text().replace(/\s+/g, '')).toBe(
      '血圧測定血圧計が見つかりません血圧計の電源が入っていて、この端末とペアリング済みか確認してください。',
    )
    expect(wrapper.findComponent(NfcStatus).exists()).toBe(false)
    expect(usbButton(wrapper)).toBeFalsy()

    wrapper.unmount()
  })

  it('CoreS3 キオスク: 血圧タブ (?tab=bp) だけでは測定台として扱わない', async () => {
    // `tab=` はハンバーガーで血圧測定タブを選んだだけでも付く。「測定台として起動したか」は
    // 通常端末の URL 同期が書き込まない `station=` で見る (pages/index.vue の isBpStation)
    const wrapper = await mountBp('/?role=driver&tab=bp')

    expect(wrapper.text()).toContain(NOT_FOUND)
    expect(wrapper.findComponent(NfcStatus).exists()).toBe(false)
    expect(usbButton(wrapper)).toBeFalsy()

    wrapper.unmount()
  })
})
