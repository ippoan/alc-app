import { describe, it, expect, beforeEach } from 'vitest'
import { ref, computed } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import DeviceUnregisteredBanner from '~/components/DeviceUnregisteredBanner.vue'
import { deviceUnregisteredMessage } from '~/utils/employee-lookup-messages'

// useAuth と同じ式 (useAuth.ts:48-49) をモック側でも保つ
const accessToken = ref<string | null>(null)
const deviceTenantId = ref<string | null>(null)

mockNuxtImport('useAuth', () => () => ({
  accessToken,
  deviceTenantId,
  isAuthenticated: computed(() => !!accessToken.value),
  isDeviceActivated: computed(() => !!deviceTenantId.value),
}))

describe('DeviceUnregisteredBanner', () => {
  beforeEach(() => {
    accessToken.value = null
    deviceTenantId.value = null
  })

  it('端末未登録かつ未ログインなら赤枠で原因と次の操作を出す', async () => {
    const wrapper = await mountSuspended(DeviceUnregisteredBanner)

    const banner = wrapper.find('[data-testid="device-unregistered-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain(deviceUnregisteredMessage)
    expect(banner.text()).toContain('「端末登録」で QR を読み取ってください')
    expect(banner.text()).toContain('登録するまで免許証の照合と打刻一覧は動きません')
    expect(wrapper.find('.border-red-200').exists()).toBe(true)
    wrapper.unmount()
  })

  it('端末登録済み / 管理者ログイン済みのどちらでも出さない', async () => {
    deviceTenantId.value = 'tenant-x'
    const activated = await mountSuspended(DeviceUnregisteredBanner)
    expect(activated.find('[data-testid="device-unregistered-banner"]').exists()).toBe(false)
    activated.unmount()

    deviceTenantId.value = null
    accessToken.value = 'jwt'
    const loggedIn = await mountSuspended(DeviceUnregisteredBanner)
    expect(loggedIn.find('[data-testid="device-unregistered-banner"]').exists()).toBe(false)
    loggedIn.unmount()
  })

  it('登録が済んだ時点で消える', async () => {
    const wrapper = await mountSuspended(DeviceUnregisteredBanner)
    expect(wrapper.find('[data-testid="device-unregistered-banner"]').exists()).toBe(true)

    deviceTenantId.value = 'tenant-x'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="device-unregistered-banner"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
