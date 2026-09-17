import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import AlcMeasurement from '~/components/AlcMeasurement.vue'
import type { AlcoholReading, Fc1200State } from '~/types'

// --- useFc1200Serial (PC 直結) のモック ---

const fc1200IsConnected = ref(false)
const fc1200State = ref('idle')
const fc1200Error = ref<string | null>(null)
const fc1200Result = ref<{ alcoholValue: number, resultType: string, deviceUseCount: number, measuredAt: Date } | null>(null)
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

// --- useBleGateway のモック (latestAlcohol / alcoholStage / clearAlcoholReading だけ使う) ---

const latestAlcohol = ref<AlcoholReading | null>(null)
const alcoholStage = ref<Fc1200State | null>(null)
const clearAlcoholReadingMock = vi.fn(() => { latestAlcohol.value = null })

mockNuxtImport('useBleGateway', () => () => ({
  latestAlcohol: readonly(latestAlcohol),
  alcoholStage: readonly(alcoholStage),
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
    alcoholStage.value = null
  })

  it('CoreS3 未接続なら PC 直結 (useFc1200Serial) に自動接続する', async () => {
    const wrapper = await mountAlc()
    expect(fc1200AutoConnect).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('CoreS3 接続中でも PC 直結 (useFc1200Serial) の autoConnect は呼ぶ (#238 — CoreS3 は NFC/認証だけの運用もある)', async () => {
    coreS3Connected.value = true
    const wrapper = await mountAlc()
    expect(fc1200AutoConnect).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('CoreS3 接続中は案内メッセージを出す (PC 直結の「見つかりません」等は出さない)', async () => {
    coreS3Connected.value = true
    fc1200AutoConnect.mockResolvedValue(false)
    const wrapper = await mountAlc()
    expect(wrapper.text()).toContain('CoreS3 につないだアルコールチェッカーで測定してください')
    expect(wrapper.text()).not.toContain('FC-1200 が見つかりません')
    wrapper.unmount()
  })

  // =============================================
  // CoreS3 の進み (alcoholStage) を PC 直結と同じ語彙で出す (#238)
  // =============================================

  describe('CoreS3 側の進み表示', () => {
    it('alcoholStage が blow_waiting → 「息を吹きかけてください」を含み、「進み具合」は含まない', async () => {
      coreS3Connected.value = true
      alcoholStage.value = 'blow_waiting'
      const wrapper = await mountAlc()
      expect(wrapper.text()).toContain('息を吹きかけてください')
      expect(wrapper.text()).not.toContain('進み具合')
      wrapper.unmount()
    })

    it('alcoholStage が warming_up → 「ウォームアップ中」', async () => {
      coreS3Connected.value = true
      alcoholStage.value = 'warming_up'
      const wrapper = await mountAlc()
      expect(wrapper.text()).toContain('ウォームアップ中')
      wrapper.unmount()
    })

    it('alcoholStage が null → 案内文のみ (進み具合の表示は出ない)', async () => {
      coreS3Connected.value = true
      const wrapper = await mountAlc()
      expect(wrapper.text()).toContain('CoreS3 につないだアルコールチェッカーで測定してください')
      expect(wrapper.text()).not.toContain('進み具合')
      expect(wrapper.text()).not.toContain('息を吹きかけてください')
      wrapper.unmount()
    })

    it('alcoholStage が blow_waiting になると stateChange を emit する', async () => {
      coreS3Connected.value = true
      const wrapper = await mountAlc()

      alcoholStage.value = 'blow_waiting'
      await wrapper.vm.$nextTick()

      const emitted = wrapper.emitted('stateChange')
      expect(emitted).toContainEqual(['blow_waiting'])
      wrapper.unmount()
    })
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

  // =============================================
  // 先着 1 回だけ emit する (#238 — PC 直結 / CoreS3 のどちらが先でも同じ規則)
  // =============================================

  describe('PC 直結 / CoreS3 の先着レース', () => {
    it('CoreS3 の値が先なら emit し、後から届いた PC 直結の結果は捨てる', async () => {
      const wrapper = await mountAlc()

      latestAlcohol.value = {
        value: 0.1,
        unit: 'mg/L',
        result: 'normal',
        useCount: 1,
        measuredAt: new Date('2026-01-03T00:00:00Z'),
      }
      await wrapper.vm.$nextTick()

      fc1200Result.value = {
        alcoholValue: 0.9,
        resultType: 'over',
        deviceUseCount: 99,
        measuredAt: new Date('2026-01-03T00:00:01Z'),
      }
      await wrapper.vm.$nextTick()

      const emitted = wrapper.emitted('result')
      expect(emitted).toHaveLength(1)
      expect(emitted![0]![0]).toMatchObject({ alcoholValue: 0.1, resultType: 'normal' })
      wrapper.unmount()
    })

    it('PC 直結の値が先なら emit し、後から届いた CoreS3 の結果は捨てる', async () => {
      const wrapper = await mountAlc()

      fc1200Result.value = {
        alcoholValue: 0.05,
        resultType: 'normal',
        deviceUseCount: 7,
        measuredAt: new Date('2026-01-03T00:00:00Z'),
      }
      await wrapper.vm.$nextTick()

      latestAlcohol.value = {
        value: 0.9,
        unit: 'mg/L',
        result: 'over',
        useCount: 1,
        measuredAt: new Date('2026-01-03T00:00:01Z'),
      }
      await wrapper.vm.$nextTick()

      const emitted = wrapper.emitted('result')
      expect(emitted).toHaveLength(1)
      expect(emitted![0]![0]).toMatchObject({ alcoholValue: 0.05, resultType: 'normal' })
      wrapper.unmount()
    })

    it('mount 後に CoreS3 が繋がっても同じ規則で動く (後着は捨てる)', async () => {
      // mount 時点では CoreS3 未接続。PC 直結の autoConnect だけが走る
      const wrapper = await mountAlc()

      // 測定中に CoreS3 が挿された想定 (接続状態だけが変わっても emit 判定には影響しない)
      coreS3Connected.value = true
      await wrapper.vm.$nextTick()

      fc1200Result.value = {
        alcoholValue: 0.12,
        resultType: 'normal',
        deviceUseCount: 2,
        measuredAt: new Date('2026-01-04T00:00:00Z'),
      }
      await wrapper.vm.$nextTick()

      latestAlcohol.value = {
        value: 0.5,
        unit: 'mg/L',
        result: 'over',
        useCount: 3,
        measuredAt: new Date('2026-01-04T00:00:01Z'),
      }
      await wrapper.vm.$nextTick()

      const emitted = wrapper.emitted('result')
      expect(emitted).toHaveLength(1)
      expect(emitted![0]![0]).toMatchObject({ alcoholValue: 0.12, resultType: 'normal' })
      wrapper.unmount()
    })
  })

  // =============================================
  // 状態インジケーターの見た目 (Refs ippoan/rust-alc-api#644)
  //
  // **CoreS3 経由と PC 直結で同じ markup が 2 回複製されている。**
  // 部品へ切り出す前に「文言・色・ドットが 1 つも変わらない」ことを固定する。
  // ここが崩れたら切り出しが失敗しているということ。
  // =============================================

  describe('状態インジケーターの見た目 (切り出しの回帰固定)', () => {
    /** インジケーターの文言 span (v-else-if の連鎖なので同時に 1 つしか出ない) */
    function indicator(wrapper: { find: (s: string) => { exists: () => boolean, text: () => string, classes: () => string[] } }) {
      return wrapper.find('.text-lg.font-medium')
    }
    /** インジケーターのドット */
    function dot(wrapper: { find: (s: string) => { exists: () => boolean, classes: () => string[] } }) {
      return wrapper.find('.w-3.h-3.rounded-full')
    }

    const CASES: Array<[Fc1200State, string, string, boolean, string | null]> = [
      // 状態, 文言, 文字色, animate するか, animate しないときのドットの色
      ['idle', 'FC-1200 未接続', 'text-gray-500', false, 'bg-gray-400'],
      ['waiting_connection', '接続待機中...', 'text-yellow-600', true, null],
      ['connected', 'デバイス接続済み', 'text-blue-600', false, 'bg-gray-400'],
      ['warming_up', 'ウォームアップ中...', 'text-yellow-600', true, null],
      ['blow_waiting', '息を吹きかけてください', 'text-blue-700', true, null],
      ['measuring', '測定中...', 'text-blue-600', true, null],
      ['result_received', '測定完了', 'text-green-600', false, 'bg-green-500'],
    ]

    it.each(CASES)('CoreS3 経由: %s → 文言・色・ドットが変わらない', async (state, text, color, animate, dotColor) => {
      coreS3Connected.value = true
      alcoholStage.value = state
      const wrapper = await mountAlc()

      expect(indicator(wrapper).text()).toBe(text)
      expect(indicator(wrapper).classes()).toContain(color)
      expect(dot(wrapper).classes().includes('animate-pulse')).toBe(animate)
      if (dotColor) expect(dot(wrapper).classes()).toContain(dotColor)
      wrapper.unmount()
    })

    it.each(CASES)('PC 直結: %s → 文言・色・ドットが変わらない', async (state, text, color, animate, dotColor) => {
      coreS3Connected.value = false
      fc1200IsConnected.value = true
      fc1200State.value = state
      const wrapper = await mountAlc()

      expect(indicator(wrapper).text()).toBe(text)
      expect(indicator(wrapper).classes()).toContain(color)
      expect(dot(wrapper).classes().includes('animate-pulse')).toBe(animate)
      if (dotColor) expect(dot(wrapper).classes()).toContain(dotColor)
      wrapper.unmount()
    })

    it('CoreS3 経由: blow_waiting のときだけ吹きかけプロンプトを出す', async () => {
      coreS3Connected.value = true
      alcoholStage.value = 'blow_waiting'
      const wrapper = await mountAlc()
      expect(wrapper.text()).toContain('FC-1200 のセンサー部に向かって約5秒間')
      wrapper.unmount()

      alcoholStage.value = 'measuring'
      const other = await mountAlc()
      expect(other.text()).not.toContain('FC-1200 のセンサー部に向かって約5秒間')
      other.unmount()
    })

    it('PC 直結: blow_waiting のときだけ吹きかけプロンプトを出す', async () => {
      coreS3Connected.value = false
      fc1200IsConnected.value = true
      fc1200State.value = 'blow_waiting'
      const wrapper = await mountAlc()
      expect(wrapper.text()).toContain('FC-1200 のセンサー部に向かって約5秒間')
      wrapper.unmount()

      fc1200State.value = 'measuring'
      const other = await mountAlc()
      expect(other.text()).not.toContain('FC-1200 のセンサー部に向かって約5秒間')
      other.unmount()
    })
  })
})
