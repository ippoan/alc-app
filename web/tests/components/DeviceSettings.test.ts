import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import DeviceSettings from '~/components/DeviceSettings.vue'

/** onMounted の await 群 (startupProbe 待ち) を流し切る */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

// --- composable のモック ---
// CoreS3 で動く運行者 PC (資格情報を保存しない設計、Refs #238) を再現するのに
// 要る変数だけモックし、それ以外 (useSerialDeviceManager / useFingerprint /
// useAlarmDeviceSetting) は navigator.serial / window.Android が無い test 環境の
// 実装のまま動かして問題ない。

const deviceTenantId = ref<string | null>(null)
const activatedDeviceId = ref<string | null>(null)
const deviceSettingsToken = ref<string | null>(null)
const reAuthenticateDeviceMock = vi.fn(async () => true)
mockNuxtImport('useAuth', () => () => ({
  deactivateDevice: vi.fn(),
  deviceTenantId,
  deviceId: activatedDeviceId,
  deviceSettingsToken,
  reAuthenticateDevice: reAuthenticateDeviceMock,
}))

const hasKioskCredential = ref(false)
const hasDeviceJwt = ref(false)
mockNuxtImport('useDeviceToken', () => () => ({
  hasKioskCredential,
  hasDeviceJwt,
}))

const coreS3Connected = ref(false)
const startupProbeMock = vi.fn(async () => false)
mockNuxtImport('useCoreS3Serial', () => () => ({
  isConnected: coreS3Connected,
  startupProbe: startupProbeMock,
}))

mockNuxtImport('useFc1200Serial', () => () => ({
  isConnected: ref(false),
  state: ref('idle'),
  result: ref(null),
  error: ref(null),
  transport: ref(null),
  autoConnect: vi.fn(async () => false),
  disconnect: vi.fn(async () => {}),
  updateDeviceDate: vi.fn(),
  startMeasurement: vi.fn(async () => {}),
}))

mockNuxtImport('useBleGateway', () => () => ({
  isConnected: ref(false),
  autoConnect: vi.fn(async () => false),
  bloodPressureConnected: ref(false),
  thermometerConnected: ref(false),
  gatewayVersion: ref(null),
}))

