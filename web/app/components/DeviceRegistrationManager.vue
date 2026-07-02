<script setup lang="ts">
import QRCode from 'qrcode'
import type { Device, DeviceRegistrationRequest, CallSchedule } from '~/types'
import {
  listDevices, listPendingDeviceRegistrations,
  createDeviceUrlToken, createPermanentQr, createDeviceOwnerToken,
  approveDevice, rejectDevice, disableDevice, enableDevice, deleteDevice,
  updateDeviceCallSettings, testFcmNotification, testFcmAll, triggerUpdate,
} from '~/utils/api'
import type { TestFcmAllResult } from '~/utils/api'

const { user, accessToken } = useAuth()
const isDeveloper = computed(() => user.value?.email === 'm.tama.ramu@gmail.com')
const registrationMode = ref<'dev' | 'owner'>('dev')

// この端末をキオスクにする (#434 P1 / 方式1): ログイン中の access token で
// device-kiosk credential を self-pair し端末に保存する。ログアウト後この端末は
// device 認証 (/api/proxy) で動作し、通常の管理者セッションとは分離される。
const { hasKioskCredential, setupAsKiosk } = useDeviceToken()
const kioskName = ref('')
const kioskSetupBusy = ref(false)
const kioskSetupMsg = ref('')
async function setupThisAsKiosk() {
  const token = accessToken.value
  if (!token) {
    kioskSetupMsg.value = 'ログインが必要です'
    return
  }
  kioskSetupBusy.value = true
  kioskSetupMsg.value = ''
  const ok = await setupAsKiosk(token, kioskName.value.trim() || 'kiosk')
  kioskSetupBusy.value = false
  kioskSetupMsg.value = ok
    ? 'この端末をキオスクに設定しました。ログアウトすると device 認証で動作します。'
    : 'キオスク設定に失敗しました'
}

const devices = ref<Device[]>([])
const pending = ref<DeviceRegistrationRequest[]>([])
const loading = ref(false)
const error = ref('')

// 承認待ち = qr_permanent のみ (url は即承認なので除外)
const pendingForApproval = computed(() =>
  pending.value.filter(r => r.flow_type === 'qr_permanent')
)
// QR一時/URL生成済み未使用トークン
const pendingUrlTokens = computed(() =>
  pending.value.filter(r => r.flow_type === 'url')
)

// URL トークン生成
const urlTokenName = ref('')
const generatedUrl = ref('')
const urlCopied = ref(false)

// QR一時生成
const qrTempName = ref('')
const qrTempCode = ref('')
const qrTempDataUrl = ref('')
const qrTempDeviceName = ref('')

// QR永久生成
const permanentQrName = ref('')
const permanentQrCode = ref('')
const permanentQrDataUrl = ref('')

// Device Owner プロビジョニング
const doDeviceName = ref('')
const doWifiSsid = ref(localStorage.getItem('do_wifi_ssid') || '')
const doWifiPassword = ref(localStorage.getItem('do_wifi_password') || '')
const doWifiSecurity = ref(localStorage.getItem('do_wifi_security') || 'WPA')

watch(doWifiSsid, v => localStorage.setItem('do_wifi_ssid', v))
watch(doWifiPassword, v => localStorage.setItem('do_wifi_password', v))
watch(doWifiSecurity, v => localStorage.setItem('do_wifi_security', v))
const doIncludeApk = ref(true)
const doProvisioningQrDataUrl = ref('')
const doRegistrationCode = ref('')
// APK 署名証明書の SHA-256 (URL-safe base64) — 署名鍵が変わらない限り固定
const APK_SIGNATURE_CHECKSUM = 'K8l47tzAs9fdijA5qdm8o4Duq62WWkGa97sffd3KUZk'
const apkDownloadUrl = 'https://ippoan.github.io/AlcoholChecker/app-release.apk'

// QR 拡大モーダル
const zoomedQrSrc = ref('')

// APK 最新バージョン取得
const latestApkVersion = ref('')
onMounted(async () => {
  try {
    const res = await fetch('https://api.github.com/repos/yhonda-ohishi-alc/AlcoholChecker/releases/latest')
    if (res.ok) {
      const data = await res.json()
      latestApkVersion.value = data.tag_name || data.name || ''
    }
  } catch { /* ignore */ }
})

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const [d, p] = await Promise.all([listDevices(), listPendingDeviceRegistrations()])
    devices.value = d
    pending.value = p
    fetchWatchers()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'データの取得に失敗しました'
  } finally {
    loading.value = false
  }
}

function deviceFlags() {
  if (!isDeveloper.value) return { is_device_owner: true }
  return registrationMode.value === 'dev' ? { is_dev_device: true } : { is_device_owner: true }
}

async function handleCreateUrlToken() {
  try {
    const res = await createDeviceUrlToken(urlTokenName.value || undefined, deviceFlags())
    generatedUrl.value = `${window.location.origin}${res.registration_url}`
    urlTokenName.value = ''
    urlCopied.value = false
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'トークン生成に失敗しました'
  }
}

async function copyUrl() {
  await navigator.clipboard.writeText(generatedUrl.value)
  urlCopied.value = true
  setTimeout(() => { urlCopied.value = false }, 2000)
}

async function handleCreateQrTemp() {
  try {
    const res = await createDeviceUrlToken(qrTempName.value || undefined, deviceFlags())
    qrTempCode.value = res.registration_code
    qrTempDeviceName.value = qrTempName.value || ''
    const claimUrl = `${window.location.origin}${res.registration_url}`
    qrTempDataUrl.value = await QRCode.toDataURL(claimUrl, { width: 400, margin: 2 })
    qrTempName.value = ''
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'QR生成に失敗しました'
  }
}

async function handleCreatePermanentQr() {
  try {
    const res = await createPermanentQr(permanentQrName.value || undefined, deviceFlags())
    permanentQrCode.value = res.registration_code
    const claimUrl = `${window.location.origin}/device-claim?token=${res.registration_code}`
    permanentQrDataUrl.value = await QRCode.toDataURL(claimUrl, { width: 400, margin: 2 })
    permanentQrName.value = ''
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'QR生成に失敗しました'
  }
}

