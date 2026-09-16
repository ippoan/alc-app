import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import DeviceUnregisteredBanner from '~/components/DeviceUnregisteredBanner.vue'
import { deviceUnregisteredMessage } from '~/utils/employee-lookup-messages'

// 「未登録」の判定は useKioskAccess に一本化した (Refs #234, #238)。この banner は
// hasKioskAccess / isCheckingKioskAccess / reasons を見る。
// #135: 診断行のため useDeviceToken の lastFailureStage / lastFailureStatus もモックする。
const hasKioskAccess = ref(false)
const isCheckingKioskAccess = ref(false)
const reasons = ref({ isAuthenticated: false, isDeviceActivated: false, hasDeviceJwt: false })
const lastFailureStage = ref<'no-core-s3' | 'nonce' | 'coreS3-sign' | 'token-exchange' | null>(null)
const lastFailureStatus = ref<number | null>(null)

mockNuxtImport('useKioskAccess', () => () => ({ hasKioskAccess, isCheckingKioskAccess, reasons }))
mockNuxtImport('useDeviceToken', () => () => ({ lastFailureStage, lastFailureStatus }))

describe('DeviceUnregisteredBanner', () => {
  beforeEach(() => {
    hasKioskAccess.value = false
    isCheckingKioskAccess.value = false
    reasons.value = { isAuthenticated: false, isDeviceActivated: false, hasDeviceJwt: false }
    lastFailureStage.value = null
    lastFailureStatus.value = null
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

  // 短い診断行 (Refs ippoan/alc-app-s3#135)
  describe('診断行', () => {
    it('3 条件すべて false / 署名は未試行なら「ログイン: なし / 端末の有効化: なし / 端末の署名: まだ」', async () => {
      const wrapper = await mountSuspended(DeviceUnregisteredBanner)
      const diag = wrapper.find('[data-testid="device-unregistered-diagnostics"]')
      expect(diag.text()).toBe('ログイン: なし / 端末の有効化: なし / 端末の署名: まだ')
      wrapper.unmount()
    })

    it('署名が token-exchange 401 で失敗していれば「端末の署名: 失敗 (交換 401)」', async () => {
      lastFailureStage.value = 'token-exchange'
      lastFailureStatus.value = 401
      const wrapper = await mountSuspended(DeviceUnregisteredBanner)
      const diag = wrapper.find('[data-testid="device-unregistered-diagnostics"]')
      expect(diag.text()).toContain('端末の署名: 失敗 (交換 401)')
      wrapper.unmount()
    })

    it('CoreS3 未接続 (HTTP を伴わない失敗) は status を付けない', async () => {
      lastFailureStage.value = 'no-core-s3'
      lastFailureStatus.value = null
      const wrapper = await mountSuspended(DeviceUnregisteredBanner)
      const diag = wrapper.find('[data-testid="device-unregistered-diagnostics"]')
      expect(diag.text()).toContain('端末の署名: 失敗 (CoreS3 未接続)')
      wrapper.unmount()
    })

    it('コンソールへの誘導文が出る', async () => {
      const wrapper = await mountSuspended(DeviceUnregisteredBanner)
      expect(wrapper.text()).toContain('詳しくはブラウザのコンソール')
      wrapper.unmount()
    })

    it('診断行にトークンや device_id を含めない (真偽と段のラベルだけ)', async () => {
      reasons.value = { isAuthenticated: true, isDeviceActivated: true, hasDeviceJwt: true }
      lastFailureStage.value = 'coreS3-sign'
      lastFailureStatus.value = null
      const wrapper = await mountSuspended(DeviceUnregisteredBanner)
      const diag = wrapper.find('[data-testid="device-unregistered-diagnostics"]')
      expect(diag.text()).toBe('ログイン: あり / 端末の有効化: あり / 端末の署名: 失敗 (CoreS3 の署名)')
      wrapper.unmount()
    })
  })
})
