import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import DeviceUnregisteredBanner from '~/components/DeviceUnregisteredBanner.vue'
import { deviceUnregisteredMessage } from '~/utils/employee-lookup-messages'

// 「未登録」の判定は useKioskAccess に一本化した (Refs #234, #238)。この banner は
// hasKioskAccess / isCheckingKioskAccess / reasons を見る。
// #135: 診断行のため useDeviceToken の lastFailureStage / lastFailureStatus もモックする。
// #135 続報: 案内の出し分けのため lastFailureDetail / coreS3BackoffUntil もモックする。
const hasKioskAccess = ref(false)
const isCheckingKioskAccess = ref(false)
const reasons = ref({ isAuthenticated: false, isDeviceActivated: false, hasDeviceJwt: false })
const lastFailureStage = ref<'no-core-s3' | 'nonce' | 'coreS3-sign' | 'token-exchange' | null>(null)
const lastFailureStatus = ref<number | null>(null)
const lastFailureDetail = ref<string | null>(null)
const coreS3BackoffUntil = ref(0)

mockNuxtImport('useKioskAccess', () => () => ({ hasKioskAccess, isCheckingKioskAccess, reasons }))
mockNuxtImport('useDeviceToken', () => () => ({
  lastFailureStage,
  lastFailureStatus,
  lastFailureDetail,
  coreS3BackoffUntil,
}))

describe('DeviceUnregisteredBanner', () => {
  beforeEach(() => {
    hasKioskAccess.value = false
    isCheckingKioskAccess.value = false
    reasons.value = { isAuthenticated: false, isDeviceActivated: false, hasDeviceJwt: false }
    lastFailureStage.value = null
    lastFailureStatus.value = null
    lastFailureDetail.value = null
    coreS3BackoffUntil.value = 0
  })

  it('hasKioskAccess が false なら赤枠で原因と次の操作を出す', async () => {
    const wrapper = await mountSuspended(DeviceUnregisteredBanner)

    const banner = wrapper.find('[data-testid="device-unregistered-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain(deviceUnregisteredMessage)
    expect(banner.text()).toContain('CoreS3 を USB でつないでください')
    expect(wrapper.find('.border-red-200').exists()).toBe(true)
    wrapper.unmount()
  })

  // 案内の出し分け (Refs ippoan/alc-app-s3#135 続報)
  describe('原因ごとの案内', () => {
    it('CoreS3 が見えないときは USB の案内を出す', async () => {
      lastFailureStage.value = 'no-core-s3'
      const wrapper = await mountSuspended(DeviceUnregisteredBanner)
      const guidance = wrapper.find('[data-testid="device-unregistered-guidance"]')
      expect(guidance.text()).toContain('CoreS3 を USB でつないでください')
      expect(guidance.text()).toContain('CoreS3 を USB で許可')
      wrapper.unmount()
    })

    it('鍵が無いときは鍵の登録を案内する', async () => {
      lastFailureStage.value = 'coreS3-sign'
      lastFailureDetail.value = 'no key'
      const wrapper = await mountSuspended(DeviceUnregisteredBanner)
      const guidance = wrapper.find('[data-testid="device-unregistered-guidance"]')
      expect(guidance.text()).toContain('この端末には鍵が登録されていません')
      expect(guidance.text()).toContain('管理者が登録画面で鍵を登録してください')
      wrapper.unmount()
    })

    it('署名がその他の理由 (no key 以外) で失敗したときは USB 挿し直し・再起動を案内する', async () => {
      lastFailureStage.value = 'coreS3-sign'
      lastFailureDetail.value = 'bad nonce'
      const wrapper = await mountSuspended(DeviceUnregisteredBanner)
      const guidance = wrapper.find('[data-testid="device-unregistered-guidance"]')
      expect(guidance.text()).toContain('端末が署名に応じません')
      expect(guidance.text()).not.toContain('鍵が登録されていません')
      wrapper.unmount()
    })

    it('nonce の取得に失敗したときはネットワークを案内する', async () => {
      lastFailureStage.value = 'nonce'
      const wrapper = await mountSuspended(DeviceUnregisteredBanner)
      const guidance = wrapper.find('[data-testid="device-unregistered-guidance"]')
      expect(guidance.text()).toContain('サーバに繋がりません')
      wrapper.unmount()
    })

    it('トークンの交換に失敗したときは鍵の登録し直しを案内する', async () => {
      lastFailureStage.value = 'token-exchange'
      lastFailureStatus.value = 401
      const wrapper = await mountSuspended(DeviceUnregisteredBanner)
      const guidance = wrapper.find('[data-testid="device-unregistered-guidance"]')
      expect(guidance.text()).toContain('鍵を登録し直してください')
      wrapper.unmount()
    })

    it('待ちの最中も直前の原因の案内が消えない (残り秒を添えるだけ)', async () => {
      lastFailureStage.value = 'nonce'
      lastFailureDetail.value = null
      coreS3BackoffUntil.value = Date.now() + 30_000
      const wrapper = await mountSuspended(DeviceUnregisteredBanner)
      const guidance = wrapper.find('[data-testid="device-unregistered-guidance"]')
      expect(guidance.text()).toContain('サーバに繋がりません')
      expect(guidance.text()).toMatch(/あと \d+ 秒で再試行します/)
      wrapper.unmount()
    })

    it('抑止期限が過ぎていれば残り秒を添えない', async () => {
      lastFailureStage.value = 'token-exchange'
      coreS3BackoffUntil.value = Date.now() - 1_000
      const wrapper = await mountSuspended(DeviceUnregisteredBanner)
      const guidance = wrapper.find('[data-testid="device-unregistered-guidance"]')
      expect(guidance.text()).not.toContain('再試行します')
      wrapper.unmount()
    })
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
