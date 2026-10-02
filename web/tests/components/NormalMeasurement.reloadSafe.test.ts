import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly, defineComponent } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import NormalMeasurement from '~/components/NormalMeasurement.vue'
import { readReloadContext, resetReloadContext } from '~/composables/useKioskScreen'

// 本番 flip 後の新版への載せ替え (Refs ippoan/alc-app#387)。通常点呼・IT点呼 のタブはカードの
// タッチを待って開いたままになるので、待機中は「いまリロードして失うものが無い」と申告する。
// 段が `nfc` でも失うものがある間 (本人確認の照会中・手入力の途中・IC カードの打刻の案内・同期中)
// は申告を下ろす。読むのは plugin と同じ口 (`readReloadContext`)。
// 従業員・カードはすべて合成値

// --- API のモック ---

const getEmployeeByNfcIdMock = vi.fn()
const getEmployeeByCodeMock = vi.fn()
const startMeasurementMock = vi.fn()
const punchTimecardMock = vi.fn()

vi.mock('~/utils/api', () => ({
  getEmployeeByNfcId: (nfcId: string) => getEmployeeByNfcIdMock(nfcId),
  getEmployeeByCode: (code: string) => getEmployeeByCodeMock(code),
  punchTimecard: (cardId: string) => punchTimecardMock(cardId),
  startMeasurement: (id: string) => startMeasurementMock(id),
  updateMeasurement: vi.fn(async () => ({})),
  uploadBlowVideo: vi.fn(async () => ''),
  lookupCarInspection: vi.fn(async () => null),
}))

vi.mock('~/utils/video-store', () => ({
  saveVideo: vi.fn(async () => 'video-1'),
  markVideoUploaded: vi.fn(async () => {}),
  getPendingVideos: vi.fn(async () => []),
  cleanupOldVideos: vi.fn(async () => {}),
}))

// --- composable のモック (測定フロー本体は動かさない) ---

mockNuxtImport('useDemoMode', () => () => ({ isDemoMode: ref(false) }))

// 未送信の測定の同期中 / 顔データの同期中 (値を差し替えられる ref)
const offlineSyncingRef = ref(false)
mockNuxtImport('useOfflineSync', () => () => ({
  isOnline: ref(true),
  pending: ref(0),
  isSyncing: offlineSyncingRef,
  save: vi.fn(),
  syncQueue: vi.fn(),
}))

const faceSyncingRef = ref(false)
const faceSyncMock = vi.fn()
mockNuxtImport('useFaceSync', () => () => ({ isSyncing: faceSyncingRef, sync: faceSyncMock }))

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
  alcoholStage: readonly(ref(null)),
}))

mockNuxtImport('useBpUiEnabled', () => () => ({ bpUiState: ref('unused'), showBpUi: ref(false) }))
mockNuxtImport('useStrayAlcohol', () => () => ({ latest: readonly(ref(null)) }))
mockNuxtImport('useCoreS3Stage', () => () => ({ syncStep: vi.fn(), sendResult: vi.fn() }))
mockNuxtImport('useCoreS3Serial', () => () => ({ onEvent: () => () => {} }))

const NfcStatusStub = defineComponent({
  name: 'NfcStatus',
  emits: ['read'],
  template: '<div data-testid="nfc-stub" />',
})

const EMPLOYEE = { id: 'emp-1', name: 'テスト太郎' }

type Wrapper = Awaited<ReturnType<typeof mountView>>

function mountView(props: Record<string, unknown> = {}) {
  return mountSuspended(NormalMeasurement, {
    props,
    global: { stubs: { NfcStatus: NfcStatusStub, BleStatus: true, ClientOnly: false, Teleport: true } },
  })
}

const safe = () => readReloadContext().safe

