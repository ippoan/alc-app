// 開発端末の指静脈の端末を配布中のファームへ自動で更新する (Refs ippoan/alc-app-s3#352)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import DevFirmwareAutoUpdate from '~/components/DevFirmwareAutoUpdate.vue'

const updates = vi.hoisted(() => ({ fetchLatest: vi.fn() }))
vi.mock('~/utils/firmware-updates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/firmware-updates')>()),
  fetchLatestFirmwareVersions: updates.fetchLatest,
}))
const marks = vi.hoisted(() => ({ dev: { kiosk: false, 'manager-device': false } as Record<string, boolean> }))
vi.mock('~/utils/token-selection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/token-selection')>()),
  isDevDevice: (kind: string) => marks.dev[kind] ?? false,
}))
const { appendDiag } = vi.hoisted(() => ({ appendDiag: vi.fn() }))
vi.mock('~/utils/serialDiagLog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/serialDiagLog')>()),
  appendDiag,
}))

const vein = vi.hoisted(() => ({
  isConnected: null as unknown as { value: boolean },
  deviceInfo: null as unknown as { value: { ver: string | null, flavor: string | null } | null },
}))
mockNuxtImport('useVeinSerial', () => () => vein)
const serialOta = vi.hoisted(() => ({ run: vi.fn(), state: null as unknown as { value: { kind: string } } }))
mockNuxtImport('useSerialOta', () => () => serialOta)
const screen = vi.hoisted(() => ({ isDeviceBusy: null as unknown as { value: boolean } }))
mockNuxtImport('useKioskScreen', () => () => screen)
const demo = vi.hoisted(() => ({ isDemoMode: null as unknown as { value: boolean } }))
mockNuxtImport('useDemoMode', () => () => demo)
const timecardWatch = vi.hoisted(() => vi.fn())
mockNuxtImport('useTimecardWatch', () => timecardWatch)
const watchHandle = vi.hoisted(() => ({ connect: vi.fn(async () => {}), stop: vi.fn() }))
interface FwWatchOptions { path: string, getToken: () => Promise<string | null>, onFirmwarePublished: (target: string) => void }
const fwWatch = (): FwWatchOptions => timecardWatch.mock.calls.at(-1)![0] as FwWatchOptions
const deviceToken = vi.hoisted(() => ({ getDeviceJwt: vi.fn(async () => 'kiosk-jwt') }))
mockNuxtImport('useDeviceToken', () => () => deviceToken)
const managerToken = vi.hoisted(() => ({ getManagerJwt: vi.fn(async () => 'seat-jwt') }))
mockNuxtImport('useManagerDeviceToken', () => () => managerToken)

const mounted: { unmount: () => void }[] = []
async function mount() {
  const w = await mountSuspended(DevFirmwareAutoUpdate)
  mounted.push(w)
  await flushPromises()
  return w
}

