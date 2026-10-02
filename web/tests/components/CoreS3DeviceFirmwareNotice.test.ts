// CoreS3 の版の帯 (Refs ippoan/alc-app#425)。共通の帯 (DeviceFirmwareNotice) に、CoreS3 の接続・
// 名乗り・始め方を渡すだけの部品。帯そのものの出し分けは DeviceFirmwareNotice.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import CoreS3DeviceFirmwareNotice from '~/components/CoreS3DeviceFirmwareNotice.vue'
import DeviceFirmwareNotice from '~/components/DeviceFirmwareNotice.vue'

interface DeviceInfo { ver: string | null, board: string | null, flavor: string | null }
const coreS3 = vi.hoisted(() => ({
  isConnected: null as unknown as { value: boolean },
  deviceInfo: null as unknown as { value: DeviceInfo | null },
}))
mockNuxtImport('useCoreS3Serial', () => () => coreS3)

const report = vi.hoisted(() => ({ deviceId: null as unknown as { value: string | null } }))
mockNuxtImport('useFirmwareReport', () => () => report)

const ota = vi.hoisted(() => ({ run: vi.fn() }))
mockNuxtImport('useSerialOta', () => () => ota)

const kioskScreen = vi.hoisted(() => ({ isDeviceBusy: null as unknown as { value: boolean } }))
mockNuxtImport('useKioskScreen', () => () => kioskScreen)

const demoMode = vi.hoisted(() => ({ isDemoMode: null as unknown as { value: boolean } }))
mockNuxtImport('useDemoMode', () => () => demoMode)

// 帯は stub (中身は別のテスト)。渡された props だけを見る
const mount = () => mountSuspended(CoreS3DeviceFirmwareNotice, { shallow: true })
type Wrapper = Awaited<ReturnType<typeof mount>>
const band = (w: Wrapper) => w.findComponent(DeviceFirmwareNotice)

describe('CoreS3DeviceFirmwareNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    coreS3.isConnected = ref(true)
    coreS3.deviceInfo = ref<DeviceInfo | null>({ ver: '0.9.3', board: 'cores3', flavor: 'cores3-wifi' })
    report.deviceId = ref<string | null>('hub-test-id')
    kioskScreen.isDeviceBusy = ref(false)
    demoMode.isDemoMode = ref(false)
    ota.run.mockResolvedValue('updated')
  })

  it('★ 対象は cores3 で、CoreS3 が名乗った版・flavor と接続を渡す', async () => {
    const w = await mount()
    expect(band(w).props()).toMatchObject({ target: 'cores3', version: '0.9.3', flavor: 'cores3-wifi', connected: true })
    w.unmount()
  })

  it('名乗らない機体 (旧い版)・未接続では、版と flavor は null', async () => {
    coreS3.deviceInfo.value = null
    const w = await mount()
    expect(band(w).props()).toMatchObject({ version: null, flavor: null })
    w.unmount()
  })

  it('★ 機体の id が取れていない端末では connected を立てない (帯が出ない)。取れたら立つ', async () => {
    report.deviceId.value = null
    const w = await mount()
    expect(band(w).props('connected')).toBe(false)
    report.deviceId.value = 'hub-test-id'
    await w.vm.$nextTick()
    expect(band(w).props('connected')).toBe(true)
    w.unmount()
  })

  it('CoreS3 が繋がっていなければ、id を持っていても connected を立てない', async () => {
    coreS3.isConnected.value = false
    const w = await mount()
    expect(band(w).props('connected')).toBe(false)
    w.unmount()
  })

  it('★ start は、押した時点の自分の機体の id と「機体を使用中か」を付けて cores3 の更新を 1 回走らせ、結果を返す', async () => {
    const w = await mount()
    expect(ota.run).not.toHaveBeenCalled()
    const start = band(w).props('start') as () => Promise<string>

    // mount の後に id が変わっても、押した時点の値を読む
    report.deviceId.value = 'hub-test-id-2'
    expect(await start()).toBe('updated')
    expect(ota.run).toHaveBeenCalledTimes(1)
    const [target, opts] = ota.run.mock.calls[0] as [string, { deviceId?: string, isBusy: () => boolean }]
    expect(target).toBe('cores3')
    expect(opts.deviceId).toBe('hub-test-id-2')
    expect(opts.isBusy()).toBe(false)
    kioskScreen.isDeviceBusy.value = true
    expect(opts.isBusy()).toBe(true)
    w.unmount()
  })

  it('押した時点で id を失っていたら deviceId を付けない (宛先の照合で弾かれる)', async () => {
    const w = await mount()
    report.deviceId.value = null
    await (band(w).props('start') as () => Promise<string>)()
    expect((ota.run.mock.calls[0] as [string, { deviceId?: string }])[1].deviceId).toBeUndefined()
    w.unmount()
  })

  it('URL のデモ (?demo=1) では帯を置かない', async () => {
    demoMode.isDemoMode.value = true
    const w = await mount()
    expect(band(w).exists()).toBe(false)
    w.unmount()
  })
})