async function handleCreateDeviceOwnerQr() {
  try {
    const res = await createDeviceOwnerToken(doDeviceName.value || undefined, {
      is_dev_device: isDeveloper.value && registrationMode.value === 'dev',
    })
    doRegistrationCode.value = res.registration_code

    const provisioningJson: Record<string, unknown> = {
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME':
        'com.example.alcoholchecker/com.example.alcoholchecker.admin.AppDeviceAdminReceiver',
      'android.app.extra.PROVISIONING_SKIP_ENCRYPTION': true,
      'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': {
        registration_code: res.registration_code,
        device_name: doDeviceName.value || '',
        is_dev_device: isDeveloper.value && registrationMode.value === 'dev' ? 'true' : 'false',
      },
    }
    // APK ダウンロード + 署名チェックサム (署名鍵が同じなら不変)
    if (doIncludeApk.value) {
      provisioningJson['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION'] = apkDownloadUrl
      provisioningJson['android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM'] = APK_SIGNATURE_CHECKSUM
    }
    // Wi-Fi (オプション)
    if (doWifiSsid.value) {
      provisioningJson['android.app.extra.PROVISIONING_WIFI_SSID'] = doWifiSsid.value
      provisioningJson['android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE'] = doWifiSecurity.value
      if (doWifiPassword.value) {
        provisioningJson['android.app.extra.PROVISIONING_WIFI_PASSWORD'] = doWifiPassword.value
      }
    }

    console.log('[Provisioning QR]', JSON.stringify(provisioningJson, null, 2))
    doProvisioningQrDataUrl.value = await QRCode.toDataURL(JSON.stringify(provisioningJson), { width: 600, margin: 2 })
    doDeviceName.value = ''
    await refresh()
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : 'プロビジョニングQR生成に失敗しました'
  }
}

async function downloadQrPdf() {
  if (!permanentQrCode.value || !permanentQrDataUrl.value) return
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  doc.setFontSize(16)
  doc.text('ALC Device Registration', 105, 30, { align: 'center' })

  doc.addImage(permanentQrDataUrl.value, 'PNG', 55, 50, 100, 100)

  doc.setFontSize(10)
  doc.text(`Code: ${permanentQrCode.value}`, 105, 165, { align: 'center' })

  doc.setFontSize(9)
  doc.text('1. Scan QR or open URL on device', 105, 180, { align: 'center' })
  doc.text('2. Enter device name', 105, 188, { align: 'center' })
  doc.text('3. Wait for admin approval', 105, 196, { align: 'center' })

  doc.save(`device-qr-${permanentQrCode.value.slice(0, 8)}.pdf`)
}

async function handleApprove(id: string) {
  try {
    await approveDevice(id)
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '承認に失敗しました'
  }
}

async function handleReject(id: string) {
  try {
    await rejectDevice(id)
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '拒否に失敗しました'
  }
}

async function handleDisable(id: string) {
  try {
    await disableDevice(id)
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '無効化に失敗しました'
  }
}

async function handleEnable(id: string) {
  try {
    await enableDevice(id)
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '有効化に失敗しました'
  }
}

async function handleDelete(id: string) {
  if (!confirm('このデバイスを削除しますか?')) return
  try {
    await deleteDevice(id)
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '削除に失敗しました'
  }
}

// 生成済みトークンのQR再表示用
const tokenQrUrls = ref<Record<string, string>>({})

async function toggleQr(code: string) {
  if (tokenQrUrls.value[code]) {
    delete tokenQrUrls.value[code]
    tokenQrUrls.value = { ...tokenQrUrls.value }
    return
  }
  const claimUrl = `${window.location.origin}/device-claim?token=${code}`
  tokenQrUrls.value[code] = await QRCode.toDataURL(claimUrl, { width: 400, margin: 2 })
}

// 着信設定
const expandedCallSettings = ref<Set<string>>(new Set())
const editingSchedules = ref<Record<string, CallSchedule>>({})
const signalingUrl = useRuntimeConfig().public.signalingUrl as string || ''
const connectedDeviceIds = ref<Set<string>>(new Set())

async function fetchWatchers() {
  if (!signalingUrl) return
  try {
    const url = signalingUrl.replace(/\/$/, '')
    const res = await fetch(`${url}/watchers`)
    if (res.ok) {
      const data = await res.json() as { count: number; watchers: { deviceId: string }[] }
      connectedDeviceIds.value = new Set(data.watchers.map(w => w.deviceId).filter(id => id !== '(no tag)'))
    }
  } catch { /* ignore */ }
}

const defaultSchedule: CallSchedule = {
  enabled: false,
  startHour: 8,
  startMin: 0,
  endHour: 17,
  endMin: 0,
  days: [1, 2, 3, 4, 5],
}

function toggleCallSettings(dev: Device) {
  const id = dev.id
  if (expandedCallSettings.value.has(id)) {
    expandedCallSettings.value.delete(id)
    expandedCallSettings.value = new Set(expandedCallSettings.value)
  } else {
    editingSchedules.value[id] = dev.call_schedule
      ? { ...dev.call_schedule }
      : { ...defaultSchedule }
    expandedCallSettings.value.add(id)
    expandedCallSettings.value = new Set(expandedCallSettings.value)
  }
}

function updateScheduleForDevice(deviceId: string, schedule: CallSchedule) {
  editingSchedules.value[deviceId] = schedule
}

async function toggleAlwaysOn(dev: Device) {
  const newValue = !dev.always_on
  try {
    await updateDeviceCallSettings(dev.id, dev.call_enabled, dev.call_schedule, newValue)
    await refresh()
  } catch (e) {
    console.error(`[CallSettings] toggleAlwaysOn failed:`, e)
    error.value = e instanceof Error ? e.message : '常時起動設定の更新に失敗しました'
  }
}

