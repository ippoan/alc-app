import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import type { Ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

/**
 * キオスクが、繋がっている指静脈端末 (Vein Station) の版を管理者の一覧「端末のファーム」へ報告する
 * (Refs ippoan/alc-app-s3#352)。
 *
 * Vein Station (`useVeinSerial`) と端末の token (`useDeviceToken`) は偽物で模す。
 */

interface DeviceInfo { ver: string | null, board: string | null, flavor: string | null }

const vein = vi.hoisted(() => ({
  isConnected: null as unknown as Ref<boolean>,
  deviceInfo: null as unknown as Ref<DeviceInfo | null>,
}))
mockNuxtImport('useVeinSerial', () => () => vein)

const deviceToken = vi.hoisted(() => ({
  getDeviceJwt: null as unknown as ReturnType<typeof vi.fn>,
}))
mockNuxtImport('useDeviceToken', () => () => deviceToken)

/** 運行管理者席の鍵 (useManagerDeviceToken。Refs ippoan/alc-app-s3#352) */
const managerToken = vi.hoisted(() => ({
  getManagerJwt: null as unknown as ReturnType<typeof vi.fn>,
}))
mockNuxtImport('useManagerDeviceToken', () => () => managerToken)

const reportFirmware = vi.hoisted(() => vi.fn())
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  reportFirmware,
}))

const INFO: DeviceInfo = { ver: '0.6.0+abc1234', board: null, flavor: 'timecard-vein' }
const INTERVAL_MS = 5 * 60 * 1000

/** sub だけ持つ JWT (署名は見ない) */
const jwtWithSub = (sub: string) => `h.${btoa(JSON.stringify({ sub })).replace(/=+$/, '')}.s`

