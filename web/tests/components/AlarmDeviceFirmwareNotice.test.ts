// 警告デバイスの版の帯 (Refs ippoan/alc-app#425)。共通の帯 (DeviceFirmwareNotice) に、警告デバイスの
// 接続・名乗り・始め方を渡すだけの部品。帯そのものの出し分けは DeviceFirmwareNotice.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import AlarmDeviceFirmwareNotice from '~/components/AlarmDeviceFirmwareNotice.vue'
import DeviceFirmwareNotice from '~/components/DeviceFirmwareNotice.vue'

interface DeviceInfo { ver: string | null, board: string | null, flavor: string | null }
interface DeviceState { state: 'idle' | 'alarming' | 'muted', cause: string }
const alarm = vi.hoisted(() => ({
  isConnected: null as unknown as { value: boolean },
  deviceInfo: null as unknown as { value: DeviceInfo | null },
  deviceState: null as unknown as { value: DeviceState | null },
}))
mockNuxtImport('useAlarmDevice', () => () => alarm)

const ota = vi.hoisted(() => ({ run: vi.fn() }))
mockNuxtImport('useSerialOta', () => () => ota)

const kioskScreen = vi.hoisted(() => ({ isDeviceBusy: null as unknown as { value: boolean } }))
mockNuxtImport('useKioskScreen', () => () => kioskScreen)

const rooms = vi.hoisted(() => ({ callingRooms: null as unknown as { value: string[] } }))
mockNuxtImport('useActiveRooms', () => () => rooms)

// 帯は stub (中身は別のテスト)。渡された props だけを見る
const mount = () => mountSuspended(AlarmDeviceFirmwareNotice, { shallow: true })
type Wrapper = Awaited<ReturnType<typeof mount>>
const band = (w: Wrapper) => w.findComponent(DeviceFirmwareNotice)

describe('AlarmDeviceFirmwareNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    alarm.isConnected = ref(true)
    alarm.deviceInfo = ref<DeviceInfo | null>({ ver: '0.1.0+abc', board: null, flavor: 'alarm' })
    alarm.deviceState = ref<DeviceState | null>({ state: 'idle', cause: 'none' })
    kioskScreen.isDeviceBusy = ref(false)
    rooms.callingRooms = ref<string[]>([])
    ota.run.mockResolvedValue('updated')
  })

  it('★ 対象は alarm で、警告デバイスが名乗った版・flavor と接続を渡す', async () => {
    const w = await mount()
    expect(band(w).props()).toMatchObject({ target: 'alarm', version: '0.1.0+abc', flavor: 'alarm', connected: true })
    w.unmount()
  })

  it('名乗りが取れていなければ、版と flavor は null で connected も立てない', async () => {
    alarm.deviceInfo.value = null
    const w = await mount()
    expect(band(w).props()).toMatchObject({ version: null, flavor: null, connected: false })
    w.unmount()
  })

  it('警告デバイスが繋がっていなければ connected を立てない', async () => {
    alarm.isConnected.value = false
    const w = await mount()
    expect(band(w).props('connected')).toBe(false)
    w.unmount()
  })

  it.each([
    ['鳴っている', { state: 'alarming', cause: 'silence' }],
    ['着信を知らせている', { state: 'alarming', cause: 'call' }],
    ['黙らせた後', { state: 'muted', cause: 'call' }],
    ['状態がまだ分からない', null],
  ] as Array<[string, DeviceState | null]>)('★ %s間は connected を立てない (帯を出さない)。待機に戻れば立つ', async (_name, state) => {
    alarm.deviceState.value = state
    const w = await mount()
    expect(band(w).props('connected')).toBe(false)
    alarm.deviceState.value = { state: 'idle', cause: 'none' }
    await w.vm.$nextTick()
    expect(band(w).props('connected')).toBe(true)
    w.unmount()
  })

  it('★ 状態が分からなくなっても (更新後の再起動)、帯の部品は外さない (結果の行を消さない)', async () => {
    const w = await mount()
    alarm.isConnected.value = false
    alarm.deviceInfo.value = null
    alarm.deviceState.value = null
    await w.vm.$nextTick()
    expect(band(w).exists()).toBe(true)
    expect(band(w).props('connected')).toBe(false)
    w.unmount()
  })

  it('★ start は、宛先を付けずに alarm の更新を 1 回走らせ、結果を返す', async () => {
    ota.run.mockResolvedValue('unsupported')
    const w = await mount()
    expect(ota.run).not.toHaveBeenCalled()
    const start = band(w).props('start') as () => Promise<string>

    expect(await start()).toBe('unsupported')
    expect(ota.run).toHaveBeenCalledTimes(1)
    const [target, opts] = ota.run.mock.calls[0] as [string, { deviceId?: string, isBusy: () => boolean }]
    expect(target).toBe('alarm')
    expect(opts.deviceId).toBeUndefined()
    expect(Object.keys(opts)).toEqual(['isBusy'])
    w.unmount()
  })

  it('★ 書き込みの直前の聞き直しは、通話などの申告・機体の鳴動・着信のどれか 1 つで「使用中」', async () => {
    const w = await mount()
    await (band(w).props('start') as () => Promise<string>)()
    const { isBusy } = (ota.run.mock.calls[0] as [string, { isBusy: () => boolean }])[1]
    expect(isBusy()).toBe(false)

    // 通話・判定の入力・画面共有 (各画面の申告)
    kioskScreen.isDeviceBusy.value = true
    expect(isBusy()).toBe(true)
    kioskScreen.isDeviceBusy.value = false

    // 機体が鳴っている / 状態が分からない
    alarm.deviceState.value = { state: 'alarming', cause: 'silence' }
    expect(isBusy()).toBe(true)
    alarm.deviceState.value = null
    expect(isBusy()).toBe(true)
    alarm.deviceState.value = { state: 'idle', cause: 'none' }

    // 着信 (機体が鳴り出す前でも)
    rooms.callingRooms.value = ['room-a']
    expect(isBusy()).toBe(true)
    rooms.callingRooms.value = []
    expect(isBusy()).toBe(false)
    w.unmount()
  })
})
