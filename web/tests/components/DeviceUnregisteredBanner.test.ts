import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import DeviceUnregisteredBanner from '~/components/DeviceUnregisteredBanner.vue'
import { deviceUnregisteredMessage } from '~/utils/employee-lookup-messages'

// 「未登録」の判定は useKioskAccess に一本化した (Refs #234, #238)。この banner は
// hasKioskAccess / isCheckingKioskAccess だけを見るので、その 2 変数だけをモックする。
const hasKioskAccess = ref(false)
const isCheckingKioskAccess = ref(false)

mockNuxtImport('useKioskAccess', () => () => ({ hasKioskAccess, isCheckingKioskAccess }))

describe('DeviceUnregisteredBanner', () => {
  beforeEach(() => {
    hasKioskAccess.value = false
    isCheckingKioskAccess.value = false
  })

  it('hasKioskAccess が false なら赤枠で原因と次の操作を出す', async () => {
    const wrapper = await mountSuspended(DeviceUnregisteredBanner)

    const banner = wrapper.find('[data-testid="device-unregistered-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain(deviceUnregisteredMessage)
    expect(banner.text()).toContain('CoreS3 を USB でつなぐと自動で使えるようになります')
    expect(banner.text()).toContain('初めて使う CoreS3 は、管理者が登録画面で鍵を登録してください')
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

  it('isCheckingKioskAccess が true の間は出さない (起動時 CoreS3 探索中、Refs #238)', async () => {
    isCheckingKioskAccess.value = true
    const wrapper = await mountSuspended(DeviceUnregisteredBanner)
    expect(wrapper.find('[data-testid="device-unregistered-banner"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('確認が終わり isCheckingKioskAccess が false になれば出る', async () => {
    isCheckingKioskAccess.value = true
    const wrapper = await mountSuspended(DeviceUnregisteredBanner)
    expect(wrapper.find('[data-testid="device-unregistered-banner"]').exists()).toBe(false)

    isCheckingKioskAccess.value = false
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="device-unregistered-banner"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('/login へのリンクは置かない (運行者を /login に誘導しない決定、Refs #238)', async () => {
    const wrapper = await mountSuspended(DeviceUnregisteredBanner)
    expect(wrapper.find('a[href="/login"]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'NuxtLink' }).exists()).toBe(false)
    wrapper.unmount()
  })
})