describe('useVeinFirmwareReport', () => {
  let mod: typeof import('~/composables/useVeinFirmwareReport')
  let fw: ReturnType<typeof mod.useVeinFirmwareReport>
  let warn: ReturnType<typeof vi.spyOn>

  /** Vein Station が繋がって名乗った */
  async function open(info: DeviceInfo | null = INFO): Promise<void> {
    vein.isConnected.value = true
    vein.deviceInfo.value = info
    await flushPromises()
  }

  const phases = () => reportFirmware.mock.calls.map(c => (c[0] as { phase: string }).phase)

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    vein.isConnected = ref(false)
    vein.deviceInfo = ref(null)
    deviceToken.getDeviceJwt = vi.fn(async () => jwtWithSub('alarm:0123456789abcdef'))
    managerToken.getManagerJwt = vi.fn(async () => null)
    reportFirmware.mockReset()
    reportFirmware.mockResolvedValue(undefined)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.resetModules()
    mod = await import('~/composables/useVeinFirmwareReport')
    fw = mod.useVeinFirmwareReport()
  })

  afterEach(() => {
    fw.stop()
    warn.mockRestore()
    vi.useRealTimers()
  })

  it('★ 繋がって名乗ったら idle を 1 回、kind: timecard・端末の token 由来の id・版と flavor で送る', async () => {
    fw.start()
    expect(reportFirmware).not.toHaveBeenCalled()
    await open()
    expect(reportFirmware).toHaveBeenCalledTimes(1)
    expect(reportFirmware).toHaveBeenCalledWith({
      device_id: 'alarm-0123456789abcdef',
      kind: 'timecard',
      flavor: 'timecard-vein',
      version: '0.6.0+abc1234',
      phase: 'idle',
    }, 'default')
    expect(fw.deviceId.value).toBe('alarm-0123456789abcdef')
    // キオスクの鍵が取れたら席の鍵は取りに行かない
    expect(managerToken.getManagerJwt).not.toHaveBeenCalled()
  })

  it('5 分ごとに idle を送り直し、stop で止まる。二重の start は 1 回分', async () => {
    await open()
    fw.start()
    fw.start()
    await flushPromises()
    expect(phases()).toEqual(['idle'])
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(phases()).toEqual(['idle', 'idle'])
    fw.stop()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)
    expect(phases()).toEqual(['idle', 'idle'])
  })

  it('★ hold の間は待機の報告 (周期・繋がり直し) を送らず、遷移の報告は送る。release は何も送らない (結果を上書きしない)', async () => {
    fw.start()
    await open()
    fw.hold()
    await fw.report('writing', { target_version: '0.7.0' })
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    vein.isConnected.value = false
    vein.deviceInfo.value = null
    await flushPromises()
    await open()
    await fw.report('done', { target_version: '0.7.0' })
    fw.release()
    await flushPromises()
    expect(phases()).toEqual(['idle', 'writing', 'done'])
    expect(reportFirmware.mock.calls[1]![0]).toMatchObject({ phase: 'writing', target_version: '0.7.0' })
    // 解いた後の周期は idle に戻る
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(phases()).toEqual(['idle', 'writing', 'done', 'idle'])
  })

  it('★ 運行管理者席: キオスクの鍵が取れなければ席の鍵で取り、その id で scope manager-device で送る (Refs ippoan/alc-app-s3#352)', async () => {
    deviceToken.getDeviceJwt.mockResolvedValue(null)
    managerToken.getManagerJwt.mockResolvedValue(jwtWithSub('alarm:fedcba9876543210'))
    vein.isConnected.value = true
    vein.deviceInfo.value = INFO
    await fw.report('idle')
    expect(reportFirmware).toHaveBeenCalledWith({
      device_id: 'alarm-fedcba9876543210',
      kind: 'timecard',
      flavor: 'timecard-vein',
      version: '0.6.0+abc1234',
      phase: 'idle',
    }, 'manager-device')
    expect(fw.deviceId.value).toBe('alarm-fedcba9876543210')
  })

  it('★ 同じ機体でキオスクの鍵と席の鍵の両方が取れても、キオスクの鍵の 1 つだけで報告する (2 つの id で送らない)', async () => {
    managerToken.getManagerJwt.mockResolvedValue(jwtWithSub('alarm:fedcba9876543210'))
    vein.isConnected.value = true
    await fw.report('idle')
    expect(reportFirmware).toHaveBeenCalledTimes(1)
    expect(reportFirmware.mock.calls[0]![0]).toMatchObject({ device_id: 'alarm-0123456789abcdef' })
    expect(reportFirmware.mock.calls[0]![1]).toBe('default')
    expect(managerToken.getManagerJwt).not.toHaveBeenCalled()
  })

  it('未接続・端末の token が無い・id の取れない token では送らない', async () => {
    await fw.report('idle')
    vein.isConnected.value = true
    // composable は作った時点の getDeviceJwt を握るので、差し替えは同じ関数の実装で
    // キオスクの鍵も席の鍵も取れない
    deviceToken.getDeviceJwt.mockResolvedValue(null)
    await fw.report('idle')
    deviceToken.getDeviceJwt.mockResolvedValue('not-a-jwt')
    managerToken.getManagerJwt.mockResolvedValue('not-a-jwt')
    await fw.report('idle')
    expect(reportFirmware).not.toHaveBeenCalled()
  })

  it('名乗りに BOARD があれば board も載せる', async () => {
    vein.isConnected.value = true
    vein.deviceInfo.value = { ver: '0.6.0', board: 'atoms3r', flavor: 'timecard-station' }
    await fw.report('idle')
    expect(reportFirmware).toHaveBeenCalledWith({
      device_id: 'alarm-0123456789abcdef', kind: 'timecard', board: 'atoms3r', flavor: 'timecard-station', version: '0.6.0', phase: 'idle',
    }, 'default')
  })

  it('名乗りに無い値は key ごと載せない', async () => {
    vein.isConnected.value = true
    vein.deviceInfo.value = { ver: null, board: null, flavor: null }
    await fw.report('idle')
    expect(reportFirmware).toHaveBeenCalledWith({ device_id: 'alarm-0123456789abcdef', kind: 'timecard', phase: 'idle' }, 'default')
  })

  it('送信の失敗・token の取得の例外は握る (外へ出さない)', async () => {
    vein.isConnected.value = true
    reportFirmware.mockRejectedValue(new Error('500'))
    await expect(fw.report('idle')).resolves.toBeUndefined()
    reportFirmware.mockResolvedValue(undefined)
    deviceToken.getDeviceJwt.mockRejectedValue(new Error('sign'))
    await expect(fw.report('idle')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
