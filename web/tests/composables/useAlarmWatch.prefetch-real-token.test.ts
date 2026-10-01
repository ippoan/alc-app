// 先取りの失敗が、後続の本物の要求を遅らせないこと (Refs ippoan/alc-app#387)。
// useManagerDeviceToken は**本物**を繋ぐ — 抑止の期限 (readonly で返る) を戻す書き込みが
// 本物の module スコープに届くことは、モックでは確かめられないため。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, readonly, nextTick } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { withSetup } from '../helpers/with-setup'

const isConnected = ref(false)
mockNuxtImport('useAlarmDevice', () => () => ({
  isSupported: true,
  isConnected: readonly(isConnected),
  connect: () => {},
  disconnect: async () => {},
  request: vi.fn(),
}))
mockNuxtImport('useActiveRooms', () => () => ({ start: () => {}, stop: () => {} }))
mockNuxtImport('useAlarmDeviceSetting', () => () => ({ enabled: ref(true), setEnabled: vi.fn() }))

const signAlarmDeviceNonceMock = vi.hoisted(() => vi.fn())
vi.mock('~/utils/alarm-sign', () => ({ signAlarmDeviceNonce: signAlarmDeviceNonceMock }))

beforeEach(() => {
  isConnected.value = false
  vi.resetModules()
  signAlarmDeviceNonceMock.mockReset()
  signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pk', sig: 'sig' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useAlarmWatch の先取り × 本物の useManagerDeviceToken', () => {
  it('★ 先取りが失敗しても抑止は残らず、直後の本物の要求はもう一度取りに行って通る', async () => {
    const fetchMock = vi.fn()
      // 先取り: 繋がった直後で nonce が取れない
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      // 本物の要求: nonce → token
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: 'nonce-1' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'manager.jwt', expires_in: 900 }) })
    vi.stubGlobal('fetch', fetchMock)

    const { useAlarmWatch } = await import('~/composables/useAlarmWatch')
    const { useManagerDeviceToken } = await import('~/composables/useManagerDeviceToken')
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await nextTick()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const manager = useManagerDeviceToken()
    expect(manager.backoffUntil.value).toBe(0)

    expect(await manager.getManagerJwt()).toBe('manager.jwt')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    app.unmount()
  })
})