async function toggleCallEnabled(dev: Device) {
  const newEnabled = !dev.call_enabled
  console.log(`[CallSettings] toggleCallEnabled device=${dev.id} name=${dev.device_name} ${dev.call_enabled}→${newEnabled} schedule=${dev.call_schedule ? 'set' : 'null'}`)
  try {
    await updateDeviceCallSettings(dev.id, newEnabled, dev.call_schedule)
    if (dev.call_schedule) {
      await syncScheduleToDO(dev.id, { ...dev.call_schedule, enabled: newEnabled })
    } else {
      await deleteScheduleFromDO(dev.id)
    }
    await refresh()
  } catch (e) {
    console.error(`[CallSettings] toggleCallEnabled failed:`, e)
    error.value = e instanceof Error ? e.message : '着信設定の更新に失敗しました'
  }
}

async function saveCallSchedule(dev: Device) {
  const schedule = editingSchedules.value[dev.id]
  if (!schedule) return
  console.log(`[CallSettings] saveSchedule device=${dev.id} name=${dev.device_name}`, JSON.stringify(schedule))
  try {
    await updateDeviceCallSettings(dev.id, dev.call_enabled, schedule)
    await syncScheduleToDO(dev.id, { ...schedule, enabled: dev.call_enabled })
    await refresh()
  } catch (e) {
    console.error(`[CallSettings] saveSchedule failed:`, e)
    error.value = e instanceof Error ? e.message : 'スケジュール保存に失敗しました'
  }
}

async function deleteCallSchedule(dev: Device) {
  console.log(`[CallSettings] deleteSchedule device=${dev.id} name=${dev.device_name}`)
  try {
    await updateDeviceCallSettings(dev.id, dev.call_enabled, null)
    await deleteScheduleFromDO(dev.id)
    delete editingSchedules.value[dev.id]
    expandedCallSettings.value.delete(dev.id)
    expandedCallSettings.value = new Set(expandedCallSettings.value)
    await refresh()
  } catch (e) {
    console.error(`[CallSettings] deleteSchedule failed:`, e)
    error.value = e instanceof Error ? e.message : 'スケジュール削除に失敗しました'
  }
}

// 着信テスト
const testingDevice = ref<string | null>(null)
const testResult = ref<{ deviceId: string; success: boolean; message: string } | null>(null)

// 一斉テスト
const testingAll = ref(false)
const testAllResults = ref<{ device_id: string; sent: boolean; blocked: boolean; reason: string }[]>([])

async function testCallAll() {
  if (!signalingUrl) {
    error.value = 'シグナリングURLが設定されていません'
    return
  }
  testingAll.value = true
  testAllResults.value = []
  try {
    const url = signalingUrl.replace(/\/$/, '')
    const res = await fetch(`${url}/test-call-all`, { method: 'POST' })
    if (res.ok) {
      const data = await res.json() as { ok: boolean; results: typeof testAllResults.value }
      testAllResults.value = data.results
      setTimeout(() => { testAllResults.value = [] }, 5000)
    } else {
      error.value = '一斉テストの送信に失敗しました'
    }
  } catch {
    error.value = '一斉テストの送信に失敗しました'
  } finally {
    testingAll.value = false
  }
}

// 一斉テスト (WebSocket + FCM fallback)
const testingAllWithFcm = ref(false)
const testAllWithFcmResults = ref<{ device_id: string; sent: boolean; blocked: boolean; via: string; reason: string }[]>([])

async function testCallAllWithFcm() {
  if (!signalingUrl) {
    error.value = 'シグナリングURLが設定されていません'
    return
  }
  testingAllWithFcm.value = true
  testAllWithFcmResults.value = []
  try {
    const url = signalingUrl.replace(/\/$/, '')
    const res = await fetch(`${url}/test-call-all-with-fcm`, { method: 'POST' })
    if (res.ok) {
      const data = await res.json() as { ok: boolean; results: typeof testAllWithFcmResults.value }
      testAllWithFcmResults.value = data.results
      setTimeout(() => { testAllWithFcmResults.value = [] }, 8000)
    } else {
      error.value = '一斉テスト(FCM)の送信に失敗しました'
    }
  } catch {
    error.value = '一斉テスト(FCM)の送信に失敗しました'
  } finally {
    testingAllWithFcm.value = false
  }
}

async function testCall(deviceId: string) {
  if (!signalingUrl) {
    error.value = 'シグナリングURLが設定されていません'
    return
  }
  testingDevice.value = deviceId
  testResult.value = null
  try {
    const url = signalingUrl.replace(/\/$/, '')
    const res = await fetch(`${url}/test-call/${deviceId}`, { method: 'POST' })
    if (res.status === 404) {
      testResult.value = { deviceId, success: false, message: 'デバイスが接続されていません' }
    } else if (res.ok) {
      const data = await res.json() as { ok: boolean; sent: number; blocked: boolean; reason: string }
      if (!data.blocked) {
        testResult.value = { deviceId, success: true, message: 'テスト着信を送信しました' }
      } else {
        testResult.value = { deviceId, success: false, message: `ブロックされました: ${data.reason}` }
      }
    } else {
      testResult.value = { deviceId, success: false, message: 'テスト着信の送信に失敗しました' }
    }
  } catch {
    testResult.value = { deviceId, success: false, message: 'テスト着信の送信に失敗しました' }
  } finally {
    testingDevice.value = null
    setTimeout(() => { testResult.value = null }, 3000)
  }
}

// FCM テスト
const fcmTestingDevice = ref<string | null>(null)
const fcmTestResult = ref<{ deviceId: string; success: boolean; message: string } | null>(null)

