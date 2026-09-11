import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, readonly } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'

let webSerialSupported = true
vi.mock('~/utils/webserial', () => ({
  isWebSerialSupported: () => webSerialSupported,
}))

const isConnected = ref(false)
const thermometerConnected = ref(false)
const bloodPressureConnected = ref(false)
const latestTemperature = ref<{ value: number } | null>(null)
const latestBloodPressure = ref<{ systolic: number, diastolic: number, pulse?: number } | null>(null)
const hasMedicalData = ref(false)
const startAutoConnectMock = vi.fn(async () => true)
const clearReadingsMock = vi.fn()
const resetGatewayMock = vi.fn()

mockNuxtImport('useBleGateway', () => () => ({
  isConnected: readonly(isConnected),
  error: ref<string | null>(null),
  thermometerConnected: readonly(thermometerConnected),
  bloodPressureConnected: readonly(bloodPressureConnected),
  latestTemperature: readonly(latestTemperature),
  latestBloodPressure: readonly(latestBloodPressure),
  hasMedicalData: readonly(hasMedicalData),
  transport: ref(null),
  connect: vi.fn(),
  startAutoConnect: startAutoConnectMock,
  clearReadings: clearReadingsMock,
  resetGateway: resetGatewayMock,
}))

const AUTO_NEXT_DELAY_MS = 1500

// SHOW_BLOOD_PRESSURE / MEDICAL_AUTO_NEXT_DELAY_MS は定数エクスポートなので、値ごとに
// vi.doMock + resetModules で component を取り直す (モジュールスコープ状態のテスト分離
// パターンに準拠)。
describe('BleStatus — CoreS3 前提の文言・血圧の出し分け (Refs #238)', () => {
  beforeEach(() => {
    vi.resetModules()
    webSerialSupported = true
    isConnected.value = false
    thermometerConnected.value = false
    bloodPressureConnected.value = false
    latestTemperature.value = null
    latestBloodPressure.value = null
    hasMedicalData.value = false
    startAutoConnectMock.mockReset()
    startAutoConnectMock.mockResolvedValue(true)
    clearReadingsMock.mockReset()
    resetGatewayMock.mockReset()
  })

  it('未接続なら CoreS3 前提の文言を出す (ATOM Lite の文言は残らない)', async () => {
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: false, MEDICAL_AUTO_NEXT_DELAY_MS: AUTO_NEXT_DELAY_MS }))
    startAutoConnectMock.mockResolvedValue(false)
    const { default: BleStatus } = await import('~/components/BleStatus.vue')
    const wrapper = await mountSuspended(BleStatus)
    // onMounted の startAutoConnect (async) を消化
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('CoreS3 が見つかりません')
    expect(wrapper.text()).toContain('CoreS3 が USB でつながっているか確認してください')
    expect(wrapper.text()).not.toContain('ATOM Lite')
    const btn = wrapper.findAll('button').find(b => b.text() === 'USB デバイスを選択')
    expect(btn).toBeTruthy()

    wrapper.unmount()
  })

  it('SHOW_BLOOD_PRESSURE=false: 接続中でも血圧の表示が出ない', async () => {
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: false, MEDICAL_AUTO_NEXT_DELAY_MS: AUTO_NEXT_DELAY_MS }))
    isConnected.value = true
    latestBloodPressure.value = { systolic: 120, diastolic: 80 }
    const { default: BleStatus } = await import('~/components/BleStatus.vue')
    const wrapper = await mountSuspended(BleStatus)

    expect(wrapper.text()).not.toContain('血圧')

    wrapper.unmount()
  })

  it('SHOW_BLOOD_PRESSURE=true: 接続中は従来どおり血圧を出す', async () => {
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: true, MEDICAL_AUTO_NEXT_DELAY_MS: AUTO_NEXT_DELAY_MS }))
    isConnected.value = true
    latestBloodPressure.value = { systolic: 118, diastolic: 76 }
    const { default: BleStatus } = await import('~/components/BleStatus.vue')
    const wrapper = await mountSuspended(BleStatus)

    expect(wrapper.text()).toContain('血圧')
    expect(wrapper.text()).toContain('118')
    expect(wrapper.text()).toContain('76')

    wrapper.unmount()
  })

  it('測り直すボタンは resetGateway + clearReadings を呼ぶ', async () => {
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: false, MEDICAL_AUTO_NEXT_DELAY_MS: AUTO_NEXT_DELAY_MS }))
    isConnected.value = true
    latestTemperature.value = { value: 36.5 }
    hasMedicalData.value = true
    const { default: BleStatus } = await import('~/components/BleStatus.vue')
    const wrapper = await mountSuspended(BleStatus)

    const btn = wrapper.findAll('button').find(b => b.text() === '測り直す')
    expect(btn).toBeTruthy()
    await btn!.trigger('click')

    expect(resetGatewayMock).toHaveBeenCalledTimes(1)
    // clearReadings は mount 時 (onMounted) にも 1 回呼ばれているので合計 2 回
    expect(clearReadingsMock).toHaveBeenCalledTimes(2)

    wrapper.unmount()
  })
})

