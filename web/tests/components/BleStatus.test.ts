import { describe, it, expect, vi, beforeEach } from 'vitest'
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
  clearReadings: vi.fn(),
  resetGateway: vi.fn(),
}))

// SHOW_BLOOD_PRESSURE は定数エクスポートなので、値ごとに vi.doMock + resetModules で
// component を取り直す (モジュールスコープ状態のテスト分離パターンに準拠)。
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
  })

  it('未接続なら CoreS3 前提の文言を出す (ATOM Lite の文言は残らない)', async () => {
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: false }))
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
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: false }))
    isConnected.value = true
    latestBloodPressure.value = { systolic: 120, diastolic: 80 }
    const { default: BleStatus } = await import('~/components/BleStatus.vue')
    const wrapper = await mountSuspended(BleStatus)

    expect(wrapper.text()).not.toContain('血圧')

    wrapper.unmount()
  })

  it('SHOW_BLOOD_PRESSURE=true: 接続中は従来どおり血圧を出す', async () => {
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: true }))
    isConnected.value = true
    latestBloodPressure.value = { systolic: 118, diastolic: 76 }
    const { default: BleStatus } = await import('~/components/BleStatus.vue')
    const wrapper = await mountSuspended(BleStatus)

    expect(wrapper.text()).toContain('血圧')
    expect(wrapper.text()).toContain('118')
    expect(wrapper.text()).toContain('76')

    wrapper.unmount()
  })
})