async function testFcm(deviceId: string) {
  fcmTestingDevice.value = deviceId
  fcmTestResult.value = null
  try {
    const res = await testFcmNotification(deviceId)
    if (res.success) {
      fcmTestResult.value = { deviceId, success: true, message: 'FCM テスト送信しました' }
    } else {
      fcmTestResult.value = { deviceId, success: false, message: res.error || 'FCM 送信に失敗しました' }
    }
  } catch {
    fcmTestResult.value = { deviceId, success: false, message: 'FCM 送信に失敗しました' }
  } finally {
    fcmTestingDevice.value = null
    setTimeout(() => { fcmTestResult.value = null }, 3000)
  }
}

// FCM 一括テスト
const fcmTestingAll = ref(false)
const fcmTestAllResults = ref<TestFcmAllResult[]>([])

async function testFcmCallAll() {
  fcmTestingAll.value = true
  fcmTestAllResults.value = []
  try {
    const res = await testFcmAll()
    fcmTestAllResults.value = res.results
    setTimeout(() => { fcmTestAllResults.value = [] }, 5000)
  } catch {
    error.value = 'FCM一括テストの送信に失敗しました'
  } finally {
    fcmTestingAll.value = false
  }
}

// OTA 一括アップデート
const otaUpdating = ref(false)
const otaUpdateResults = ref<TestFcmAllResult[]>([])

async function triggerOtaUpdate() {
  otaUpdating.value = true
  otaUpdateResults.value = []
  try {
    const res = await triggerUpdate()
    otaUpdateResults.value = res.results
    setTimeout(() => { otaUpdateResults.value = [] }, 8000)
  } catch {
    error.value = 'OTAアップデートの送信に失敗しました'
  } finally {
    otaUpdating.value = false
  }
}

// 個別デバイス OTA アップデート
const otaUpdatingDevice = ref<string | null>(null)
const otaDeviceResult = ref<{ deviceId: string; success: boolean; message: string } | null>(null)

async function triggerDeviceUpdate(deviceId: string) {
  otaUpdatingDevice.value = deviceId
  otaDeviceResult.value = null
  try {
    const res = await triggerUpdate({ device_ids: [deviceId] })
    const r = res.results[0]
    if (r) {
      otaDeviceResult.value = {
        deviceId,
        success: r.success,
        message: r.success ? (r.error === 'already up-to-date' ? '最新版です' : '送信済') : (r.error || '失敗'),
      }
    }
    setTimeout(() => { otaDeviceResult.value = null }, 5000)
  } catch {
    otaDeviceResult.value = { deviceId, success: false, message: '送信に失敗しました' }
  } finally {
    otaUpdatingDevice.value = null
  }
}

// 更新用 QR コード
const updateQrDataUrl = ref('')
const apkLatestUrl = 'https://github.com/ippoan/AlcoholChecker/releases/latest/download/app-release.apk'

async function showUpdateQr() {
  if (updateQrDataUrl.value) {
    updateQrDataUrl.value = ''
    return
  }
  updateQrDataUrl.value = await QRCode.toDataURL(apkLatestUrl, { width: 400, margin: 2 })
}

// アプリダウンロード QR (新規インストール用、常設表示)
const appDownloadQrDataUrl = ref('')
onMounted(async () => {
  appDownloadQrDataUrl.value = await QRCode.toDataURL(apkDownloadUrl, { width: 300, margin: 2 })
})

