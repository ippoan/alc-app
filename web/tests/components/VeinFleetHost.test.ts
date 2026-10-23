// 全端末の指静脈の一覧の、キオスク側の受け答え (Refs ippoan/alc-app#436)。
// Vein Station が最初に繋がったときに購読を張り、`vein_list_request` を受けたら対応表を報告する。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import VeinFleetHost from '~/components/VeinFleetHost.vue'

const { reportVeinFleet, loadVeinModuleEntries } = vi.hoisted(() => ({
  reportVeinFleet: vi.fn(),
  loadVeinModuleEntries: vi.fn(),
}))
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  reportVeinFleet,
}))
vi.mock('~/utils/vein-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/vein-db')>()),
  loadVeinModuleEntries,
}))

const timecardWatch = vi.hoisted(() => vi.fn())
mockNuxtImport('useTimecardWatch', () => timecardWatch)

const vein = vi.hoisted(() => ({
  isConnected: null as unknown as { value: boolean },
  syncInfo: vi.fn(),
  connect: vi.fn(async () => true),
}))
mockNuxtImport('useVeinSerial', () => () => vein)

const deviceToken = vi.hoisted(() => ({ getDeviceJwt: vi.fn(async () => 'kiosk-jwt') }))
mockNuxtImport('useDeviceToken', () => () => deviceToken)

const watchHandle = vi.hoisted(() => ({ connect: vi.fn(async () => {}), stop: vi.fn() }))
interface WatchOptions { getToken: () => unknown, onVeinListRequest: () => void }
const watchOptions = (): WatchOptions => timecardWatch.mock.calls[0]![0] as WatchOptions

const ENTRY = { employeeId: 'e1', moduleId: 10, updatedAt: '2026-10-22T00:00:00Z', approved: true }

describe('VeinFleetHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vein.isConnected = ref(false)
    timecardWatch.mockReturnValue(watchHandle)
    loadVeinModuleEntries.mockResolvedValue([ENTRY])
    vein.syncInfo.mockResolvedValue({ users: 1, max: 100 })
    reportVeinFleet.mockResolvedValue(undefined)
  })

  it('★ mount で Vein Station を掴みに行く (管理者の画面に切り替えても Station の鍵で端末の token を取れるように)', async () => {
    await mountSuspended(VeinFleetHost)
    expect(vein.connect).toHaveBeenCalledTimes(1)
  })

  it('描くものは無く、Vein Station が最初に繋がったときに 1 回だけ購読を張る', async () => {
    const wrapper = await mountSuspended(VeinFleetHost)
    expect(wrapper.text()).toBe('')
    expect(watchHandle.connect).not.toHaveBeenCalled()
    vein.isConnected.value = true
    await flushPromises()
    vein.isConnected.value = false
    await flushPromises()
    vein.isConnected.value = true
    await flushPromises()
    expect(watchHandle.connect).toHaveBeenCalledTimes(1)
    expect(await watchOptions().getToken()).toBe('kiosk-jwt')
  })

  it('★ 合図を受けたら対応表とモジュールの登録人数を報告する (生体データは送らない)', async () => {
    vein.isConnected.value = true
    await mountSuspended(VeinFleetHost)
    watchOptions().onVeinListRequest()
    await flushPromises()
    expect(reportVeinFleet).toHaveBeenCalledWith({
      entries: [{ module_id: 10, employee_id: 'e1', approved: true, version: '2026-10-22T00:00:00Z' }],
      module_users: 1,
      module_max: 100,
    })
  })

  it('登録した端末が分かる記録はそれも送る', async () => {
    loadVeinModuleEntries.mockResolvedValue([{ ...ENTRY, registeredDeviceId: 'alarm:0123456789abcdef' }])
    vein.isConnected.value = true
    await mountSuspended(VeinFleetHost)
    watchOptions().onVeinListRequest()
    await flushPromises()
    expect(reportVeinFleet.mock.calls[0]![0].entries[0].registered_device_id).toBe('alarm:0123456789abcdef')
  })

  it('登録人数が読めない・Station が外れているときは対応表だけ送る', async () => {
    vein.syncInfo.mockRejectedValue(new Error('TIMEOUT'))
    vein.isConnected.value = true
    await mountSuspended(VeinFleetHost)
    watchOptions().onVeinListRequest()
    await flushPromises()
    vein.isConnected.value = false
    watchOptions().onVeinListRequest()
    await flushPromises()
    expect(vein.syncInfo).toHaveBeenCalledTimes(1)
    expect(reportVeinFleet.mock.calls.map(c => Object.keys(c[0]))).toEqual([['entries'], ['entries']])
  })

  it('報告の失敗は握る', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportVeinFleet.mockRejectedValue(new Error('端末の登録が必要です'))
    await mountSuspended(VeinFleetHost)
    watchOptions().onVeinListRequest()
    await flushPromises()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('デモの間は合図を受けても報告しない', async () => {
    await mountSuspended(VeinFleetHost, { props: { demo: true } })
    watchOptions().onVeinListRequest()
    await flushPromises()
    expect(loadVeinModuleEntries).not.toHaveBeenCalled()
    expect(reportVeinFleet).not.toHaveBeenCalled()
  })
})
