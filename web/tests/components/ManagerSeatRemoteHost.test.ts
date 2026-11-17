// 運行管理者席の、開発用の遠隔操作の受け答え (Refs ippoan/alc-app-s3#352)。
// Vein Base が最初につながったときに席の鍵で購読を張り、命令には席の鍵で答える。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ManagerSeatRemoteHost from '~/components/ManagerSeatRemoteHost.vue'
import { resetReloadContext, useKioskScreen } from '~/composables/useKioskScreen'

const { reportKioskCommandResult } = vi.hoisted(() => ({ reportKioskCommandResult: vi.fn() }))
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  reportKioskCommandResult,
}))

const timecardWatch = vi.hoisted(() => vi.fn())
mockNuxtImport('useTimecardWatch', () => timecardWatch)

const vein = vi.hoisted(() => ({ isConnected: null as unknown as { value: boolean } }))
mockNuxtImport('useVeinSerial', () => () => vein)

const serialOta = vi.hoisted(() => ({ run: vi.fn(async () => 'updated'), enqueue: vi.fn(), runQueued: vi.fn(async () => {}) }))
mockNuxtImport('useSerialOta', () => () => serialOta)

const SEAT_JWT = `h.${btoa(JSON.stringify({ sub: 'alarm:0123456789abcdef', dev_device: true }))}.s`
const managerToken = vi.hoisted(() => ({ getManagerJwt: vi.fn() }))
mockNuxtImport('useManagerDeviceToken', () => () => managerToken)

const watchHandle = vi.hoisted(() => ({ connect: vi.fn(async () => {}), stop: vi.fn() }))
interface WatchOptions {
  getToken: () => unknown
  onKioskCommand: (data: unknown) => void
  onSerialOta: (target: string, deviceId?: string) => void
}
const watchOptions = (): WatchOptions => timecardWatch.mock.calls[0]![0] as WatchOptions

describe('ManagerSeatRemoteHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.setItem('alc-kiosk-remote', '1')
    vein.isConnected = ref(false)
    timecardWatch.mockReturnValue(watchHandle)
    managerToken.getManagerJwt.mockResolvedValue(SEAT_JWT)
    reportKioskCommandResult.mockResolvedValue(undefined)
  })

  it('描くものは無く、Vein Base が最初につながったときに席の鍵で 1 回だけ購読を張る。外したら止める', async () => {
    const wrapper = await mountSuspended(ManagerSeatRemoteHost)
    expect(wrapper.text()).toBe('')
    expect(watchHandle.connect).not.toHaveBeenCalled()
    vein.isConnected.value = true
    await flushPromises()
    vein.isConnected.value = false
    await flushPromises()
    vein.isConnected.value = true
    await flushPromises()
    expect(watchHandle.connect).toHaveBeenCalledTimes(1)
    expect(await watchOptions().getToken()).toBe(SEAT_JWT)
    wrapper.unmount()
    expect(watchHandle.stop).toHaveBeenCalled()
  })

  it('★ 自分宛ての命令に、席の鍵で答える', async () => {
    vein.isConnected.value = true
    await mountSuspended(ManagerSeatRemoteHost)
    watchOptions().onKioskCommand({ type: 'kiosk_command', id: 'c1', device_id: 'alarm-0123456789abcdef', op: 'hello', args: {} })
    await flushPromises()
    expect(reportKioskCommandResult).toHaveBeenCalledWith(
      'c1',
      { done: true, ok: true, op: 'hello', result: { device_id: 'alarm-0123456789abcdef', vein_connected: true } },
      'manager-device',
    )
  })

  it('firmware_update は Vein の target で更新して席の鍵で答える', async () => {
    vein.isConnected.value = true
    await mountSuspended(ManagerSeatRemoteHost)
    watchOptions().onKioskCommand({ type: 'kiosk_command', id: 'c2', device_id: '*', op: 'firmware_update', args: {} })
    await flushPromises()
    expect(serialOta.run).toHaveBeenCalledWith('timecard-station')
    expect(reportKioskCommandResult).toHaveBeenLastCalledWith(
      'c2',
      { done: true, ok: true, op: 'firmware_update', result: { outcome: 'updated' } },
      'manager-device',
    )
  })

  describe('管理者の一覧「端末のファーム」からの 1 台指定の更新 (Refs ippoan/alc-app-s3#352)', () => {
    beforeEach(() => {
      resetReloadContext()
    })

    it('★ 自分 (席の鍵の id) 宛ての timecard-station の合図は預け、席が機体を使っていなければ走らせる', async () => {
      vein.isConnected.value = true
      await mountSuspended(ManagerSeatRemoteHost)
      watchOptions().onSerialOta('timecard-station', 'alarm-0123456789abcdef')
      await flushPromises()
      expect(serialOta.enqueue).toHaveBeenCalledTimes(1)
      expect(serialOta.enqueue.mock.calls[0]![0]).toBe('timecard-station')
      // 始める直前にも聞き直せるよう、使用中の判定を渡す
      const opts = serialOta.enqueue.mock.calls[0]![1] as { isBusy: () => boolean }
      expect(opts.isBusy()).toBe(false)
      expect(serialOta.runQueued).toHaveBeenCalledTimes(1)
    })

    it('★ 照合・登録の途中 (使用中の申告あり) は預けるだけ。空いたら走らせる', async () => {
      vein.isConnected.value = true
      const busy = ref(true)
      const wrapper = await mountSuspended(ManagerSeatRemoteHost)
      // 席の画面 (RoleAuthGate / VeinRegistration) の申告の代わり
      const declarer = await mountSuspended({ setup() { useKioskScreen().declareDeviceBusy(busy); return () => null } })
      watchOptions().onSerialOta('timecard-station', 'alarm-0123456789abcdef')
      await flushPromises()
      expect(serialOta.enqueue).toHaveBeenCalledTimes(1)
      expect((serialOta.enqueue.mock.calls[0]![1] as { isBusy: () => boolean }).isBusy()).toBe(true)
      expect(serialOta.runQueued).not.toHaveBeenCalled()
      busy.value = false
      await flushPromises()
      // 空いたら走らせる (前の回で mount した host の watch も同じ偽物を呼ぶので回数は数えない)
      expect(serialOta.runQueued).toHaveBeenCalled()
      declarer.unmount()
      wrapper.unmount()
    })

    it('★ ほかの端末宛て・device_id 無し・ほかの target・自分の id が取れないときは預からない', async () => {
      vein.isConnected.value = true
      await mountSuspended(ManagerSeatRemoteHost)
      watchOptions().onSerialOta('timecard-station', 'alarm-fedcba9876543210')
      watchOptions().onSerialOta('timecard-station')
      watchOptions().onSerialOta('cores3', 'alarm-0123456789abcdef')
      await flushPromises()
      managerToken.getManagerJwt.mockResolvedValue(null)
      watchOptions().onSerialOta('timecard-station', 'alarm-0123456789abcdef')
      await flushPromises()
      managerToken.getManagerJwt.mockRejectedValue(new Error('no key'))
      watchOptions().onSerialOta('timecard-station', 'alarm-0123456789abcdef')
      await flushPromises()
      expect(serialOta.enqueue).not.toHaveBeenCalled()
      expect(serialOta.runQueued).not.toHaveBeenCalled()
    })
  })
})
