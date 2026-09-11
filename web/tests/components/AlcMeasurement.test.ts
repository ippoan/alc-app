import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import AlcMeasurement from '~/components/AlcMeasurement.vue'
import type { AlcoholReading } from '~/types'

// --- useFc1200Serial (PC 直結) のモック ---

const fc1200IsConnected = ref(false)
const fc1200State = ref('idle')
const fc1200Error = ref<string | null>(null)
const fc1200Result = ref<{ alcoholValue: number, resultType: string, deviceUseCount: number } | null>(null)
const fc1200IsSupported = vi.fn(() => true)
const fc1200AutoConnect = vi.fn(async () => true)
const fc1200ScanDevices = vi.fn()
const fc1200StartMeasurement = vi.fn()
const fc1200ResetSession = vi.fn()

mockNuxtImport('useFc1200Serial', () => () => ({
  isConnected: fc1200IsConnected,
  state: fc1200State,
  error: fc1200Error,
  result: fc1200Result,
  isSupported: fc1200IsSupported,
  autoConnect: fc1200AutoConnect,
  scanDevices: fc1200ScanDevices,
  startMeasurement: fc1200StartMeasurement,
  resetSession: fc1200ResetSession,
}))

// --- useCoreS3Serial のモック (接続有無だけ切り替える) ---

const coreS3Connected = ref(false)
mockNuxtImport('useCoreS3Serial', () => () => ({
  isConnected: readonly(coreS3Connected),
  startupProbe: vi.fn(async () => false),
  isStartupProbing: readonly(ref(false)),
}))

// --- useBleGateway のモック (latestAlcohol と clearAlcoholReading だけ使う) ---

const latestAlcohol = ref<AlcoholReading | null>(null)
const clearAlcoholReadingMock = vi.fn(() => { latestAlcohol.value = null })

mockNuxtImport('useBleGateway', () => () => ({
  latestAlcohol: readonly(latestAlcohol),
  clearAlcoholReading: clearAlcoholReadingMock,
}))

async function mountAlc() {
  return await mountSuspended(AlcMeasurement, {
    props: { employeeId: 'emp-1' },
  })
}

describe('AlcMeasurement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fc1200IsConnected.value = false
    fc1200State.value = 'idle'
    fc1200Error.value = null
    fc1200Result.value = null
    fc1200IsSupported.mockReturnValue(true)
    fc1200AutoConnect.mockResolvedValue(true)
    coreS3Connected.value = false
    latestAlcohol.value = null
  })

  it('CoreS3 未接続なら従来どおり PC 直結 (useFc1200Serial) に自動接続する', async () => {
    const wrapper = await mountAlc()
    expect(fc1200AutoConnect).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('CoreS3 接続中は useFc1200Serial の autoConnect を呼ばない (二重計測防止)', async () => {
    coreS3Connected.value = true
    const wrapper = await mountAlc()
    expect(fc1200AutoConnect).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('CoreS3 接続中は案内メッセージを出す', async () => {
    coreS3Connected.value = true
    const wrapper = await mountAlc()
    expect(wrapper.text()).toContain('CoreS3 につないだアルコールチェッカーで測定してください')
    wrapper.unmount()
  })

  it('mount 時に latestAlcohol をクリアする (前の運転者の結果を再 emit しない)', async () => {
    latestAlcohol.value = {
      value: 0.2,
      unit: 'mg/L',
      result: 'over',
      useCount: 9,
      measuredAt: new Date('2026-01-01'),
    }
    const wrapper = await mountAlc()
    expect(clearAlcoholReadingMock).toHaveBeenCalledTimes(1)
    // clear の mock 実装が latestAlcohol を null に落とすので、古い値は emit されない
    expect(wrapper.emitted('result')).toBeUndefined()
    wrapper.unmount()
  })

  it('latestAlcohol の更新を result として emit する (CoreS3 経由)', async () => {
    coreS3Connected.value = true
    const wrapper = await mountAlc()

    latestAlcohol.value = {
      value: 0.15,
      unit: 'mg/L',
      result: 'normal',
      useCount: 3,
      measuredAt: new Date('2026-01-02T00:00:00Z'),
    }
    await wrapper.vm.$nextTick()

    const emitted = wrapper.emitted('result')
    expect(emitted).toHaveLength(1)
    expect(emitted![0]![0]).toEqual({
      employeeId: 'emp-1',
      alcoholValue: 0.15,
      resultType: 'normal',
      deviceUseCount: 3,
      measuredAt: new Date('2026-01-02T00:00:00Z'),
    })
    wrapper.unmount()
  })

  it('未接続 (WebSerial 非対応) なら従来どおりのエラー表示', async () => {
    fc1200IsSupported.mockReturnValue(false)
    const wrapper = await mountAlc()
    expect(wrapper.text()).toContain('FC-1200 接続非対応')
    wrapper.unmount()
  })
})
