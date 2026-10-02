// 先取りの失敗が、後続の本物の要求を遅らせないこと (Refs ippoan/alc-app#387)。
// useManagerDeviceToken は**本物**を繋ぎ、警告デバイスが繋がる → 先取り → 本物の要求、を通しで見る。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, readonly, nextTick } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { withSetup } from '../helpers/with-setup'

// 見張りは止めるまで生き続ける。前のテストの見張りが次のテストの接続に反応しないよう、
// 接続の ref はテストごとに作り直す
let isConnected = ref(false)
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
  isConnected = ref(false)
  vi.resetModules()
  signAlarmDeviceNonceMock.mockReset()
  signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pk', sig: 'sig' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
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

  // 席の鍵で読む画面は、この回数を watch して読み直す (TenkoItAdminView / TenkoScheduleManager)
  it('★ 接続時の先取りが失敗 → 試し直しで取れる → 「失敗の後に取れた回数」が 1 増える', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const fetchMock = vi.fn()
      // 接続時の先取り: 繋がった直後で nonce が取れない
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      // 試し直し: nonce → token
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: 'nonce-1' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'manager.jwt', expires_in: 900 }) })
    vi.stubGlobal('fetch', fetchMock)

    const { useAlarmWatch, PREFETCH_RETRY_DELAY_MS } = await import('~/composables/useAlarmWatch')
    const { useManagerDeviceToken } = await import('~/composables/useManagerDeviceToken')
    const manager = useManagerDeviceToken()
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(manager.managerJwtRecoveredCount.value).toBe(0)

    await vi.advanceTimersByTimeAsync(PREFETCH_RETRY_DELAY_MS)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(manager.managerJwtRecoveredCount.value).toBe(1)

    // 取れた後は cache から返る (通信もしないし、回数も増えない)
    expect(await manager.getManagerJwt()).toBe('manager.jwt')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(manager.managerJwtRecoveredCount.value).toBe(1)
    app.unmount()
  })

  // 切断の猶予 (Refs ippoan/alc-app#387): 見張りが入れた期限で、本物のトークンが使えなくなる
  it('★ 警告デバイスが切れても 2 分はトークンが使え、2 分を過ぎたら null。開発用の印は落ちず、繋ぎ直せば取り直す', async () => {
    const T0 = Date.UTC(2026, 0, 1, 0, 0, 0)
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(T0)
    localStorage.clear()
    const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
    const devJwt = (sub: string) => `${seg({ alg: 'HS256' })}.${seg({ sub, aud: 'device', dev_device: true })}.sig`
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: 'nonce-1' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: devJwt('first'), expires_in: 900 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: 'nonce-2' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: devJwt('second'), expires_in: 900 }) })
    vi.stubGlobal('fetch', fetchMock)

    const { useAlarmWatch, useSeatDisconnectGrace } = await import('~/composables/useAlarmWatch')
    const { useManagerDeviceToken } = await import('~/composables/useManagerDeviceToken')
    const { isDevDevice } = await import('~/utils/token-selection')
    const { remainingSeconds } = useSeatDisconnectGrace()
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await nextTick()
    await flushPromises()
    const manager = useManagerDeviceToken()
    expect(await manager.getManagerJwt()).toBe(devJwt('first'))
    expect(isDevDevice('manager-device')).toBe(true)

    // USB が切れた
    isConnected.value = false
    await nextTick()
    expect(remainingSeconds.value).toBe(120)
    vi.advanceTimersByTime(119_000)
    expect(remainingSeconds.value).toBe(1)
    expect(await manager.getManagerJwt()).toBe(devJwt('first'))

    vi.advanceTimersByTime(1000)
    expect(remainingSeconds.value).toBeNull()
    expect(await manager.getManagerJwt()).toBeNull()
    expect(manager.lastFailureStage.value).toBe('no-alarm-device')
    // 印は落ちない (落ちると、送る側が席の鍵ではない経路を選ぶ)
    expect(isDevDevice('manager-device')).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // 繋ぎ直したら、先取りが取り直す
    isConnected.value = true
    await nextTick()
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(await manager.getManagerJwt()).toBe(devJwt('second'))
    app.unmount()
  })
})