async function settle(wrapper: Wrapper) {
  await new Promise(resolve => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
}

/** カードのタッチ (応答は待たない)。第 4 引数はカードの種類 */
function tap(wrapper: Wrapper, nfcId: string, source?: string, cardType?: string) {
  wrapper.findComponent(NfcStatusStub).vm.$emit('read', nfcId, undefined, source, cardType)
}

/** 応答を自分で返す mock。呼ばれるたびに 1 件ずつ積む */
function defer(mock: ReturnType<typeof vi.fn>) {
  const calls: Array<{ resolve: (v?: unknown) => void, reject: (e: unknown) => void }> = []
  mock.mockImplementation(() => new Promise((resolve, reject) => { calls.push({ resolve, reject }) }))
  return calls
}

const nfcShown = (wrapper: Wrapper) => wrapper.findComponent(NfcStatusStub).exists()
const exposed = (wrapper: Wrapper) => wrapper.vm as unknown as {
  startForEmployee: (id: string, name: string, readOnThisDevice?: boolean) => Promise<boolean>
}

async function openManualInput(wrapper: Wrapper) {
  await wrapper.findAll('button').find(b => b.text() === '手動でIDを入力する')!.trigger('click')
  return wrapper.find('input[type="text"]')
}

beforeEach(() => {
  vi.clearAllMocks()
  resetReloadContext()
  offlineSyncingRef.value = false
  faceSyncingRef.value = false
  getEmployeeByNfcIdMock.mockImplementation(async () => EMPLOYEE)
  getEmployeeByCodeMock.mockImplementation(async () => EMPLOYEE)
  startMeasurementMock.mockImplementation(async () => ({ id: 'measurement-1' }))
  punchTimecardMock.mockImplementation(async () => {})
  faceSyncMock.mockImplementation(async () => {})
})

describe('NormalMeasurement — 新版への載せ替えの申告 (Refs ippoan/alc-app#387)', () => {
  it('★ 待機中 (カードのタッチ待ち) は安全。画面を離れたら申告を残さない', async () => {
    const wrapper = await mountView()
    expect(readReloadContext()).toEqual({ screen: null, safe: 1, blocked: 0 })

    wrapper.unmount()
    expect(readReloadContext()).toEqual({ screen: null, safe: 0, blocked: 0 })
  })

  it('★ IT点呼 のタブ (itMode) でも待機中は安全。免許証でないタッチを断っただけでは外れない', async () => {
    const wrapper = await mountView({ itMode: true })
    expect(safe()).toBe(1)

    tap(wrapper, 'test-card-0001')
    await settle(wrapper)
    expect(getEmployeeByNfcIdMock).not.toHaveBeenCalled()
    expect(safe()).toBe(1)
    wrapper.unmount()
  })

  describe('カードのタッチ (onNfcRead)', () => {
    it('★ 社員の照合中は、段が nfc のままでも外れる。進んだ先でも外れたまま', async () => {
      const lookups = defer(getEmployeeByNfcIdMock)
      const wrapper = await mountView()

      tap(wrapper, 'test-card-0001')
      expect(lookups).toHaveLength(1)
      expect(nfcShown(wrapper)).toBe(true)
      expect(safe()).toBe(0)

      lookups[0]!.resolve(EMPLOYEE)
      await settle(wrapper)
      expect(nfcShown(wrapper)).toBe(false)
      expect(wrapper.find('[data-testid="choice-alcohol"]').exists()).toBe(true)
      expect(safe()).toBe(0)
      wrapper.unmount()
    })

    it('★ 照合の後の測定の開始・打刻を待っている間も外れたまま', async () => {
      const starts = defer(startMeasurementMock)
      const punches = defer(punchTimecardMock)
      const wrapper = await mountView()

      tap(wrapper, 'test-card-0001', 'bridge')
      await settle(wrapper)
      // 測定の開始レコードの応答待ち
      expect(starts).toHaveLength(1)
      expect(nfcShown(wrapper)).toBe(true)
      expect(safe()).toBe(0)

      starts[0]!.resolve({ id: 'measurement-1' })
      await settle(wrapper)
      // 打刻の応答待ち
      expect(punches).toHaveLength(1)
      expect(nfcShown(wrapper)).toBe(true)
      expect(safe()).toBe(0)

      punches[0]!.resolve()
      await settle(wrapper)
      expect(nfcShown(wrapper)).toBe(false)
      expect(safe()).toBe(0)
      wrapper.unmount()
    })

    it('★ 照合が失敗で終わったら、待機に戻って安全になる', async () => {
      const lookups = defer(getEmployeeByNfcIdMock)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const wrapper = await mountView()

      tap(wrapper, 'test-card-0001')
      expect(safe()).toBe(0)
      lookups[0]!.reject(new Error('not found'))
      await settle(wrapper)
      expect(nfcShown(wrapper)).toBe(true)
      expect(safe()).toBe(1)
      wrapper.unmount()
    })

    it('★ 2 回目のタッチが先に終わっても、1 回目の応答を待っている間は外れたまま', async () => {
      const lookups = defer(getEmployeeByNfcIdMock)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const wrapper = await mountView()

      tap(wrapper, 'test-card-0001')
      tap(wrapper, 'test-card-0002')
      expect(lookups).toHaveLength(2)
      lookups[1]!.reject(new Error('not found'))
      await settle(wrapper)
      expect(safe()).toBe(0)

      lookups[0]!.reject(new Error('not found'))
      await settle(wrapper)
      expect(safe()).toBe(1)
      wrapper.unmount()
    })
  })

  describe('手入力 (onManualSubmit)', () => {
    it('★ 手入力の欄を開いただけでは外れない。文字が在る間は外れ、消したら戻る', async () => {
      const wrapper = await mountView()
      const input = await openManualInput(wrapper)
      expect(safe()).toBe(1)

      await input.setValue('00')
      expect(safe()).toBe(0)
      await input.setValue('')
      expect(safe()).toBe(1)
      wrapper.unmount()
    })

    it('★ 社員番号の照会中は外れ、進んだ先でも外れたまま', async () => {
      const lookups = defer(getEmployeeByCodeMock)
      const wrapper = await mountView()
      const input = await openManualInput(wrapper)
      await input.setValue('001')
      await input.trigger('keyup.enter')
      expect(lookups).toHaveLength(1)
      expect(safe()).toBe(0)

      lookups[0]!.resolve(EMPLOYEE)
      await settle(wrapper)
      expect(wrapper.find('[data-testid="choice-alcohol"]').exists()).toBe(true)
      expect(safe()).toBe(0)
      wrapper.unmount()
    })

    it('★ 照会が失敗で終わったら照会中の印は戻る (欄の文字が残る間は外れたまま)', async () => {
      const lookups = defer(getEmployeeByCodeMock)
      const wrapper = await mountView()
      const input = await openManualInput(wrapper)
      await input.setValue('999')
      await input.trigger('keyup.enter')
      // 照会中は、欄を消しても外れたまま (段が nfc のまま応答を待っている)
      await input.setValue('')
      expect(safe()).toBe(0)

      lookups[0]!.reject(new Error('not found'))
      await settle(wrapper)
      expect(wrapper.text()).toContain('999')
      expect(safe()).toBe(1)
      wrapper.unmount()
    })
  })

  describe('IC カードの打刻の案内 (startForEmployee・icPromptActive)', () => {
    it('★ 案内が出ている間は外れ、消えたら戻る', async () => {
      const wrapper = await mountView({ icPromptActive: true })
      expect(safe()).toBe(0)

      await wrapper.setProps({ icPromptActive: false })
      expect(safe()).toBe(1)
      await wrapper.setProps({ icPromptActive: true })
      expect(safe()).toBe(0)
      wrapper.unmount()
    })

    it('★ 案内のボタンから始めた回は、測定の開始を待っている間も外れる', async () => {
      const starts = defer(startMeasurementMock)
      const wrapper = await mountView()
      expect(safe()).toBe(1)

      const started = exposed(wrapper).startForEmployee('emp-9', 'テスト花子', true)
      expect(starts).toHaveLength(1)
      expect(nfcShown(wrapper)).toBe(true)
      expect(safe()).toBe(0)

      starts[0]!.resolve({ id: 'measurement-1' })
      expect(await started).toBe(true)
      await wrapper.vm.$nextTick()
      expect(nfcShown(wrapper)).toBe(false)
      expect(safe()).toBe(0)
      wrapper.unmount()
    })

    it('★ 始める途中で例外になっても、待機に残るなら照会中の印は戻る', async () => {
      faceSyncMock.mockImplementation(() => { throw new Error('sync broken') })
      const wrapper = await mountView()

      await expect(exposed(wrapper).startForEmployee('emp-9', 'テスト花子', true)).rejects.toThrow('sync broken')
      expect(nfcShown(wrapper)).toBe(true)
      expect(safe()).toBe(1)
      wrapper.unmount()
    })
  })

  describe('同期中', () => {
    it('★ 未送信の測定を同期している間は外れる', async () => {
      const wrapper = await mountView()
      expect(safe()).toBe(1)

      offlineSyncingRef.value = true
      expect(safe()).toBe(0)
      offlineSyncingRef.value = false
      expect(safe()).toBe(1)
      wrapper.unmount()
    })

    it('★ 顔データを同期している間は外れる', async () => {
      const wrapper = await mountView()
      expect(safe()).toBe(1)

      faceSyncingRef.value = true
      expect(safe()).toBe(0)
      faceSyncingRef.value = false
      expect(safe()).toBe(1)
      wrapper.unmount()
    })
  })
})
