import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, readonly } from 'vue'
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

// 端末へ送った `OMRON BP ON|OFF` をそのまま肯定で返す firmware の既定応答
const echoOmron = async (line: string) => `OK OMRON BP=${line === 'OMRON BP ON' ? '1' : '0'}`

const coreS3Connected = ref(false)
const startupProbeMock = vi.fn(async () => false)
const coreS3RequestMock = vi.fn(async (line: string, _matchPrefix: string, _timeoutMs: number) => echoOmron(line))
mockNuxtImport('useCoreS3Serial', () => () => ({
  isConnected: coreS3Connected,
  startupProbe: startupProbeMock,
  request: coreS3RequestMock,
}))

// 警告デバイス (Atom VoiceS3R)。血圧計の設定は CoreS3 と同じ 1 行の口で撃つ
const alarmConnected = ref(false)
const alarmRequestMock = vi.fn(async (line: string, _matchPrefix: string, _timeoutMs: number) => echoOmron(line))
mockNuxtImport('useAlarmDevice', () => () => ({
  isConnected: alarmConnected,
  request: alarmRequestMock,
}))

// 血圧測定台 (Atom S3、claimant 名 `bp-station`、Refs ippoan/alc-app#353)。
// 血圧計の設定は CoreS3 / 警告デバイスと同じ 1 行の口で撃つ
const atomS3Connected = ref(false)
const atomS3RequestMock = vi.fn(async (line: string, _matchPrefix: string, _timeoutMs: number) => echoOmron(line))
mockNuxtImport('useAtomS3Serial', () => () => ({
  isConnected: atomS3Connected,
  request: atomS3RequestMock,
}))

// 端末の名乗り (`DEVICE bp-station`)。測定台かどうかの判定は `useBpStationMode` 1 か所で、
// URL の印と名乗りの OR (Refs ippoan/alc-app#368)
const arbitratedDeviceKind = ref<'bp-station' | 'other' | null>(null)
mockNuxtImport('useSerialArbiter', () => () => ({
  arbitratedDeviceKind: readonly(arbitratedDeviceKind),
}))

// 血圧計を使うかの表示は useBloodPressureSetting の 1 系統 (Refs ippoan/alc-app-s3#135)
const bpEnabled = ref(false)
const setBpEnabledMock = vi.fn((v: boolean) => { bpEnabled.value = v })
mockNuxtImport('useBloodPressureSetting', () => () => ({
  bpEnabled: readonly(bpEnabled),
  setBpEnabled: setBpEnabledMock,
}))

// 端末設定 (サーバ) — 血圧計を使うかの正本は `devices.bp_enabled`
const api = vi.hoisted(() => ({
  getDeviceSettings: vi.fn(),
  updateDeviceCallSettings: vi.fn(),
}))
vi.mock('~/utils/api', async original => ({
  ...(await original() as object),
  getDeviceSettings: api.getDeviceSettings,
  updateDeviceCallSettings: api.updateDeviceCallSettings,
}))
const deviceSettingsResponse = (bp: boolean) => ({
  call_enabled: true,
  call_schedule: null,
  status: 'approved',
  always_on: false,
  bp_enabled: bp,
})

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

// 登録済みのシリアルポート。既定は空 (= navigator.serial が無い test 環境の実装と同じ)。
// BLE ゲートウェイのポート行・接続テストは、ポートが 1 つ以上あるときしか描画されない
const serialPorts = ref<{ port: object, info: { usbVendorId?: number, usbProductId?: number } }[]>([])
/** WebSerial 対応か。既定は非対応 (test 環境の実装と同じ)。BLE ゲートウェイのカードは対応時だけ描画される */
const serialSupport = { supported: false }
mockNuxtImport('useSerialDeviceManager', () => () => ({
  ports: readonly(serialPorts),
  isSupported: serialSupport.supported,
  refreshPorts: vi.fn(async () => {}),
  requestNewPort: vi.fn(async () => null),
  forgetPort: vi.fn(async () => {}),
}))
/** ESP32-S3 native USB (CoreS3 も Atom S3 も同じ VID/PID で、USB 記述子では見分けられない) */
const ESP32_S3_PORT = { port: {}, info: { usbVendorId: 0x303a, usbProductId: 0x1001 } }

