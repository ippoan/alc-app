import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly, defineComponent } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import NormalMeasurement from '~/components/NormalMeasurement.vue'
import { employeeNotFoundByNfc } from '~/utils/employee-lookup-messages'

// --- API のモック (NFC → 乗務員照合だけを動かす) ---

const getEmployeeByNfcIdMock = vi.fn()

vi.mock('~/utils/api', () => ({
  getEmployeeByNfcId: (nfcId: string) => getEmployeeByNfcIdMock(nfcId),
  getEmployeeByCode: vi.fn(),
  startMeasurement: vi.fn(async () => ({ id: 'measurement-1' })),
  updateMeasurement: vi.fn(async () => ({})),
  uploadFacePhoto: vi.fn(async () => 'https://example.com/face.jpg'),
  uploadBlowVideo: vi.fn(async () => 'https://example.com/blow.webm'),
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

mockNuxtImport('useOfflineSync', () => () => ({
  isOnline: ref(true),
  pending: ref(0),
  isSyncing: ref(false),
  save: vi.fn(),
  syncQueue: vi.fn(),
}))

mockNuxtImport('useAuth', () => () => ({
  isDeviceActivated: ref(true),
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

mockNuxtImport('useBleGateway', () => () => ({
  latestTemperature: readonly(ref(null)),
  latestBloodPressure: readonly(ref(null)),
}))

mockNuxtImport('useFingerprint', () => () => ({
  isFingerprintAvailable: ref(false),
  isEmployeeAuthorized: () => false,
  authorizeEmployee: vi.fn(),
  requestFingerprint: vi.fn(),
}))

// NfcStatus は表示と emit('read') だけなので、read を直接投げられるスタブに差し替える
const NfcStatusStub = defineComponent({
  name: 'NfcStatus',
  emits: ['read'],
  template: '<div data-testid="nfc-stub" />',
})

const APPROVED_EMPLOYEE = { id: 'emp-1', name: '山田太郎', face_approval_status: 'approved' }

async function mountNfcStep() {
  const wrapper = await mountSuspended(NormalMeasurement, {
    global: { stubs: { NfcStatus: NfcStatusStub, ClientOnly: false, Teleport: true } },
  })
  return wrapper
}

/** NfcStatus の read を発火させ、onNfcRead の await を消化する */
async function touch(wrapper: Awaited<ReturnType<typeof mountNfcStep>>, nfcId: string) {
  wrapper.findComponent(NfcStatusStub).vm.$emit('read', nfcId)
  await new Promise(resolve => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
}

describe('NormalMeasurement — NFC ステップの乗務員照合', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('免許証が乗務員に未登録 (by-nfc が失敗) なら赤枠に理由と次の操作を出す', async () => {
    getEmployeeByNfcIdMock.mockRejectedValue(new Error('404'))
    const wrapper = await mountNfcStep()

    await touch(wrapper, '2601012901010')

    const alert = wrapper.find('.bg-red-50')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toBe(employeeNotFoundByNfc('2601012901010'))
    // 進まない (顔認証の見出しは出ない)
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
})
