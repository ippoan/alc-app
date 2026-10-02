// CoreS3 のファームの更新の置き場 (Refs ippoan/alc-app#403)。
// 報告 (useFirmwareReport) を mount で始め、unmount で止める。CoreS3 の更新の合図 (target `cores3`) を受ける。
// 「更新中」の幕は描かない (役割に依らない位置の FirmwareOtaOverlay.vue が出す。Refs ippoan/alc-app#425)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import FirmwareOtaHost from '~/components/FirmwareOtaHost.vue'
import type { SerialOtaState } from '~/composables/useSerialOta'

const reportMock = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
mockNuxtImport('useFirmwareReport', () => () => reportMock)

const ota = vi.hoisted(() => ({
  state: null as unknown as { value: SerialOtaState },
  run: vi.fn(),
  enqueue: vi.fn(),
  runQueued: vi.fn(async () => {}),
}))
mockNuxtImport('useSerialOta', () => () => ota)

const timecardWatch = vi.hoisted(() => vi.fn())
mockNuxtImport('useTimecardWatch', () => timecardWatch)

const coreS3 = vi.hoisted(() => ({ isConnected: null as unknown as { value: boolean } }))
mockNuxtImport('useCoreS3Serial', () => () => coreS3)

const kioskScreen = vi.hoisted(() => ({ isDeviceBusy: null as unknown as { value: boolean } }))
mockNuxtImport('useKioskScreen', () => () => kioskScreen)

const deviceToken = vi.hoisted(() => ({ getDeviceJwt: vi.fn(async () => 'kiosk-jwt') }))
mockNuxtImport('useDeviceToken', () => () => deviceToken)

const demoMode = vi.hoisted(() => ({ isDemoMode: null as unknown as { value: boolean } }))
mockNuxtImport('useDemoMode', () => () => demoMode)

/** 購読の偽物。`useTimecardWatch` に渡された options を取っておく */
const watchHandle = vi.hoisted(() => ({ connect: vi.fn(async () => {}), stop: vi.fn() }))
interface WatchOptions {
  getToken: () => unknown
  onChange?: unknown
  onSerialOta: (target: string, deviceId?: string) => void
}
const watchOptions = (): WatchOptions => timecardWatch.mock.calls[0]![0] as WatchOptions

const overlay = (wrapper: { find: (selector: string) => { exists: () => boolean } }) =>
  wrapper.find('[data-testid="serial-ota-overlay"]')