// mountSuspended は自動で unmount しないので、前のテストの watch (CoreS3 の接続) が残らないよう畳む
const mountedWrappers: { unmount: () => void }[] = []
afterEach(() => {
  mountedWrappers.splice(0).forEach(w => w.unmount())
})

async function mountDeviceSettings(route?: string) {
  const wrapper = await mountSuspended(DeviceSettings, {
    ...(route ? { route } : {}),
    global: { stubs: { GwStatusCard: true } },
  })
  mountedWrappers.push(wrapper)
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
    coreS3RequestMock.mockReset()
    coreS3RequestMock.mockImplementation(async line => echoOmron(line))
    alarmConnected.value = false
    alarmRequestMock.mockReset()
    alarmRequestMock.mockImplementation(async line => echoOmron(line))
    atomS3Connected.value = false
    arbitratedDeviceKind.value = null
    serialPorts.value = []
    serialSupport.supported = false
    atomS3RequestMock.mockReset()
    atomS3RequestMock.mockImplementation(async line => echoOmron(line))
    bpEnabled.value = false
    setBpEnabledMock.mockClear()
    api.getDeviceSettings.mockReset()
    api.getDeviceSettings.mockResolvedValue(deviceSettingsResponse(false))
    api.updateDeviceCallSettings.mockReset()
    api.updateDeviceCallSettings.mockResolvedValue(undefined)
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

  describe('Omron 血圧計を使うかの設定 (Refs ippoan/alc-app-s3#135)', () => {
    const checkbox = (wrapper: Awaited<ReturnType<typeof mountDeviceSettings>>) =>
      wrapper.find<HTMLInputElement>('[data-testid="omron-bp-checkbox"]')
    const settle = async (wrapper: Awaited<ReturnType<typeof mountDeviceSettings>>) => {
      await flush()
      await wrapper.vm.$nextTick()
    }

    it('端末が繋がっていなくても血圧計の設定を保存できる', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = false
      alarmConnected.value = false
      const wrapper = await mountDeviceSettings()

      // 端末の有無に関わらずチェックボックスは出る (次に繋がったときに効く)
      expect(checkbox(wrapper).exists()).toBe(true)

      await checkbox(wrapper).setValue(true)
      await settle(wrapper)

      // サーバへの保存が正。always_on は触らないので送らない (backend の COALESCE で保たれる)
      expect(api.updateDeviceCallSettings).toHaveBeenCalledWith('device-1', true, null, undefined, true)
      expect(checkbox(wrapper).element.checked).toBe(true)
      // 端末が 1 台も繋がっていないので送信はしない
      expect(coreS3RequestMock).not.toHaveBeenCalled()
      expect(alarmRequestMock).not.toHaveBeenCalled()
      expect(wrapper.find('[data-testid="omron-bp-error"]').exists()).toBe(false)
    })

    it('CoreS3 が繋がっていれば端末にも送る', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = true
      const wrapper = await mountDeviceSettings()

      await checkbox(wrapper).setValue(true)
      await settle(wrapper)

      expect(api.updateDeviceCallSettings).toHaveBeenCalledWith('device-1', true, null, undefined, true)
      expect(coreS3RequestMock).toHaveBeenLastCalledWith('OMRON BP ON', 'OK OMRON BP=', 3000)
      expect(alarmRequestMock).not.toHaveBeenCalled()
      expect(checkbox(wrapper).element.checked).toBe(true)
    })

    it('VoiceS3R が繋がっていれば端末にも送る', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = false
      alarmConnected.value = true
      const wrapper = await mountDeviceSettings()

      await checkbox(wrapper).setValue(true)
      await settle(wrapper)

      expect(api.updateDeviceCallSettings).toHaveBeenCalledWith('device-1', true, null, undefined, true)
      expect(alarmRequestMock).toHaveBeenLastCalledWith('OMRON BP ON', 'OK OMRON BP=', 3000)
      expect(coreS3RequestMock).not.toHaveBeenCalled()
    })

    it('VoiceS3R のときは再起動が要る旨を出す', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = false
      alarmConnected.value = true
      const wrapper = await mountDeviceSettings()

      await checkbox(wrapper).setValue(true)
      await settle(wrapper)

      expect(wrapper.find('[data-testid="omron-bp-restart-notice"]').text())
        .toBe('設定を変えました。VoiceS3R は再起動すると有効になります')
    })

    it('CoreS3 のときは再起動の案内を出さない (再起動は要らない)', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = true
      const wrapper = await mountDeviceSettings()

      await checkbox(wrapper).setValue(true)
      await settle(wrapper)

      expect(wrapper.find('[data-testid="omron-bp-restart-notice"]').exists()).toBe(false)
    })

    it('測定台 (Atom S3) が繋がっていれば端末にも送る (CoreS3・警告デバイスは挿さっていない、Refs #353)', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = false
      alarmConnected.value = false
      atomS3Connected.value = true
      const wrapper = await mountDeviceSettings()

      await checkbox(wrapper).setValue(true)
      await settle(wrapper)

      expect(api.updateDeviceCallSettings).toHaveBeenCalledWith('device-1', true, null, undefined, true)
      expect(atomS3RequestMock).toHaveBeenLastCalledWith('OMRON BP ON', 'OK OMRON BP=', 3000)
      expect(coreS3RequestMock).not.toHaveBeenCalled()
      expect(alarmRequestMock).not.toHaveBeenCalled()
    })

    it('測定台のときも再起動が要る旨を出す (警告デバイスと同じ Atom S3 系ファーム)', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = false
      alarmConnected.value = false
      atomS3Connected.value = true
      const wrapper = await mountDeviceSettings()

      await checkbox(wrapper).setValue(true)
      await settle(wrapper)

      expect(wrapper.find('[data-testid="omron-bp-restart-notice"]').text())
        .toBe('設定を変えました。VoiceS3R は再起動すると有効になります')
    })

    it('(受け口) サーバの設定が血圧の表示に反映される', async () => {
      activatedDeviceId.value = 'device-1'
      api.getDeviceSettings.mockResolvedValue(deviceSettingsResponse(true))
      const wrapper = await mountDeviceSettings()

      // 画面側 (点呼・BLE・手入力) はこの 1 系統だけを見るので、受け口を呼べていれば足りる
      expect(setBpEnabledMock).toHaveBeenCalledWith(true)
      expect(checkbox(wrapper).element.checked).toBe(true)
    })

    it('端末が繋がったら、サーバの設定に合わせて送る', async () => {
      activatedDeviceId.value = 'device-1'
      api.getDeviceSettings.mockResolvedValue(deviceSettingsResponse(true))
      coreS3Connected.value = false
      const wrapper = await mountDeviceSettings()
      expect(coreS3RequestMock).not.toHaveBeenCalled()

      coreS3Connected.value = true
      await settle(wrapper)

      expect(coreS3RequestMock).toHaveBeenLastCalledWith('OMRON BP ON', 'OK OMRON BP=', 3000)
    })

    it('サーバへの保存に失敗したら元に戻して案内を出す', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = true
      api.updateDeviceCallSettings.mockRejectedValue(new Error('HTTP 500'))
      const wrapper = await mountDeviceSettings()

      await checkbox(wrapper).setValue(true)
      await settle(wrapper)

      expect(checkbox(wrapper).element.checked).toBe(false)
      expect(setBpEnabledMock).not.toHaveBeenCalledWith(true)
      expect(wrapper.find('[data-testid="omron-bp-error"]').text())
        .toBe('設定を保存できませんでした (通信を確認してください)')
    })

    it('端末への送信に失敗してもサーバの値は変えず、端末側の案内だけ出す', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = true
      const wrapper = await mountDeviceSettings()
      coreS3RequestMock.mockRejectedValueOnce(new Error('request(CoreS3): timeout waiting for "OK OMRON BP="'))

      await checkbox(wrapper).setValue(true)
      await settle(wrapper)

      expect(api.updateDeviceCallSettings).toHaveBeenCalledWith('device-1', true, null, undefined, true)
      expect(checkbox(wrapper).element.checked).toBe(true)
      expect(wrapper.find('[data-testid="omron-bp-device-error"]').text())
        .toBe('端末に設定を送れませんでした (firmware が古い可能性があります)')
    })

    it('端末の応答が要求と食い違えば端末側の案内を出す', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = true
      const wrapper = await mountDeviceSettings()
      coreS3RequestMock.mockResolvedValueOnce('OK OMRON BP=0')

      await checkbox(wrapper).setValue(true)
      await settle(wrapper)

      expect(checkbox(wrapper).element.checked).toBe(true)
      expect(wrapper.find('[data-testid="omron-bp-device-error"]').exists()).toBe(true)
    })

    it('他の応答待ち (AUTH SIGN 等) と重なって「既に応答待ちです」なら、間を置いて呼び直す', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = true
      vi.useFakeTimers()
      try {
        coreS3RequestMock
          .mockRejectedValueOnce(new Error('request(CoreS3): 既に応答待ちです'))
          .mockImplementationOnce(async line => echoOmron(line))
        const wrapper = await mountSuspended(DeviceSettings, { global: { stubs: { GwStatusCard: true } } })
        mountedWrappers.push(wrapper)
        await vi.advanceTimersByTimeAsync(0)
        expect(coreS3RequestMock).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(300)
        await wrapper.vm.$nextTick()
        expect(coreS3RequestMock).toHaveBeenCalledTimes(2)
        expect(coreS3RequestMock).toHaveBeenLastCalledWith('OMRON BP OFF', 'OK OMRON BP=', 3000)
        expect(wrapper.find('[data-testid="omron-bp-device-error"]').exists()).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('「既に応答待ちです」の再試行中に unmount されたら呼び直さない', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = true
      coreS3RequestMock.mockRejectedValue(new Error('request(CoreS3): 既に応答待ちです'))
      vi.useFakeTimers()
      try {
        const wrapper = await mountSuspended(DeviceSettings, { global: { stubs: { GwStatusCard: true } } })
        await vi.advanceTimersByTimeAsync(0)
        const calls = coreS3RequestMock.mock.calls.length
        wrapper.unmount()
        await vi.advanceTimersByTimeAsync(3000)
        expect(coreS3RequestMock.mock.calls.length).toBe(calls)
      } finally {
        vi.useRealTimers()
      }
    })

    it('「既に応答待ちです」でも切断されていれば呼び直さない', async () => {
      activatedDeviceId.value = 'device-1'
      coreS3Connected.value = true
      coreS3RequestMock.mockImplementationOnce(async () => {
        coreS3Connected.value = false
        throw new Error('request(CoreS3): 既に応答待ちです')
      })
      const wrapper = await mountDeviceSettings()
      await new Promise(resolve => setTimeout(resolve, 400))
      await settle(wrapper)
      expect(coreS3RequestMock).toHaveBeenCalledTimes(1)
    })
  })

  // CoreS3 と Atom S3 は USB の見た目が同一で、BLE ゲートウェイのカードは両方を受け持つ。
  // 測定台 (Atom S3 しか挿さらない) で「CoreS3 が…」と出さない (Refs ippoan/alc-app#353)
  describe('BLE ゲートウェイのカード — 名指しする端末を測定台で出し分ける (Refs #353)', () => {
    const STATION_ROUTE = '/?role=driver&tab=bp&station=bp'
    const findButton = (wrapper: Awaited<ReturnType<typeof mountDeviceSettings>>, text: string) =>
      wrapper.findAll('button').find(b => b.text() === text)

    it('CoreS3 キオスク: 見出し・ポート行・接続失敗の案内は従来どおり CoreS3 を名指しする', async () => {
      serialSupport.supported = true
      serialPorts.value = [ESP32_S3_PORT]
      const wrapper = await mountDeviceSettings()
      expect(wrapper.text()).toContain('BLE 体温計・血圧計 (CoreS3)')
      expect(wrapper.text()).toContain('ESP32-S3 (CoreS3 など)')

      await findButton(wrapper, '接続テスト')!.trigger('click')
      await flush()
      await wrapper.vm.$nextTick()
      expect(wrapper.text()).toContain('接続失敗 — CoreS3 が USB に接続されているか確認してください')
      expect(wrapper.text()).not.toContain('ATOM S3')
    })

    it('測定台: 見出し・ポート行・接続失敗の案内は ATOM S3 を名指しし、CoreS3 は出ない', async () => {
      serialSupport.supported = true
      serialPorts.value = [ESP32_S3_PORT]
      const wrapper = await mountDeviceSettings(STATION_ROUTE)
      expect(wrapper.text()).toContain('BLE 体温計・血圧計 (ATOM S3)')
      expect(wrapper.text()).toContain('ESP32-S3 (ATOM S3 など)')

      await findButton(wrapper, '接続テスト')!.trigger('click')
      await flush()
      await wrapper.vm.$nextTick()
      expect(wrapper.text()).toContain('接続失敗 — ATOM S3 が USB に接続されているか確認してください')
      expect(wrapper.text()).not.toContain('CoreS3')
    })

    // 測定台かどうかは URL だけでなく端末の名乗りでも決まる (Refs ippoan/alc-app#368)。
    // 見出しとポート行は接続状態に関係なく常に出るので、ここが誤表示の本命
    it('(a) URL に station=bp が無くても、端末が bp-station と名乗れば ATOM S3 を名指しする', async () => {
      arbitratedDeviceKind.value = 'bp-station'
      serialSupport.supported = true
      serialPorts.value = [ESP32_S3_PORT]
      const wrapper = await mountDeviceSettings()
      expect(wrapper.text()).toContain('BLE 体温計・血圧計 (ATOM S3)')
      expect(wrapper.text()).toContain('ESP32-S3 (ATOM S3 など)')

      await findButton(wrapper, '接続テスト')!.trigger('click')
      await flush()
      await wrapper.vm.$nextTick()
      // script 内の参照 (`.value` 忘れだと [object Object] になる)
      expect(wrapper.text()).toContain('接続失敗 — ATOM S3 が USB に接続されているか確認してください')
      expect(wrapper.text()).not.toContain('CoreS3')
      expect(wrapper.text()).not.toContain('[object Object]')
    })

    it('(b) URL に station=bp が無く、名乗りが未決着 (null) なら CoreS3 のまま', async () => {
      arbitratedDeviceKind.value = null
      serialSupport.supported = true
      serialPorts.value = [ESP32_S3_PORT]
      const wrapper = await mountDeviceSettings()
      expect(wrapper.text()).toContain('BLE 体温計・血圧計 (CoreS3)')
      expect(wrapper.text()).toContain('ESP32-S3 (CoreS3 など)')
      expect(wrapper.text()).not.toContain('ATOM S3')
    })

    it('(c) URL に station=bp があれば、名乗りが未決着でも従来どおり ATOM S3 を名指しする', async () => {
      arbitratedDeviceKind.value = null
      serialSupport.supported = true
      serialPorts.value = [ESP32_S3_PORT]
      const wrapper = await mountDeviceSettings(STATION_ROUTE)
      expect(wrapper.text()).toContain('BLE 体温計・血圧計 (ATOM S3)')
      expect(wrapper.text()).toContain('ESP32-S3 (ATOM S3 など)')
      expect(wrapper.text()).not.toContain('CoreS3')
    })

    it.each([
      ['CoreS3 キオスク', undefined],
      ['測定台', STATION_ROUTE],
    ])('%s: Omron 血圧計のチェックボックスは機種を 1 つに絞らない (HEM-6231T / HCR-1901T2 の両方が対象)', async (_name, route) => {
      const wrapper = await mountDeviceSettings(route)
      const label = wrapper.find('[data-testid="omron-bp-checkbox"]').element.closest('label')!
      expect(label.textContent).toContain('この端末で Omron 血圧計を使う')
      expect(label.textContent).not.toContain('HEM-6231T')
    })
  })
})
