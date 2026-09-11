import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

/**
 * useHubClaim (#234-2 で CoreS3 の JWT 先取りに縮小) のテスト。
 *
 * 旧来の `AUTH TICKET` → `/device/pair/token` → `activateFromRegistration` の
 * 経路は撤去済み (応答が alc.ippoan.org から読めず一度も成功していなかったため)。
 * ここでは「CoreS3 の onOpen で `useDeviceToken().getDeviceJwt()` を 1 回呼ぶだけ」
 * であること、`isDeviceActivated` / `useAuth` に一切触れないことだけを見る。
 * useCoreS3Serial / useDeviceToken の実体は他のテストが担保済みなのでここでは mock する。
 */

const coreS3Mock = vi.hoisted(() => ({
  onOpen: vi.fn(),
  startupProbe: vi.fn(async () => false),
  isStartupProbing: { value: false },
}))
mockNuxtImport('useCoreS3Serial', () => () => coreS3Mock)

const deviceTokenMock = vi.hoisted(() => ({
  getDeviceJwt: vi.fn(async () => 'jwt-1'),
  lastError: { value: null as string | null },
}))
mockNuxtImport('useDeviceToken', () => () => deviceTokenMock)

// isDeviceActivated ガード / activateFromRegistration を撤去したことを、
// useAuth 自体が一切呼ばれないことで確かめる
const useAuthMock = vi.hoisted(() => vi.fn(() => ({
  isDeviceActivated: { value: false },
  activateFromRegistration: vi.fn(),
})))
mockNuxtImport('useAuth', () => useAuthMock)

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  deviceTokenMock.lastError.value = null
})

async function load() {
  const mod = await import('~/composables/useHubClaim')
  return mod.useHubClaim
}

describe('useHubClaim', () => {
  it('CoreS3 の onOpen で getDeviceJwt を 1 回呼ぶ', async () => {
    const useHubClaim = await load()
    useHubClaim()

    expect(coreS3Mock.onOpen).toHaveBeenCalledTimes(1)
    const onOpenCb = coreS3Mock.onOpen.mock.calls[0]![0] as () => void
    onOpenCb()

    expect(deviceTokenMock.getDeviceJwt).toHaveBeenCalledTimes(1)
  })

  it('useHubClaim を複数回呼んでも onOpen の登録は 1 回だけ (二重登録しない)', async () => {
    const useHubClaim = await load()
    useHubClaim()
    useHubClaim()
    useHubClaim()

    expect(coreS3Mock.onOpen).toHaveBeenCalledTimes(1)
  })

  it('起動時に CoreS3 の探索 (startupProbe) を 1 回だけ始める (Refs #238)', async () => {
    const useHubClaim = await load()
    useHubClaim()
    useHubClaim()

    expect(coreS3Mock.startupProbe).toHaveBeenCalledTimes(1)
  })

  it('attemptClaim は isDeviceActivated に関係なく毎回 getDeviceJwt を呼ぶ (guard を持たない)', async () => {
    const useHubClaim = await load()
    const { attemptClaim } = useHubClaim()

    await attemptClaim()
    await attemptClaim()

    expect(deviceTokenMock.getDeviceJwt).toHaveBeenCalledTimes(2)
  })

  it('lastError は useDeviceToken のものをそのまま返す', async () => {
    deviceTokenMock.lastError.value = 'CoreS3 sign failed'
    const useHubClaim = await load()
    const { lastError } = useHubClaim()

    expect(lastError.value).toBe('CoreS3 sign failed')
  })

  it('useAuth (isDeviceActivated / activateFromRegistration) には一切触れない', async () => {
    const useHubClaim = await load()
    const { attemptClaim } = useHubClaim()
    await attemptClaim()

    expect(useAuthMock).not.toHaveBeenCalled()
  })
})