describe('FirmwareOtaHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ota.state = ref<SerialOtaState>({ kind: 'idle' })
    coreS3.isConnected = ref(false)
    kioskScreen.isDeviceBusy = ref(false)
    demoMode.isDemoMode = ref(false)
    timecardWatch.mockReturnValue(watchHandle)
  })

  it('mount で報告を始め、unmount で止める', async () => {
    const wrapper = await mountSuspended(FirmwareOtaHost)
    expect(reportMock.start).toHaveBeenCalledTimes(1)
    expect(reportMock.stop).not.toHaveBeenCalled()

    wrapper.unmount()

    expect(reportMock.stop).toHaveBeenCalledTimes(1)
    expect(reportMock.start).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ kind: 'idle' }],
    [{ kind: 'downloading' }],
    [{ kind: 'writing', pct: 42 }],
    [{ kind: 'failed', reason: 'OTA ERR write' }],
  ] as Array<[SerialOtaState]>)('★ 状態 %o でも描画するものは無い (幕は FirmwareOtaOverlay が出す)', async (state) => {
    ota.state.value = state
    const wrapper = await mountSuspended(FirmwareOtaHost)
    expect(wrapper.element.nodeType).not.toBe(Node.ELEMENT_NODE)
    expect(wrapper.text()).toBe('')
    expect(overlay(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })

  it('状態が変わっても、更新を始めない', async () => {
    const wrapper = await mountSuspended(FirmwareOtaHost)
    ota.state.value = { kind: 'downloading' }
    await flushPromises()
    expect(ota.enqueue).not.toHaveBeenCalled()
    expect(ota.runQueued).not.toHaveBeenCalled()
    expect(ota.run).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  // ---------- CoreS3 の更新の合図の受け ----------

  describe('合図の購読', () => {
    it('端末の token で購読を用意する (打刻一覧は持たないので onChange は渡さない)', async () => {
      const wrapper = await mountSuspended(FirmwareOtaHost)
      expect(timecardWatch).toHaveBeenCalledTimes(1)
      expect(watchOptions().onChange).toBeUndefined()
      expect(await watchOptions().getToken()).toBe('kiosk-jwt')
      wrapper.unmount()
    })

    it('CoreS3 が繋がるまで張らず、最初に繋がったときに 1 回だけ張る', async () => {
      const wrapper = await mountSuspended(FirmwareOtaHost)
      await flushPromises()
      expect(watchHandle.connect).not.toHaveBeenCalled()

      coreS3.isConnected.value = true
      await flushPromises()
      expect(watchHandle.connect).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })

    it('mount の時点で繋がっていれば、その場で張る', async () => {
      coreS3.isConnected.value = true
      const wrapper = await mountSuspended(FirmwareOtaHost)
      expect(watchHandle.connect).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })

    it('★ 切れても止めず、繋がり直しても張り直さない (更新は再起動で接続を一度失う)', async () => {
      coreS3.isConnected.value = true
      const wrapper = await mountSuspended(FirmwareOtaHost)

      coreS3.isConnected.value = false
      await flushPromises()
      coreS3.isConnected.value = true
      await flushPromises()

      expect(watchHandle.stop).not.toHaveBeenCalled()
      expect(watchHandle.connect).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })
  })

  describe('合図の受け', () => {
    it('cores3 の合図を、device_id と「機体を使用中」の読み口を付けて預け、使用中でなければその場で走らせる', async () => {
      const wrapper = await mountSuspended(FirmwareOtaHost)
      watchOptions().onSerialOta('cores3', 'kiosk-a')

      expect(ota.enqueue).toHaveBeenCalledTimes(1)
      const [target, opts] = ota.enqueue.mock.calls[0] as unknown as [string, { deviceId?: string, isBusy: () => boolean }]
      expect(target).toBe('cores3')
      expect(opts.deviceId).toBe('kiosk-a')
      expect(ota.runQueued).toHaveBeenCalledTimes(1)

      // 預けた読み口は、その時々の「機体を使用中」を返す
      expect(opts.isBusy()).toBe(false)
      kioskScreen.isDeviceBusy.value = true
      expect(opts.isBusy()).toBe(true)
      wrapper.unmount()
    })

    it('device_id の無い合図もそのまま預ける (照合は useSerialOta が持つ)', async () => {
      const wrapper = await mountSuspended(FirmwareOtaHost)
      watchOptions().onSerialOta('cores3')
      expect(ota.enqueue).toHaveBeenCalledWith('cores3', { deviceId: undefined, isBusy: expect.any(Function) })
      wrapper.unmount()
    })

    it('★ 機体を使用中なら預けるだけ。解けたときに走らせる', async () => {
      kioskScreen.isDeviceBusy.value = true
      const wrapper = await mountSuspended(FirmwareOtaHost)
      watchOptions().onSerialOta('cores3', 'kiosk-a')
      expect(ota.enqueue).toHaveBeenCalledTimes(1)
      expect(ota.runQueued).not.toHaveBeenCalled()

      kioskScreen.isDeviceBusy.value = false
      await flushPromises()
      expect(ota.runQueued).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })

    it('使用中になったときは走らせない', async () => {
      const wrapper = await mountSuspended(FirmwareOtaHost)
      kioskScreen.isDeviceBusy.value = true
      await flushPromises()
      expect(ota.runQueued).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it.each(['timecard-station', 'timecard', 'https://evil.example/x.bin'])('target %s の合図では何もしない (Vein Station は TenkoKiosk が受ける)', async (target) => {
      const wrapper = await mountSuspended(FirmwareOtaHost)
      watchOptions().onSerialOta(target, 'kiosk-a')
      expect(ota.enqueue).not.toHaveBeenCalled()
      expect(ota.runQueued).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('デモのタブ (prop) では合図を受けても何もしない', async () => {
      const wrapper = await mountSuspended(FirmwareOtaHost, { props: { demo: true } })
      watchOptions().onSerialOta('cores3', 'kiosk-a')
      expect(ota.enqueue).not.toHaveBeenCalled()
      expect(ota.runQueued).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('URL のデモ (?demo=1) でも何もしない', async () => {
      demoMode.isDemoMode.value = true
      const wrapper = await mountSuspended(FirmwareOtaHost)
      watchOptions().onSerialOta('cores3', 'kiosk-a')
      expect(ota.enqueue).not.toHaveBeenCalled()
      expect(ota.runQueued).not.toHaveBeenCalled()
      wrapper.unmount()
    })
  })
})