async function syncScheduleToDO(deviceId: string, schedule: CallSchedule) {
  if (!signalingUrl) return
  try {
    const url = signalingUrl.replace(/\/$/, '')
    const res = await fetch(`${url}/device-schedule/${deviceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(schedule),
    })
    console.log(`[CallSettings] syncToDO device=${deviceId} status=${res.status}`, JSON.stringify(schedule))
  } catch (e) {
    console.error(`[CallSettings] syncToDO failed device=${deviceId}:`, e)
  }
}

async function deleteScheduleFromDO(deviceId: string) {
  if (!signalingUrl) return
  try {
    const url = signalingUrl.replace(/\/$/, '')
    const res = await fetch(`${url}/device-schedule/${deviceId}`, { method: 'DELETE' })
    console.log(`[CallSettings] deleteFromDO device=${deviceId} status=${res.status}`)
  } catch (e) {
    console.error(`[CallSettings] deleteFromDO failed device=${deviceId}:`, e)
  }
}

onMounted(() => refresh())
</script>

<template>
  <div class="space-y-6">
    <p v-if="error" class="text-red-600 text-sm">{{ error }}</p>

    <!-- Android アプリのダウンロード -->
    <div class="bg-white rounded-xl shadow-sm p-4">
      <h3 class="text-sm font-medium text-gray-800 mb-2">Android アプリのダウンロード</h3>
      <p class="text-xs text-gray-500 mb-3">端末カメラでQRを読み込むとAPKの直接ダウンロードが始まります (「提供元不明のアプリ」を許可してインストール)。</p>
      <div v-if="appDownloadQrDataUrl" class="text-center space-y-2">
        <img
          :src="appDownloadQrDataUrl"
          alt="Androidアプリダウンロード用QR"
          class="mx-auto cursor-pointer w-[180px]"
          @click="zoomedQrSrc = appDownloadQrDataUrl"
        />
        <p v-if="latestApkVersion" class="text-xs text-gray-500">最新バージョン: {{ latestApkVersion }}</p>
        <p class="text-[10px] text-gray-400 break-all">{{ apkDownloadUrl }}</p>
      </div>
    </div>

    <!-- この端末をキオスクにする (#434 P1 / 方式1) -->
    <div class="bg-white rounded-xl shadow-sm p-4">
      <h3 class="text-sm font-medium text-gray-800 mb-2">この端末をキオスクにする</h3>
      <p class="text-xs text-gray-500 mb-3">
        ログイン中の管理者権限でこの端末に device 認証 (device-kiosk) を発行します。
        設定後ログアウトすると、この端末は X-Tenant-ID ではなく device 認証で API にアクセスします。
      </p>
      <p v-if="hasKioskCredential" class="text-xs text-green-600 mb-2">
        ✓ この端末はキオスク設定済みです (再設定で credential を更新)
      </p>
      <div class="flex gap-2 items-center">
        <input
          v-model="kioskName"
          type="text"
          placeholder="端末名 (任意)"
          class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
        >
        <button
          class="px-3 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white disabled:opacity-50"
          :disabled="kioskSetupBusy || !accessToken"
          @click="setupThisAsKiosk"
        >
          {{ kioskSetupBusy ? '設定中…' : 'キオスクにする' }}
        </button>
      </div>
      <p v-if="kioskSetupMsg" class="text-xs mt-2 text-gray-700">{{ kioskSetupMsg }}</p>
    </div>

    <!-- 登録モード選択 (開発者のみ) -->
    <div v-if="isDeveloper" class="rounded-xl shadow-sm p-3" :class="registrationMode === 'dev' ? 'bg-indigo-50' : 'bg-amber-50'">
      <div class="flex gap-2 mb-2">
        <button
          class="px-3 py-1 rounded-lg text-xs font-medium"
          :class="registrationMode === 'dev' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 border border-gray-300'"
          @click="registrationMode = 'dev'"
        >開発者用</button>
        <button
          class="px-3 py-1 rounded-lg text-xs font-medium"
          :class="registrationMode === 'owner' ? 'bg-amber-600 text-white' : 'bg-white text-gray-600 border border-gray-300'"
          @click="registrationMode = 'owner'"
        >Device Owner用</button>
      </div>
      <p class="text-xs" :class="registrationMode === 'dev' ? 'text-indigo-500' : 'text-amber-500'">
        {{ registrationMode === 'dev' ? 'GitHub Actions で即反映されるデバイスを登録します' : 'FCM で更新通知を受けるデバイスを登録します' }}
      </p>
    </div>
    <div v-else class="bg-amber-50 rounded-xl shadow-sm p-3">
      <p class="text-sm font-medium text-amber-700">Device Owner 用デバイス登録</p>
      <p class="text-xs text-amber-500">FCM で更新通知を受けるデバイスを登録します</p>
    </div>

    <!-- URL トークン生成 -->
    <div class="bg-white rounded-xl shadow-sm p-4">
      <h3 class="text-sm font-medium text-gray-800 mb-2">URL で端末登録 (即承認)</h3>
      <p class="text-xs text-gray-500 mb-3">URLを生成して端末に共有 (LINE等)。端末がURLを開いてデバイス名を入力すると即登録されます。有効期限24時間。</p>
      <div class="flex gap-2">
        <input
          v-model="urlTokenName"
          type="text"
          placeholder="デバイス名 (任意)"
          class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
        />
        <button
          class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 whitespace-nowrap"
          @click="handleCreateUrlToken"
        >
          URL生成
        </button>
      </div>
      <div v-if="generatedUrl" class="mt-3 bg-gray-50 rounded-lg p-3">
        <p class="text-xs text-gray-500 mb-1">端末にこのURLを共有してください:</p>
        <div class="flex gap-2 items-center">
          <code class="flex-1 text-xs text-gray-700 break-all">{{ generatedUrl }}</code>
          <button
            class="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-white whitespace-nowrap"
            @click="copyUrl"
          >
            {{ urlCopied ? 'OK' : 'Copy' }}
          </button>
        </div>
      </div>
    </div>

    <!-- QR一時 (管理者がQR生成→端末スキャン) -->
    <div class="bg-white rounded-xl shadow-sm p-4">
      <h3 class="text-sm font-medium text-gray-800 mb-2">QRコードで端末登録 (即承認)</h3>
      <p class="text-xs text-gray-500 mb-3">QRコードを生成して端末にスキャンさせると即登録。有効期限24時間。</p>
      <div class="flex gap-2">
        <input
          v-model="qrTempName"
          type="text"
          placeholder="デバイス名 (任意)"
          class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
        />
        <button
          class="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 whitespace-nowrap"
          @click="handleCreateQrTemp"
        >
          QR生成
        </button>
      </div>
      <div v-if="qrTempDataUrl" class="mt-3 text-center space-y-2">
        <p v-if="qrTempDeviceName" class="text-sm font-medium text-gray-800">{{ qrTempDeviceName }}</p>
        <img :src="qrTempDataUrl" alt="QR Temp" class="mx-auto cursor-pointer w-[200px]" @click="zoomedQrSrc = qrTempDataUrl" />
        <p class="text-xs text-gray-500">Code: {{ qrTempCode.slice(0, 8) }}...</p>
      </div>

      <!-- 生成済みQR (未登録) -->
      <div v-if="pendingUrlTokens.length > 0" class="mt-4 border-t pt-3">
        <h4 class="text-xs font-medium text-gray-600 mb-2">生成済み・未登録 ({{ pendingUrlTokens.length }})</h4>
        <div class="space-y-2">
          <div v-for="req in pendingUrlTokens" :key="req.id" class="bg-gray-50 rounded-lg p-3">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm text-gray-800">{{ req.device_name || '(名前なし)' }}</p>
                <p class="text-xs text-gray-400">{{ req.created_at?.slice(0, 16) }}</p>
              </div>
              <div class="flex gap-2">
                <button
                  class="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-white"
                  @click="toggleQr(req.registration_code)"
                >
                  {{ tokenQrUrls[req.registration_code] ? 'QR非表示' : 'QR表示' }}
                </button>
                <button
                  class="px-3 py-1 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50"
                  @click="handleReject(req.id)"
                >
                  取消
                </button>
              </div>
            </div>
            <div v-if="tokenQrUrls[req.registration_code]" class="mt-2 text-center">
              <img :src="tokenQrUrls[req.registration_code]" alt="QR" class="mx-auto cursor-pointer w-[200px]" @click="zoomedQrSrc = tokenQrUrls[req.registration_code] ?? ''" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- QR永久生成 -->
    <div class="bg-white rounded-xl shadow-sm p-4">
      <h3 class="text-sm font-medium text-gray-800 mb-2">QR永久コード (承認あり)</h3>
      <p class="text-xs text-gray-500 mb-3">印刷用QRを生成。端末がQRを読み取って申請後、管理者が下の「承認待ち」から承認すると登録完了。有効期限なし。</p>
      <div class="flex gap-2">
        <input
          v-model="permanentQrName"
          type="text"
          placeholder="デバイス名 (任意)"
          class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
        />
        <button
          class="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 whitespace-nowrap"
          @click="handleCreatePermanentQr"
        >
          QR生成
        </button>
      </div>
      <div v-if="permanentQrDataUrl" class="mt-3 text-center space-y-2">
        <img :src="permanentQrDataUrl" alt="Permanent QR" class="mx-auto cursor-pointer w-[200px]" @click="zoomedQrSrc = permanentQrDataUrl" />
        <p class="text-xs text-gray-500">Code: {{ permanentQrCode.slice(0, 8) }}...</p>
        <button
          class="px-4 py-2 bg-gray-700 text-white rounded-lg text-xs hover:bg-gray-800"
          @click="downloadQrPdf"
        >
          PDF保存
        </button>
      </div>
    </div>

    <!-- Device Owner プロビジョニング -->
    <div class="bg-white rounded-xl shadow-sm p-4">
      <h3 class="text-sm font-medium text-gray-800 mb-2">Device Owner プロビジョニング</h3>
      <p class="text-xs text-gray-500 mb-3">工場出荷リセット時にスキャンするQRを生成。アプリインストール+自動登録が行われます。</p>
      <div class="space-y-2">
        <input
          v-model="doDeviceName"
          type="text"
          placeholder="デバイス名 (任意)"
          class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
        />
        <div class="flex gap-2">
          <input
            v-model="doWifiSsid"
            type="text"
            placeholder="Wi-Fi SSID"
            class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <select
            v-model="doWifiSecurity"
            class="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          >
            <option value="WPA">WPA/WPA2/WPA3</option>
            <option value="WEP">WEP</option>
            <option value="NONE">なし</option>
          </select>
        </div>
        <input
          v-if="doWifiSecurity !== 'NONE'"
          v-model="doWifiPassword"
          type="password"
          placeholder="Wi-Fi パスワード"
          class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
        />
        <label class="flex items-center gap-2 text-xs text-gray-600">
          <input v-model="doIncludeApk" type="checkbox" />
          APK自動ダウンロード (外すと手動インストール)
        </label>
        <button
          class="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700"
          @click="handleCreateDeviceOwnerQr"
        >
          プロビジョニングQR生成
        </button>
      </div>
      <div v-if="doProvisioningQrDataUrl" class="mt-3 text-center space-y-2">
        <img :src="doProvisioningQrDataUrl" alt="Provisioning QR" class="mx-auto cursor-pointer w-[280px]" @click="zoomedQrSrc = doProvisioningQrDataUrl" />
        <p class="text-xs text-gray-500">Registration Code: {{ doRegistrationCode.slice(0, 8) }}...</p>
        <p v-if="latestApkVersion" class="text-xs text-gray-500">APK: {{ latestApkVersion }}</p>
        <p class="text-xs text-gray-400">端末を工場出荷リセットし、初期設定画面でこのQRをスキャンしてください</p>
        <details class="text-left">
          <summary class="text-xs text-gray-400 cursor-pointer">QR JSON</summary>
          <pre class="text-[10px] text-gray-500 bg-gray-50 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">APK: {{ apkDownloadUrl }}
Signature Checksum: {{ APK_SIGNATURE_CHECKSUM }}
Latest Release: {{ latestApkVersion || '取得中...' }}</pre>
        </details>
      </div>
    </div>

    <!-- 承認待ちリクエスト (QR永久のみ) -->
    <div v-if="pendingForApproval.length > 0" class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="px-4 py-3 bg-yellow-50 border-b">
        <h3 class="text-sm font-medium text-yellow-800">承認待ち ({{ pendingForApproval.length }})</h3>
      </div>
      <div class="divide-y divide-gray-100">
        <div v-for="req in pendingForApproval" :key="req.id" class="px-4 py-3 flex items-center justify-between">
          <div>
            <p class="text-sm text-gray-800">{{ req.device_name || '(名前なし)' }}</p>
            <p class="text-xs text-gray-500">
              QR永久
              <span v-if="req.phone_number"> / {{ req.phone_number }}</span>
            </p>
          </div>
          <div class="flex gap-2">
            <button
              class="px-3 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700"
              @click="handleApprove(req.id)"
            >
              承認
            </button>
            <button
              class="px-3 py-1 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50"
              @click="handleReject(req.id)"
            >
              拒否
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- デバイス一覧 -->
    <div class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
        <h3 class="text-sm font-medium text-gray-800">登録済みデバイス ({{ devices.length }})</h3>
        <div class="flex gap-2 items-center">
          <button
            class="px-3 py-1 text-xs rounded"
            :class="testingAll
              ? 'bg-yellow-100 text-yellow-700'
              : 'bg-orange-500 text-white hover:bg-orange-600'"
            :disabled="testingAll"
            @click="testCallAll"
          >
            {{ testingAll ? '送信中...' : '一斉テスト' }}
          </button>
          <span class="text-[10px] text-gray-400">WS接続中のみ</span>
          <button
            class="px-3 py-1 text-xs rounded"
            :class="testingAllWithFcm
              ? 'bg-yellow-100 text-yellow-700'
              : 'bg-teal-500 text-white hover:bg-teal-600'"
            :disabled="testingAllWithFcm"
            @click="testCallAllWithFcm"
          >
            {{ testingAllWithFcm ? '送信中...' : '一斉テスト(FCM fallback)' }}
          </button>
          <button
            class="px-3 py-1 text-xs rounded"
            :class="fcmTestingAll
              ? 'bg-yellow-100 text-yellow-700'
              : 'bg-purple-500 text-white hover:bg-purple-600'"
            :disabled="fcmTestingAll"
            @click="testFcmCallAll"
          >
            {{ fcmTestingAll ? '送信中...' : 'FCM一括テスト' }}
          </button>
          <button
            class="px-3 py-1 text-xs rounded"
            :class="otaUpdating
              ? 'bg-yellow-100 text-yellow-700'
              : 'bg-orange-500 text-white hover:bg-orange-600'"
            :disabled="otaUpdating"
            @click="triggerOtaUpdate"
          >
            {{ otaUpdating ? '送信中...' : '一括アップデート' }}
          </button>
          <button
            class="px-3 py-1 text-xs rounded"
            :class="updateQrDataUrl
              ? 'bg-gray-500 text-white'
              : 'bg-gray-700 text-white hover:bg-gray-800'"
            @click="showUpdateQr"
          >
            {{ updateQrDataUrl ? 'QR閉じる' : '更新QR' }}
          </button>
          <button class="text-xs text-blue-600 hover:underline" @click="refresh">更新</button>
        </div>
      </div>
      <!-- 更新用QRコード -->
      <div v-if="updateQrDataUrl" class="px-4 py-3 bg-gray-50 border-b text-center">
        <p class="text-xs text-gray-600 mb-2">端末でスキャンして最新APKをダウンロード</p>
        <img :src="updateQrDataUrl" alt="更新用QR" class="mx-auto w-48 h-48" />
        <p class="text-[10px] text-gray-400 mt-1 break-all">{{ apkLatestUrl }}</p>
      </div>
      <!-- 一斉テスト結果 -->
      <div v-if="testAllResults.length > 0" class="px-4 py-2 bg-gray-50 border-b">
        <p class="text-xs font-medium text-gray-600 mb-1">一斉テスト結果</p>
        <div class="flex flex-wrap gap-2">
          <span
            v-for="r in testAllResults" :key="r.device_id"
            class="inline-flex items-center px-2 py-0.5 rounded text-xs"
            :class="r.sent ? 'bg-green-100 text-green-700' : r.blocked ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-500'"
          >
            {{ devices.find(d => d.id === r.device_id)?.device_name || r.device_id.slice(0, 8) }}:
            {{ r.sent ? '送信済' : r.reason || '失敗' }}
          </span>
        </div>
      </div>
      <!-- 一斉テスト(FCM fallback)結果 -->
      <div v-if="testAllWithFcmResults.length > 0" class="px-4 py-2 bg-teal-50 border-b">
        <p class="text-xs font-medium text-teal-600 mb-1">一斉テスト(FCM fallback)結果</p>
        <div class="flex flex-wrap gap-2">
          <span
            v-for="r in testAllWithFcmResults" :key="r.device_id"
            class="inline-flex items-center px-2 py-0.5 rounded text-xs"
            :class="r.sent ? (r.via === 'FCM' ? 'bg-purple-100 text-purple-700' : 'bg-green-100 text-green-700') : r.blocked ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-500'"
          >
            {{ devices.find(d => d.id === r.device_id)?.device_name || r.device_id.slice(0, 8) }}:
            {{ r.sent ? `${r.via}で送信済` : r.reason || '失敗' }}
          </span>
        </div>
      </div>
      <!-- FCM一括テスト結果 -->
      <div v-if="fcmTestAllResults.length > 0" class="px-4 py-2 bg-purple-50 border-b">
        <p class="text-xs font-medium text-purple-600 mb-1">FCM一括テスト結果</p>
        <div class="flex flex-wrap gap-2">
          <span
            v-for="r in fcmTestAllResults" :key="r.device_id"
            class="inline-flex items-center px-2 py-0.5 rounded text-xs"
            :class="r.success ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'"
          >
            {{ r.device_name || r.device_id.slice(0, 8) }}:
            {{ r.success ? '送信済' : r.error || '失敗' }}
          </span>
        </div>
      </div>
      <!-- OTAアップデート結果 -->
      <div v-if="otaUpdateResults.length > 0" class="px-4 py-2 bg-orange-50 border-b">
        <p class="text-xs font-medium text-orange-600 mb-1">アップデート送信結果</p>
        <div class="flex flex-wrap gap-2">
          <span
            v-for="r in otaUpdateResults" :key="r.device_id"
            class="inline-flex items-center px-2 py-0.5 rounded text-xs"
            :class="r.success ? (r.error === 'already up-to-date' ? 'bg-gray-100 text-gray-500' : 'bg-green-100 text-green-700') : 'bg-red-100 text-red-700'"
          >
            {{ r.device_name || r.device_id.slice(0, 8) }}:
            {{ r.error === 'already up-to-date' ? '最新' : r.success ? '送信済' : r.error || '失敗' }}
          </span>
        </div>
      </div>
      <div v-if="loading" class="p-4 text-center text-sm text-gray-500">読み込み中...</div>
      <div v-else-if="devices.length === 0" class="p-4 text-center text-sm text-gray-400">デバイスなし</div>
      <div v-else class="divide-y divide-gray-100">
        <div v-for="dev in devices" :key="dev.id" class="px-4 py-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full" :class="dev.status === 'active' ? 'bg-green-500' : 'bg-gray-300'" />
              <div>
                <p class="text-sm text-gray-800">
                  {{ dev.device_name || dev.id.slice(0, 8) }}
                  <span v-if="dev.is_dev_device" class="ml-1 px-1 rounded text-[10px] font-medium bg-indigo-100 text-indigo-700">開発者</span>
                  <span v-if="dev.is_device_owner" class="ml-1 px-1 rounded text-[10px] font-medium bg-amber-100 text-amber-700">owner</span>
                </p>
                <p class="text-xs text-gray-500">
                  {{ dev.device_type }}
                  <span v-if="dev.phone_number"> / {{ dev.phone_number }}</span>
                  <span class="ml-1 text-gray-400">{{ dev.created_at?.slice(0, 10) }}</span>
                  <span
                    class="ml-1 px-1 rounded text-[10px] font-medium"
                    :class="connectedDeviceIds.has(dev.id) ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-400'"
                  >{{ connectedDeviceIds.has(dev.id) ? 'WS接続中' : 'WS未接続' }}</span>
                  <span
                    class="ml-1 px-1 rounded text-[10px] font-medium"
                    :class="dev.fcm_token ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'"
                  >{{ dev.fcm_token ? 'FCM' : 'FCM未' }}</span>
                  <span
                    class="ml-1 px-1 rounded text-[10px] font-medium"
                    :class="dev.always_on ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'"
                  >常時起動</span>
                  <span
                    v-if="dev.app_version_name"
                    class="ml-1 px-1 rounded text-[10px] font-medium bg-gray-100 text-gray-600"
                  >v{{ dev.app_version_name }}</span>
                </p>
                <p v-if="dev.last_login_employee_name" class="text-xs text-gray-400">
                  最終ログイン: {{ dev.last_login_employee_name }}
                  <span
                    v-if="dev.last_login_employee_role?.some((r: string) => r === 'manager' || r === 'admin')"
                    class="text-green-600"
                  >(管理者)</span>
                </p>
              </div>
            </div>
            <div class="flex gap-1">
              <!-- 常時起動ON/OFF -->
              <button
                class="px-2 py-1 text-xs rounded"
                :class="dev.always_on
                  ? 'bg-green-100 text-green-700 hover:bg-green-200'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'"
                @click="toggleAlwaysOn(dev)"
              >
                常時起動{{ dev.always_on ? 'ON' : 'OFF' }}
              </button>
              <!-- 着信ON/OFF -->
              <button
                class="px-2 py-1 text-xs rounded"
                :class="dev.call_enabled
                  ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'"
                @click="toggleCallEnabled(dev)"
              >
                着信{{ dev.call_enabled ? 'ON' : 'OFF' }}
              </button>
              <!-- 着信テスト -->
              <button
                class="px-2 py-1 text-xs rounded"
                :class="testingDevice === dev.id
                  ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-orange-100 text-orange-700 hover:bg-orange-200'"
                :disabled="testingDevice === dev.id"
                @click="testCall(dev.id)"
              >
                {{ testingDevice === dev.id ? '送信中...' : 'テスト' }}
              </button>
              <!-- FCMテスト -->
              <button
                v-if="dev.fcm_token"
                class="px-2 py-1 text-xs rounded"
                :class="fcmTestingDevice === dev.id
                  ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-green-100 text-green-700 hover:bg-green-200'"
                :disabled="fcmTestingDevice === dev.id"
                @click="testFcm(dev.id)"
              >
                {{ fcmTestingDevice === dev.id ? '送信中...' : 'FCM' }}
              </button>
              <!-- OTA更新 -->
              <button
                v-if="dev.fcm_token"
                class="px-2 py-1 text-xs rounded"
                :class="otaUpdatingDevice === dev.id
                  ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-orange-100 text-orange-700 hover:bg-orange-200'"
                :disabled="otaUpdatingDevice === dev.id"
                @click="triggerDeviceUpdate(dev.id)"
              >
                {{ otaUpdatingDevice === dev.id ? '送信中...' : '更新' }}
              </button>
              <!-- スケジュール展開 -->
              <button
                class="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
                @click="toggleCallSettings(dev)"
              >
                {{ expandedCallSettings.has(dev.id) ? '閉じる' : '時間帯' }}
              </button>
              <button
                v-if="dev.status === 'active'"
                class="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
                @click="handleDisable(dev.id)"
              >
                無効化
              </button>
              <button
                v-else
                class="px-2 py-1 text-xs border border-green-300 text-green-600 rounded hover:bg-green-50"
                @click="handleEnable(dev.id)"
              >
                有効化
              </button>
              <button
                class="px-2 py-1 text-xs text-red-600 border border-red-300 rounded hover:bg-red-50"
                @click="handleDelete(dev.id)"
              >
                削除
              </button>
            </div>
          </div>
          <!-- 着信テスト結果 -->
          <p
            v-if="testResult && testResult.deviceId === dev.id"
            class="mt-1 text-xs"
            :class="testResult.success ? 'text-green-600' : 'text-red-600'"
          >
            {{ testResult.message }}
          </p>
          <!-- FCMテスト結果 -->
          <p
            v-if="fcmTestResult && fcmTestResult.deviceId === dev.id"
            class="mt-1 text-xs"
            :class="fcmTestResult.success ? 'text-green-600' : 'text-red-600'"
          >
            {{ fcmTestResult.message }}
          </p>
          <!-- OTA更新結果 -->
          <p
            v-if="otaDeviceResult && otaDeviceResult.deviceId === dev.id"
            class="mt-1 text-xs"
            :class="otaDeviceResult.success ? 'text-green-600' : 'text-red-600'"
          >
            {{ otaDeviceResult.message }}
          </p>
          <!-- 着信スケジュール設定 (展開時) -->
          <div v-if="expandedCallSettings.has(dev.id)" class="mt-3 ml-4 border-l-2 border-blue-200 pl-3">
            <template v-if="editingSchedules[dev.id]">
              <CallScheduleSettings
                :model-value="editingSchedules[dev.id]!"
                @update:model-value="updateScheduleForDevice(dev.id, $event)"
              />
              <div class="mt-2 flex gap-2">
                <button
                  class="px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700"
                  @click="saveCallSchedule(dev)"
                >
                  保存
                </button>
                <button
                  class="px-3 py-1 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50"
                  @click="deleteCallSchedule(dev)"
                >
                  削除
                </button>
              </div>
            </template>
            <template v-else>
              <p class="text-xs text-gray-500 mb-2">スケジュール未設定</p>
              <button
                class="px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700"
                @click="editingSchedules[dev.id] = { ...defaultSchedule }"
              >
                スケジュールを設定
              </button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- QR 拡大モーダル -->
    <div
      v-if="zoomedQrSrc"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      @click="zoomedQrSrc = ''"
    >
      <img :src="zoomedQrSrc" alt="QR" class="max-w-[90vw] max-h-[90vh] rounded-lg bg-white p-4" />
    </div>
  </div>
</template>
