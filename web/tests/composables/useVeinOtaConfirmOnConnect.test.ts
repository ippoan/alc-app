import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import type { EffectScope } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

// Vein がつながったら書き込んだ版を確定する (Refs ippoan/alc-app-s3#352)
const connected = ref(false)
const deviceInfo = ref<{ ver: string | null, flavor: string | null } | null>(null)
const request = vi.fn(async (_line: string, _match: string, _timeoutMs: number, _err?: string) => 'OTA CONFIRMED RX=8192')
mockNuxtImport('useVeinSerial', () => () => ({ isConnected: connected, deviceInfo, request }))

const ota = vi.hoisted(() => ({ running: false }))
vi.mock('~/composables/useSerialOta', () => ({ isSerialOtaRunning: () => ota.running }))

describe('useVeinOtaConfirmOnConnect', () => {
  let useVeinOtaConfirmOnConnect: typeof import('~/composables/useVeinOtaConfirmOnConnect').useVeinOtaConfirmOnConnect
  let scope: EffectScope
  beforeEach(async () => {
    scope = effectScope()
    connected.value = false
    deviceInfo.value = { ver: '0.1.8+a1356f4', flavor: 'vein' }
    ota.running = false
    request.mockReset()
    request.mockResolvedValue('OTA CONFIRMED RX=8192')
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.resetModules()
    useVeinOtaConfirmOnConnect = (await import('~/composables/useVeinOtaConfirmOnConnect')).useVeinOtaConfirmOnConnect
  })
  afterEach(() => {
    scope.stop()
    vi.restoreAllMocks()
  })

  it('★ つながって名乗った機体に OTA CONFIRM を送る (つながるたびに)', async () => {
    scope.run(() => useVeinOtaConfirmOnConnect().start())
    expect(request).not.toHaveBeenCalled()
    connected.value = true
    await nextTick()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(request).toHaveBeenCalledWith('OTA CONFIRM', 'OTA CONFIRMED', 10_000, 'OTA ERR')
    connected.value = false
    await nextTick()
    connected.value = true
    await nextTick()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  })

  it('名乗りに FLAVOR が無い・書き込みが走っている・つながっていないときは送らない', async () => {
    const api = useVeinOtaConfirmOnConnect()
    expect(await api.confirm()).toBe(false)
    connected.value = true
    deviceInfo.value = { ver: '0.1.0', flavor: null }
    expect(await api.confirm()).toBe(false)
    deviceInfo.value = { ver: '0.1.8', flavor: 'vein' }
    ota.running = true
    expect(await api.confirm()).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  it('既に応答待ちで弾かれたら間を置いて送り直す。ほかの失敗は false で次の接続に回す', async () => {
    vi.useFakeTimers()
    connected.value = true
    request.mockRejectedValueOnce(new Error('request(timecard): 既に応答待ちです'))
    const p = useVeinOtaConfirmOnConnect().confirm()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await p).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
    request.mockRejectedValueOnce(new Error('OTA ERR timeout'))
    expect(await useVeinOtaConfirmOnConnect().confirm()).toBe(false)
  })

  it('start は 1 回だけ配線する', async () => {
    connected.value = true
    scope.run(() => {
      useVeinOtaConfirmOnConnect().start()
      useVeinOtaConfirmOnConnect().start()
    })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  })
})
