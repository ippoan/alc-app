// Vein Station の版の帯 (Refs ippoan/alc-app#436)。共通の帯 (DeviceFirmwareNotice) に、Vein Station の
// 接続・名乗り・始め方を渡すだけの部品。帯そのものの出し分けは DeviceFirmwareNotice.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import VeinStationFirmwareNotice from '~/components/VeinStationFirmwareNotice.vue'
import DeviceFirmwareNotice from '~/components/DeviceFirmwareNotice.vue'

interface DeviceInfo { ver: string | null, board: string | null, flavor: string | null }
const vein = vi.hoisted(() => ({
  isConnected: null as unknown as { value: boolean },
  deviceInfo: null as unknown as { value: DeviceInfo | null },
}))
mockNuxtImport('useVeinSerial', () => () => vein)

const ota = vi.hoisted(() => ({ run: vi.fn() }))
mockNuxtImport('useSerialOta', () => () => ota)

const kioskScreen = vi.hoisted(() => ({ isDeviceBusy: null as unknown as { value: boolean } }))
mockNuxtImport('useKioskScreen', () => () => kioskScreen)

const demoMode = vi.hoisted(() => ({ isDemoMode: null as unknown as { value: boolean } }))
mockNuxtImport('useDemoMode', () => () => demoMode)

// 帯は stub (中身は別のテスト)。渡された props だけを見る
const mount = () => mountSuspended(VeinStationFirmwareNotice, { shallow: true })
type Wrapper = Awaited<ReturnType<typeof mount>>
const band = (w: Wrapper) => w.findComponent(DeviceFirmwareNotice)

describe('VeinStationFirmwareNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vein.isConnected = ref(true)
    vein.deviceInfo = ref<DeviceInfo | null>({ ver: '0.3.1+abc1234', board: null, flavor: 'timecard-vein' })
    kioskScreen.isDeviceBusy = ref(false)
    demoMode.isDemoMode = ref(false)
    ota.run.mockResolvedValue('updated')
  })

  it('★ 対象は timecard-station で、Vein Station が名乗った版・flavor と接続を渡す', async () => {
    const w = await mount()
    expect(band(w).props()).toMatchObject({ target: 'timecard-station', version: '0.3.1+abc1234', flavor: 'timecard-vein', connected: true })
    w.unmount()
  })

  it('名乗らない機体 (旧い版) では版と flavor は null、未接続なら connected を立てない', async () => {
    vein.deviceInfo.value = null
    vein.isConnected.value = false
    const w = await mount()
    expect(band(w).props()).toMatchObject({ version: null, flavor: null, connected: false })
    w.unmount()
  })

  it('★ start は「機体を使用中か」を付けて timecard-station の更新を 1 回走らせ、結果を返す', async () => {
    const w = await mount()
    expect(ota.run).not.toHaveBeenCalled()
    expect(await (band(w).props('start') as () => Promise<string>)()).toBe('updated')
    expect(ota.run).toHaveBeenCalledTimes(1)
    const [target, opts] = ota.run.mock.calls[0] as [string, { deviceId?: string, isBusy: () => boolean }]
    expect(target).toBe('timecard-station')
    expect(opts.deviceId).toBeUndefined()
    expect(opts.isBusy()).toBe(false)
    kioskScreen.isDeviceBusy.value = true
    expect(opts.isBusy()).toBe(true)
    w.unmount()
  })

  it('URL のデモ (?demo=1) では帯を置かない', async () => {
    demoMode.isDemoMode.value = true
    const w = await mount()
    expect(band(w).exists()).toBe(false)
    w.unmount()
  })
})