async function mountDeviceSettings() {
  const wrapper = await mountSuspended(DeviceSettings, {
    global: { stubs: { GwStatusCard: true } },
  })
  await flush()
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('DeviceSettings — CoreS3 で動く端末に合わせた表示 (Refs #238)', () => {
  beforeEach(() => {
    deviceTenantId.value = null
    activatedDeviceId.value = null
    deviceSettingsToken.value = null
    hasKioskCredential.value = false
    hasDeviceJwt.value = false
    coreS3Connected.value = false
    reAuthenticateDeviceMock.mockClear()
    reAuthenticateDeviceMock.mockResolvedValue(true)
    startupProbeMock.mockClear()
  })

  describe('状態: の表示', () => {
    it('hasDeviceJwt (CoreS3 の短命 JWT で動作中) なら deviceTenantId に関わらず「CoreS3 で動作中」と出す', async () => {
      hasDeviceJwt.value = true
      deviceTenantId.value = null
      const wrapper = await mountDeviceSettings()
      const status = wrapper.find('[data-testid="device-registration-status"]')
      expect(status.text()).toContain('CoreS3 で動作中 (端末登録は不要)')
      expect(status.text()).not.toContain('未登録')
    })

    it('hasDeviceJwt が無ければ従来どおり deviceTenantId で「登録済み / 未登録」を出す', async () => {
      hasDeviceJwt.value = false
      deviceTenantId.value = null
      let wrapper = await mountDeviceSettings()
      expect(wrapper.find('[data-testid="device-registration-status"]').text()).toContain('未登録')

      deviceTenantId.value = 'tenant-1'
      wrapper = await mountDeviceSettings()
      expect(wrapper.find('[data-testid="device-registration-status"]').text()).toContain('登録済み')
    })
  })

  describe('起動時の自動 reAuthenticate() 抑止', () => {
    it('CoreS3 が接続中 (isConnected) なら、credential が無くても自動では呼ばない', async () => {
      hasKioskCredential.value = false
      coreS3Connected.value = true
      await mountDeviceSettings()
      expect(startupProbeMock).toHaveBeenCalled()
      expect(reAuthenticateDeviceMock).not.toHaveBeenCalled()
    })

    it('端末 JWT がある (hasDeviceJwt) なら、credential が無くても自動では呼ばない', async () => {
      hasKioskCredential.value = false
      hasDeviceJwt.value = true
      await mountDeviceSettings()
      expect(reAuthenticateDeviceMock).not.toHaveBeenCalled()
    })

    it('CoreS3 が無く credential も無ければ、従来どおり起動時に自動で 1 回呼ぶ', async () => {
      hasKioskCredential.value = false
      coreS3Connected.value = false
      hasDeviceJwt.value = false
      await mountDeviceSettings()
      expect(reAuthenticateDeviceMock).toHaveBeenCalledTimes(1)
    })

    it('credential を既に持っていれば、CoreS3 の有無に関わらず自動では呼ばない', async () => {
      hasKioskCredential.value = true
      coreS3Connected.value = false
      await mountDeviceSettings()
      expect(reAuthenticateDeviceMock).not.toHaveBeenCalled()
    })
  })

  describe('再認証失敗表示の抑止', () => {
    it('CoreS3 で動作中 (isConnected) なら、手動再認証が失敗しても「⚠ 再認証に失敗しました」を出さない', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = true
      reAuthenticateDeviceMock.mockResolvedValue(false)
      const wrapper = await mountDeviceSettings()

      await wrapper.find('[data-testid="reauth-button"]').trigger('click')
      await flush()
      await wrapper.vm.$nextTick()

      expect(wrapper.find('[data-testid="reauth-result"]').exists()).toBe(false)
      // 欄そのもの・手動ボタン・端末登録をリセットは残る
      expect(wrapper.find('[data-testid="reauth-button"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('端末登録をリセット')
    })

    it('端末 JWT で動作中 (hasDeviceJwt) でも同様に失敗表示を出さない', async () => {
      activatedDeviceId.value = 'device-1'
      hasDeviceJwt.value = true
      reAuthenticateDeviceMock.mockResolvedValue(false)
      const wrapper = await mountDeviceSettings()

      await wrapper.find('[data-testid="reauth-button"]').trigger('click')
      await flush()
      await wrapper.vm.$nextTick()

      expect(wrapper.find('[data-testid="reauth-result"]').exists()).toBe(false)
    })

    it('CoreS3 で動いていなければ、従来どおり失敗表示を出す', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = false
      hasDeviceJwt.value = false
      reAuthenticateDeviceMock.mockResolvedValue(false)
      const wrapper = await mountDeviceSettings()

      await wrapper.find('[data-testid="reauth-button"]').trigger('click')
      await flush()
      await wrapper.vm.$nextTick()

      const result = wrapper.find('[data-testid="reauth-result"]')
      expect(result.exists()).toBe(true)
      expect(result.text()).toContain('⚠ 再認証に失敗しました')
    })

    it('CoreS3 で動いていなければ、成功表示は従来どおり出す', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = false
      hasDeviceJwt.value = false
      reAuthenticateDeviceMock.mockResolvedValue(true)
      const wrapper = await mountDeviceSettings()

      await wrapper.find('[data-testid="reauth-button"]').trigger('click')
      await flush()
      await wrapper.vm.$nextTick()

      const result = wrapper.find('[data-testid="reauth-result"]')
      expect(result.exists()).toBe(true)
      expect(result.text()).toContain('✓ 再認証に成功しました')
    })
  })
})