describe('DevFirmwareAutoUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    marks.dev = { 'kiosk': true, 'manager-device': false }
    vein.isConnected = ref(true)
    vein.deviceInfo = ref({ ver: '0.1.8+old', flavor: 'vein' })
    serialOta.state = ref({ kind: 'idle' })
    serialOta.run.mockResolvedValue('updated')
    screen.isDeviceBusy = ref(false)
    demo.isDemoMode = ref(false)
    updates.fetchLatest.mockResolvedValue({ vein: '0.1.8+new' })
    timecardWatch.mockReturnValue(watchHandle)
  })

  afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    vi.useRealTimers()
  })

  it('★ 開発端末で版が違えば、押さずに 1 回だけ更新する (描くものは無い)', async () => {
    const w = await mount()
    expect(w.text()).toBe('')
    expect(updates.fetchLatest).toHaveBeenCalledWith('timecard-station')
    expect(serialOta.run).toHaveBeenCalledTimes(1)
    expect(serialOta.run.mock.calls[0]![0]).toBe('timecard-station')
    expect((serialOta.run.mock.calls[0]![1] as { isBusy: () => boolean }).isBusy()).toBe(false)
    expect(appendDiag).toHaveBeenCalledWith('[ota] 開発端末の自動更新 vein:0.1.8+old->0.1.8+new → updated')
    // 同じ版の組は繰り返さない (失敗・別の更新の後でも)
    serialOta.state.value = { kind: 'writing' }
    await flushPromises()
    serialOta.state.value = { kind: 'idle' }
    await flushPromises()
    expect(serialOta.run).toHaveBeenCalledTimes(1)
  })

  it('運行管理者席の開発用の鍵でも更新する', async () => {
    marks.dev = { 'kiosk': false, 'manager-device': true }
    await mount()
    expect(serialOta.run).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['本番の端末', () => { marks.dev = { 'kiosk': false, 'manager-device': false } }],
    ['デモ', () => { demo.isDemoMode.value = true }],
    ['使用中', () => { screen.isDeviceBusy.value = true }],
    ['別の更新中', () => { serialOta.state.value = { kind: 'writing' } }],
    ['同じ版', () => { updates.fetchLatest.mockResolvedValue({ vein: '0.1.8+old' }) }],
    ['機体の版が取れない', () => { vein.deviceInfo.value = null }],
    ['つながっていない', () => { vein.isConnected.value = false }],
  ])('%s なら始めない', async (_name, arrange) => {
    arrange()
    await mount()
    expect(serialOta.run).not.toHaveBeenCalled()
  })

  it('使用中が終わったら始める。開発用の印が後から立っても始める', async () => {
    screen.isDeviceBusy.value = true
    marks.dev = { 'kiosk': false, 'manager-device': false }
    await mount()
    marks.dev = { 'kiosk': true, 'manager-device': false }
    window.dispatchEvent(new Event('alc-dev-device-mark'))
    await flushPromises()
    expect(serialOta.run).not.toHaveBeenCalled()
    screen.isDeviceBusy.value = false
    await flushPromises()
    expect(serialOta.run).toHaveBeenCalledTimes(1)
  })

  it('つながっていなければ取りに行かない。つながったら取り、10 分おきに取り直し、切れたら止める', async () => {
    vi.useFakeTimers()
    vein.isConnected.value = false
    updates.fetchLatest.mockResolvedValue({})
    await mount()
    expect(updates.fetchLatest).not.toHaveBeenCalled()
    vein.isConnected.value = true
    await flushPromises()
    expect(updates.fetchLatest).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(updates.fetchLatest).toHaveBeenCalledTimes(2)
    vein.isConnected.value = false
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(updates.fetchLatest).toHaveBeenCalledTimes(2)
  })

  it('★ 開発端末は配信の合図を購読し、合図を受けたらすぐと CDN の古さを越えるまで取り直す', async () => {
    vi.useFakeTimers()
    updates.fetchLatest.mockResolvedValue({ vein: '0.1.8+old' })
    const w = await mount()
    expect(fwWatch().path).toBe('/watch-firmware')
    expect(watchHandle.connect).toHaveBeenCalledTimes(1)
    expect(await fwWatch().getToken()).toBe('kiosk-jwt')
    updates.fetchLatest.mockClear()
    fwWatch().onFirmwarePublished('cores3')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(updates.fetchLatest).not.toHaveBeenCalled()
    fwWatch().onFirmwarePublished('timecard-station')
    await vi.advanceTimersByTimeAsync(0)
    expect(updates.fetchLatest).toHaveBeenCalledTimes(1)
    expect(appendDiag).toHaveBeenCalledWith('[ota] 配信の合図を受けました timecard-station')
    await vi.advanceTimersByTimeAsync(660_000)
    expect(updates.fetchLatest).toHaveBeenCalledTimes(5 + 1)
    w.unmount()
    expect(watchHandle.stop).toHaveBeenCalled()
  })

  it('運行管理者席の開発用の鍵なら席の鍵で購読する。本番の端末は購読しない', async () => {
    marks.dev = { 'kiosk': false, 'manager-device': true }
    await mount()
    expect(await fwWatch().getToken()).toBe('seat-jwt')
    expect(watchHandle.connect).toHaveBeenCalledTimes(1)
    mounted.splice(0).forEach(w => w.unmount())
    watchHandle.connect.mockClear()
    marks.dev = { 'kiosk': false, 'manager-device': false }
    await mount()
    expect(watchHandle.connect).not.toHaveBeenCalled()
  })
})
