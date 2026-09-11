import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import DeviceUnregisteredBanner from '~/components/DeviceUnregisteredBanner.vue'
import { deviceUnregisteredMessage } from '~/utils/employee-lookup-messages'

// 「未登録」の判定は useKioskAccess に一本化した (Refs #234)。この banner は
// hasKioskAccess だけを見るので、その 1 変数だけをモックする。
const hasKioskAccess = ref(false)

mockNuxtImport('useKioskAccess', () => () => ({ hasKioskAccess }))

describe('DeviceUnregisteredBanner', () => {
  beforeEach(() => {
    hasKioskAccess.value = false
  })

  it('hasKioskAccess が false なら赤枠で原因と次の操作を出す', async () => {
    const wrapper = await mountSuspended(DeviceUnregisteredBanner)

    const banner = wrapper.find('[data-testid="device-unregistered-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain(deviceUnregisteredMessage)
    expect(banner.text()).toContain('「端末登録」で QR を読み取ってください')
    expect(banner.text()).toContain('登録するまで免許証の照合と打刻一覧は動きません')
    expect(wrapper.find('.border-red-200').exists()).toBe(true)
    wrapper.unmount()
  })

  it('hasKioskAccess が true なら出さない', async () => {
    hasKioskAccess.value = true
    const wrapper = await mountSuspended(DeviceUnregisteredBanner)
    expect(wrapper.find('[data-testid="device-unregistered-banner"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('hasKioskAccess が true になった時点で消える', async () => {
    const wrapper = await mountSuspended(DeviceUnregisteredBanner)
    expect(wrapper.find('[data-testid="device-unregistered-banner"]').exists()).toBe(true)

    hasKioskAccess.value = true
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="device-unregistered-banner"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
