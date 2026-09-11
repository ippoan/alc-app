import { describe, it, expect, beforeEach } from 'vitest'
import { ref, computed } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

// hasDeviceJwt は兄弟 #p135-c234-2 が useDeviceToken.ts に足す予定 (未マージ)。
// ここでは mock だけで検証し、マージ後に rebase してそのまま通す。
const accessToken = ref<string | null>(null)
const deviceTenantId = ref<string | null>(null)
const hasDeviceJwt = ref(false)

// isStartupJwtPending は useDeviceToken.ts の起動時の 1 本 (探索 → 最初の端末 JWT) のフラグ (Refs #238)。
const isStartupJwtPending = ref(false)

mockNuxtImport('useAuth', () => () => ({
  accessToken,
  deviceTenantId,
  isAuthenticated: computed(() => !!accessToken.value),
  isDeviceActivated: computed(() => !!deviceTenantId.value),
}))

mockNuxtImport('useDeviceToken', () => () => ({
  hasDeviceJwt,
  isStartupJwtPending,
}))

describe('useKioskAccess', () => {
  beforeEach(() => {
    accessToken.value = null
    deviceTenantId.value = null
    hasDeviceJwt.value = false
    isStartupJwtPending.value = false
  })

  it('3 条件すべて false なら hasKioskAccess は false', async () => {
    const { useKioskAccess } = await import('~/composables/useKioskAccess')
    const { hasKioskAccess } = useKioskAccess()
    expect(hasKioskAccess.value).toBe(false)
  })

  it('isAuthenticated (ログイン済み) だけで true', async () => {
    accessToken.value = 'jwt'
    const { useKioskAccess } = await import('~/composables/useKioskAccess')
    const { hasKioskAccess } = useKioskAccess()
    expect(hasKioskAccess.value).toBe(true)
  })

  it('isDeviceActivated (端末登録済み) だけで true', async () => {
    deviceTenantId.value = 'tenant-x'
    const { useKioskAccess } = await import('~/composables/useKioskAccess')
    const { hasKioskAccess } = useKioskAccess()
    expect(hasKioskAccess.value).toBe(true)
  })

  it('hasDeviceJwt (CoreS3 署名の短命 JWT) だけで true', async () => {
    hasDeviceJwt.value = true
    const { useKioskAccess } = await import('~/composables/useKioskAccess')
    const { hasKioskAccess } = useKioskAccess()
    expect(hasKioskAccess.value).toBe(true)
  })

  // isCheckingKioskAccess の真理値表 (hasKioskAccess × isStartupJwtPending, Refs #238)
  describe('isCheckingKioskAccess', () => {
    it('hasKioskAccess=false, isStartupJwtPending=false → false (確認中ではない=未登録確定)', async () => {
      const { useKioskAccess } = await import('~/composables/useKioskAccess')
      const { isCheckingKioskAccess } = useKioskAccess()
      expect(isCheckingKioskAccess.value).toBe(false)
    })

    it('hasKioskAccess=false, isStartupJwtPending=true → true (確認中)', async () => {
      isStartupJwtPending.value = true
      const { useKioskAccess } = await import('~/composables/useKioskAccess')
      const { isCheckingKioskAccess } = useKioskAccess()
      expect(isCheckingKioskAccess.value).toBe(true)
    })

    it('hasKioskAccess=true, isStartupJwtPending=false → false (そもそもアクセスあり)', async () => {
      accessToken.value = 'jwt'
      const { useKioskAccess } = await import('~/composables/useKioskAccess')
      const { isCheckingKioskAccess } = useKioskAccess()
      expect(isCheckingKioskAccess.value).toBe(false)
    })

    it('hasKioskAccess=true, isStartupJwtPending=true → false (アクセスがあるので確認中扱いにしない)', async () => {
      accessToken.value = 'jwt'
      isStartupJwtPending.value = true
      const { useKioskAccess } = await import('~/composables/useKioskAccess')
      const { isCheckingKioskAccess } = useKioskAccess()
      expect(isCheckingKioskAccess.value).toBe(false)
    })
  })
})
