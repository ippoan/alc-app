import { describe, it, expect, beforeEach } from 'vitest'
import { ref, computed } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

// hasDeviceJwt は兄弟 #p135-c234-2 が useDeviceToken.ts に足す予定 (未マージ)。
// ここでは mock だけで検証し、マージ後に rebase してそのまま通す。
const accessToken = ref<string | null>(null)
const deviceTenantId = ref<string | null>(null)
const hasDeviceJwt = ref(false)

mockNuxtImport('useAuth', () => () => ({
  accessToken,
  deviceTenantId,
  isAuthenticated: computed(() => !!accessToken.value),
  isDeviceActivated: computed(() => !!deviceTenantId.value),
}))

mockNuxtImport('useDeviceToken', () => () => ({
  hasDeviceJwt,
}))

describe('useKioskAccess', () => {
  beforeEach(() => {
    accessToken.value = null
    deviceTenantId.value = null
    hasDeviceJwt.value = false
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
})