describe('BleStatus — 体温到達で自動的に次へ進む (SHOW_BLOOD_PRESSURE=false、Refs #238)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    isConnected.value = true
    thermometerConnected.value = true
    latestTemperature.value = null
    latestBloodPressure.value = null
    hasMedicalData.value = false
    clearReadingsMock.mockReset()
    resetGatewayMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('mount 後に体温が届くと MEDICAL_AUTO_NEXT_DELAY_MS 後に next が 1 回だけ発火する', async () => {
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: false, MEDICAL_AUTO_NEXT_DELAY_MS: AUTO_NEXT_DELAY_MS }))
    const { default: BleStatus } = await import('~/components/BleStatus.vue')
    const wrapper = await mountSuspended(BleStatus)

    // mount 後に新しい体温が届く
    latestTemperature.value = { value: 36.5 }
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('next')).toBeFalsy()
    await vi.advanceTimersByTimeAsync(AUTO_NEXT_DELAY_MS)

    expect(wrapper.emitted('next')).toHaveLength(1)

    // 続けて値が更新されても 2 回目が飛ばないこと (再スキャン等をしない限り)
    await vi.advanceTimersByTimeAsync(AUTO_NEXT_DELAY_MS)
    expect(wrapper.emitted('next')).toHaveLength(1)

    wrapper.unmount()
  })

  it('mount 時点で既に値がある (前の運転者の値) なら自動で進まない', async () => {
    // clearReadings は mock なので実際には消えない = mount 前の値が残るケースを再現
    latestTemperature.value = { value: 36.2 }
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: false, MEDICAL_AUTO_NEXT_DELAY_MS: AUTO_NEXT_DELAY_MS }))
    const { default: BleStatus } = await import('~/components/BleStatus.vue')
    const wrapper = await mountSuspended(BleStatus)

    await vi.advanceTimersByTimeAsync(AUTO_NEXT_DELAY_MS + 1000)
    expect(wrapper.emitted('next')).toBeFalsy()

    wrapper.unmount()
  })

  it('1500ms 経つ前に unmount したら next は飛ばない', async () => {
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: false, MEDICAL_AUTO_NEXT_DELAY_MS: AUTO_NEXT_DELAY_MS }))
    const { default: BleStatus } = await import('~/components/BleStatus.vue')
    const wrapper = await mountSuspended(BleStatus)

    latestTemperature.value = { value: 36.5 }
    await wrapper.vm.$nextTick()
    wrapper.unmount()

    await vi.advanceTimersByTimeAsync(AUTO_NEXT_DELAY_MS + 1000)
    expect(wrapper.emitted('next')).toBeFalsy()
  })

  it('1500ms 経つ前に「次へ」を手動で押したら、その後タイマーは追加の next を出さない', async () => {
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: false, MEDICAL_AUTO_NEXT_DELAY_MS: AUTO_NEXT_DELAY_MS }))
    hasMedicalData.value = true
    const { default: BleStatus } = await import('~/components/BleStatus.vue')
    const wrapper = await mountSuspended(BleStatus)

    latestTemperature.value = { value: 36.5 }
    await wrapper.vm.$nextTick()

    const nextBtn = wrapper.findAll('button').find(b => b.text() === '次へ')
    await nextBtn!.trigger('click')
    expect(wrapper.emitted('next')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(AUTO_NEXT_DELAY_MS + 1000)
    // 手動の 1 回だけ (自動発火による 2 回目が無い)
    expect(wrapper.emitted('next')).toHaveLength(1)

    wrapper.unmount()
  })

  it('1500ms 経つ前に「スキップ」を押したら next は飛ばない', async () => {
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: false, MEDICAL_AUTO_NEXT_DELAY_MS: AUTO_NEXT_DELAY_MS }))
    hasMedicalData.value = true
    const { default: BleStatus } = await import('~/components/BleStatus.vue')
    const wrapper = await mountSuspended(BleStatus)

    latestTemperature.value = { value: 36.5 }
    await wrapper.vm.$nextTick()

    const skipBtn = wrapper.findAll('button').find(b => b.text() === 'スキップ')
    await skipBtn!.trigger('click')
    expect(wrapper.emitted('skip')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(AUTO_NEXT_DELAY_MS + 1000)
    expect(wrapper.emitted('next')).toBeFalsy()

    wrapper.unmount()
  })

  it('1500ms 経つ前に測り直すと、タイマーが解除されて next は飛ばない', async () => {
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: false, MEDICAL_AUTO_NEXT_DELAY_MS: AUTO_NEXT_DELAY_MS }))
    hasMedicalData.value = true
    const { default: BleStatus } = await import('~/components/BleStatus.vue')
    const wrapper = await mountSuspended(BleStatus)

    latestTemperature.value = { value: 36.5 }
    await wrapper.vm.$nextTick()

    const rescanBtn = wrapper.findAll('button').find(b => b.text() === '測り直す')
    await rescanBtn!.trigger('click')
    expect(resetGatewayMock).toHaveBeenCalledTimes(1)
    // clearReadings は mount 時 (onMounted) にも 1 回呼ばれているので合計 2 回
    expect(clearReadingsMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(AUTO_NEXT_DELAY_MS + 1000)
    expect(wrapper.emitted('next')).toBeFalsy()

    wrapper.unmount()
  })

  it('SHOW_BLOOD_PRESSURE=true なら体温が届いても自動で進まない (血圧を待つ運用)', async () => {
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: true, MEDICAL_AUTO_NEXT_DELAY_MS: AUTO_NEXT_DELAY_MS }))
    const { default: BleStatus } = await import('~/components/BleStatus.vue')
    const wrapper = await mountSuspended(BleStatus)

    latestTemperature.value = { value: 36.5 }
    await wrapper.vm.$nextTick()

    await vi.advanceTimersByTimeAsync(AUTO_NEXT_DELAY_MS + 1000)
    expect(wrapper.emitted('next')).toBeFalsy()

    wrapper.unmount()
  })
})
