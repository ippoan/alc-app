import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TenkoKiosk from '~/components/TenkoKiosk.vue'

// 遠隔点呼では点呼種別が常に「業務前」に固定され業務後の点呼を開始できなかった (#309 は
// 本番に予定を持つ社員が 0 人のため発火しなかった)。予定に依存せず画面で選べるようにする
// トグル UI の配線を見る (Refs #310)。
//
// ここも **useTenkoKiosk を本物のまま**使う (composable のロジックは
// tests/composables/useTenkoKiosk.test.ts が担当。ここでは画面との配線だけを見る)。

const getPendingSchedules = vi.fn()

vi.mock('~/utils/api', () => ({
  getEmployeeByNfcId: vi.fn(),
  getEmployeeByCode: vi.fn(),
  getPendingSchedules: (...args: unknown[]) => getPendingSchedules(...args),
  startTenkoSession: vi.fn(),
  escalateTenkoSessionToRemote: vi.fn(),
  submitAlcohol: vi.fn(),
  submitMedical: vi.fn(),
  submitSelfDeclaration: vi.fn(),
  submitDailyInspection: vi.fn(),
  confirmInstruction: vi.fn(),
  submitReport: vi.fn(),
  cancelTenkoSession: vi.fn(),
  uploadFacePhoto: vi.fn(),
  getCarryingItems: vi.fn(async () => []),
  submitCarryingItemChecks: vi.fn(),
}))

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
  stream: ref(null),
  videoRef: ref(null),
  isActive: ref(false),
  start: vi.fn(async () => {}),
  stop: vi.fn(),
}))
mockNuxtImport('useFaceSync', () => () => ({ isSyncing: ref(false), sync: vi.fn(async () => {}) }))
mockNuxtImport('useDemoMode', () => () => ({ isDemoMode: ref(false) }))
mockNuxtImport('useBleGateway', () => () => ({ latestTemperature: ref(null), latestBloodPressure: ref(null) }))
mockNuxtImport('useFingerprint', () => () => ({
  isFingerprintAvailable: ref(false),
  isEmployeeAuthorized: vi.fn(() => false),
  authorizeEmployee: vi.fn(),
  requestFingerprint: vi.fn(),
}))
mockNuxtImport('useBloodPressureSetting', () => () => ({ bpEnabled: ref(true), setBpEnabled: vi.fn() }))
mockNuxtImport('useCoreS3Stage', () => () => ({ syncStep: vi.fn(), sendResult: vi.fn() }))

function toggleButtons(wrapper: Awaited<ReturnType<typeof mountSuspended>>) {
  return {
    pre: wrapper.findAll('button').find(b => b.text() === '業務前'),
    post: wrapper.findAll('button').find(b => b.text() === '業務後'),
  }
}

describe('TenkoKiosk — 遠隔点呼で点呼種別を選ぶ (Refs #310)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getPendingSchedules.mockResolvedValue([])
  })

  it('(e) remoteMode ではトグルが描画され、クリックで選択色が変わる (既定は業務前)', async () => {
    const wrapper = await mountSuspended(TenkoKiosk, { shallow: true, props: { remoteMode: true } })

    const before = toggleButtons(wrapper)
    expect(before.pre).toBeDefined()
    expect(before.post).toBeDefined()
    // 未選択でも tenkoType の既定 (業務前) がハイライトされる → 専用の既定値 state は不要
    expect(before.pre!.classes()).toContain('bg-blue-600')
    expect(before.post!.classes()).not.toContain('bg-orange-500')

    await before.post!.trigger('click')

    const after = toggleButtons(wrapper)
    expect(after.post!.classes()).toContain('bg-orange-500')
    expect(after.pre!.classes()).not.toContain('bg-blue-600')
    wrapper.unmount()
  })

  it('remoteMode でなければトグルは描画されない', async () => {
    const wrapper = await mountSuspended(TenkoKiosk, { shallow: true, props: { remoteMode: false } })
    const { pre, post } = toggleButtons(wrapper)
    expect(pre).toBeUndefined()
    expect(post).toBeUndefined()
    wrapper.unmount()
  })
})
