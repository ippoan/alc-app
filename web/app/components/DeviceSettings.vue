<script setup lang="ts">
// BLE Gateway の既知 VID:PID (CH340, CP210x, Espressif, FTDI FT232R)
const BLE_GW_DEVICES = [
  { vid: 0x1A86 },            // CH340/CH552
  { vid: 0x10C4 },            // CP210x
  { vid: 0x303A },            // Espressif native USB
  { vid: 0x0403, pid: 0x6001 }, // FTDI FT232R (ATOM Lite)
]

const { ports, isSupported, refreshPorts, forgetPort } = useSerialDeviceManager()
const { isAndroidApp } = useFingerprint()
const { deactivateDevice, deviceTenantId, deviceId: activatedDeviceId } = useAuth()
const { clearKioskCredential } = useDeviceToken()

// 端末登録リセット (WebView localStorage + Android native SharedPreferences 両方をクリア)
const resetting = ref(false)
// 2段階タップ確認。Android WebView は onJsConfirm 未実装だと window.confirm() が常に
// false を返すため使えない (「リセットできない」の原因)。in-page で確認する。
const resetConfirming = ref(false)
let resetConfirmTimer: ReturnType<typeof setTimeout> | null = null

// WS (着信) / FCM の接続・登録状態 (Android ブリッジから取得、診断用)。
// isCallConnected() = RoomWatcher が signaling に WS 接続中か。
// getFcmStatus() = {token_present, registered} JSON。
type AndroidDiag = {
  isCallConnected?: () => boolean
  isCallEnabled?: () => boolean
  getFcmStatus?: () => string
}
const wsConnected = ref<boolean | null>(null)
const fcmRegistered = ref<boolean | null>(null)
const fcmTokenPresent = ref<boolean | null>(null)
let diagTimer: ReturnType<typeof setInterval> | null = null

function refreshDeviceDiag() {
  const android = (window as unknown as { Android?: AndroidDiag }).Android
  if (!android) return
  try {
    wsConnected.value = android.isCallConnected?.() ?? null
    const raw = android.getFcmStatus?.()
    if (raw) {
      const s = JSON.parse(raw) as { token_present?: boolean, registered?: boolean }
      fcmTokenPresent.value = s.token_present ?? null
      fcmRegistered.value = s.registered ?? null
    }
  } catch { /* ブリッジ未実装の旧 APK 等は無視 */ }
}

onMounted(() => {
  if (isAndroidApp) {
    refreshDeviceDiag()
    diagTimer = setInterval(refreshDeviceDiag, 3000) // 3秒ごとに更新
  }
})
onUnmounted(() => {
  if (diagTimer) clearInterval(diagTimer)
  if (resetConfirmTimer) clearTimeout(resetConfirmTimer)
})

function resetDeviceRegistration() {
  if (resetting.value) return
  // 1タップ目: 確認状態にして 4秒だけ「本当にリセット」ボタンを出す (window.confirm は
  // WebView で効かないため in-page 確認)。2タップ目で実行。
  if (!resetConfirming.value) {
    resetConfirming.value = true
    if (resetConfirmTimer) clearTimeout(resetConfirmTimer)
    resetConfirmTimer = setTimeout(() => { resetConfirming.value = false }, 4000)
    return
  }
  // 2タップ目: 実行
  if (resetConfirmTimer) clearTimeout(resetConfirmTimer)
  resetConfirming.value = false
  resetting.value = true
  try {
    // WebView 側 (localStorage): tenant / device_id / settings_token / kiosk credential
    deactivateDevice()
    clearKioskCredential()
    // Android native 側 (SharedPreferences): device_id / settings_token / fcm 登録マーク /
    // kiosk credential を消し RoomWatcher を停止する (stale device_id 起因の WS未接続・FCM未 を解消)。
    const android = (window as unknown as { Android?: { resetDeviceRegistration?: () => void } }).Android
    android?.resetDeviceRegistration?.()
    // staging の auth バイパス (NUXT_PUBLIC_STAGING_TENANT_ID) はリロード時に tenant を
    // 自動再アクティベートするため、リセット直後は 1 回スキップして「未登録」を出し、
    // 実登録 (device_id を入れる) の導線を通す。
    sessionStorage.setItem('alc_skip_staging_bypass', '1')
    // 登録画面へ戻す
    window.location.href = '/'
  } finally {
    resetting.value = false
  }
}

// FC-1200 composable
const fc1200 = useFc1200Serial()

// BLE Gateway composable
const bleGw = useBleGateway()

// FC-1200 diagnostics
const fc1200Testing = ref(false)
const fc1200TestResult = ref<string | null>(null)
const fc1200Measuring = ref(false)

// BLE GW diagnostics
const bleGwTesting = ref(false)
const bleGwTestResult = ref<string | null>(null)

onMounted(() => {
  if (isSupported) refreshPorts()
})

function formatVidPid(info: SerialPortInfo): string {
  if (info.usbVendorId !== undefined) {
    const vid = info.usbVendorId.toString(16).toUpperCase().padStart(4, '0')
    const pid = (info.usbProductId ?? 0).toString(16).toUpperCase().padStart(4, '0')
    return `VID:0x${vid} PID:0x${pid}`
  }
  return 'シリアルポート'
}

function isBleGwDevice(info: SerialPortInfo): boolean {
  if (info.usbVendorId === undefined) return false
  return BLE_GW_DEVICES.some(d =>
    d.vid === info.usbVendorId && (d.pid === undefined || d.pid === info.usbProductId),
  )
}

// FC-1200 ポート (BLE GW 以外の USB デバイス)
const fc1200Ports = computed(() =>
  ports.value.filter(e => !isBleGwDevice(e.info)),
)

// BLE Gateway ポート
const bleGwPorts = computed(() =>
  ports.value.filter(e => isBleGwDevice(e.info)),
)

async function registerFc1200() {
  if (!isSupported) return
  try {
    // FC-1200 用: ESP32 以外のデバイスを選択
    await navigator.serial.requestPort()
    await refreshPorts()
  } catch {}
}

async function registerBleGw() {
  if (!isSupported) return
  try {
    await navigator.serial.requestPort({
      filters: BLE_GW_DEVICES.map(d => ({
        usbVendorId: d.vid,
        ...(d.pid !== undefined && { usbProductId: d.pid }),
      })),
    })
    await refreshPorts()
  } catch {}
}

async function testFc1200() {
  fc1200Testing.value = true
  fc1200Measuring.value = false
  fc1200TestResult.value = null
  try {
    const success = await fc1200.autoConnect()
    if (success) {
      fc1200TestResult.value = '接続成功 — 測定を開始します'
      fc1200Measuring.value = true
      fc1200.startMeasurement()
    } else {
      fc1200TestResult.value = '接続失敗 — デバイスが USB に接続されているか確認してください'
      fc1200Testing.value = false
    }
  } catch (e) {
    fc1200TestResult.value = `エラー: ${e instanceof Error ? e.message : '不明'}`
    fc1200Testing.value = false
  }
}

async function stopFc1200Test() {
  fc1200Measuring.value = false
  fc1200Testing.value = false
  await fc1200.disconnect()
}

// 測定完了 or エラーで自動終了
watch(fc1200.result, (val) => {
  if (val && fc1200Measuring.value) {
    fc1200TestResult.value = `測定完了: ${val.alcoholValue} mg/L (${val.resultType === 'normal' ? '正常' : '超過'})`
    fc1200Measuring.value = false
    fc1200Testing.value = false
    fc1200.disconnect()
  }
})

watch(fc1200.error, (val) => {
  if (val && fc1200Measuring.value) {
    fc1200TestResult.value = `エラー: ${val}`
    fc1200Measuring.value = false
    fc1200Testing.value = false
    fc1200.disconnect()
  }
})

const fc1200StateText = computed(() => {
  switch (fc1200.state.value) {
    case 'warming_up': return 'ウォームアップ中...'
    case 'blow_waiting': return '息を吹きかけてください'
    case 'measuring': return '測定中...'
    default: return ''
  }
})

async function testBleGw() {
  bleGwTesting.value = true
  bleGwTestResult.value = null
  try {
    const success = await bleGw.autoConnect()
    if (success) {
      // ready メッセージ待ち (最大3秒)
      await new Promise(r => setTimeout(r, 3000))
      const ver = bleGw.gatewayVersion.value
      const thermo = bleGw.thermometerConnected.value
      const bp = bleGw.bloodPressureConnected.value
      bleGwTestResult.value = [
        `接続成功`,
        ver ? `FW: v${ver}` : null,
        `体温計: ${thermo ? '接続' : '未接続'}`,
        `血圧計: ${bp ? '接続' : '未接続'}`,
      ].filter(Boolean).join(' / ')
    } else {
      bleGwTestResult.value = '接続失敗 — ATOM Lite が USB に接続されているか確認してください'
    }
  } catch (e) {
    bleGwTestResult.value = `エラー: ${e instanceof Error ? e.message : '不明'}`
  } finally {
    bleGwTesting.value = false
  }
}

// Android BLE テスト — WebSocket ブリッジ経由で BLE スキャン状態を確認
async function testAndroidBle() {
  bleGwTesting.value = true
  bleGwTestResult.value = null
  try {
    const success = await bleGw.autoConnect()
    if (success) {
      await new Promise(r => setTimeout(r, 3000))
      const thermo = bleGw.thermometerConnected.value
      const bp = bleGw.bloodPressureConnected.value
      bleGwTestResult.value = [
        `BLE ブリッジ接続成功`,
        `体温計: ${thermo ? '検出済み' : '未検出'}`,
        `血圧計: ${bp ? '検出済み' : '未検出'}`,
      ].join(' / ')
    } else {
      bleGwTestResult.value = 'BLE ブリッジ接続失敗 — アプリを再起動してください'
    }
  } catch (e) {
    bleGwTestResult.value = `エラー: ${e instanceof Error ? e.message : '不明'}`
  } finally {
    bleGwTesting.value = false
  }
}

async function syncFc1200Date() {
  if (!fc1200.isConnected.value) {
    const success = await fc1200.autoConnect()
    if (!success) return
  }
  fc1200.updateDeviceDate()
  fc1200TestResult.value = 'デバイス日時を同期しました'
  await new Promise(r => setTimeout(r, 2000))
  await fc1200.disconnect()
}
</script>

<template>
  <div class="w-full max-w-lg mx-auto px-4 py-4 space-y-6">
    <!-- 端末登録リセット -->
    <div class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="px-4 py-3 bg-gray-50 border-b">
        <h3 class="text-sm font-medium text-gray-800">端末登録</h3>
        <p class="text-xs text-gray-500">この端末に保存された登録情報 (テナント・device ID・着信/FCM 設定)</p>
      </div>
      <div class="p-4 space-y-3">
        <div class="text-xs text-gray-600 space-y-1">
          <p>状態:
            <span :class="deviceTenantId ? 'text-green-600 font-medium' : 'text-gray-400'">
              {{ deviceTenantId ? '登録済み' : '未登録' }}
            </span>
          </p>
          <p v-if="activatedDeviceId" class="font-mono text-gray-400 break-all">device: {{ activatedDeviceId }}</p>
        </div>

        <!-- WS (着信) / FCM 状態 (Android アプリのみ、診断用) -->
        <div v-if="isAndroidApp" class="flex flex-wrap gap-2 text-xs">
          <span class="inline-flex items-center gap-1 px-2 py-1 rounded-full"
            :class="wsConnected ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'">
            <span class="w-1.5 h-1.5 rounded-full" :class="wsConnected ? 'bg-green-500' : 'bg-gray-400'" />
            着信WS: {{ wsConnected === null ? '不明' : wsConnected ? '接続中' : '未接続' }}
          </span>
          <span class="inline-flex items-center gap-1 px-2 py-1 rounded-full"
            :class="fcmRegistered ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'">
            <span class="w-1.5 h-1.5 rounded-full" :class="fcmRegistered ? 'bg-green-500' : 'bg-gray-400'" />
            FCM: {{ fcmRegistered === null ? '不明' : fcmRegistered ? '登録済み' : (fcmTokenPresent ? '未登録(token有)' : '未登録') }}
          </span>
          <button class="px-2 py-1 rounded-full bg-blue-50 text-blue-600 hover:bg-blue-100" @click="refreshDeviceDiag">
            更新
          </button>
        </div>

        <button
          class="px-3 py-1.5 text-xs border rounded-lg transition-colors disabled:opacity-50"
          :class="resetConfirming
            ? 'bg-red-600 text-white border-red-600 hover:bg-red-700'
            : 'text-red-600 border-red-300 hover:bg-red-50'"
          :disabled="resetting"
          @click="resetDeviceRegistration"
        >
          {{ resetting ? 'リセット中...' : resetConfirming ? '本当にリセット？(もう一度タップ)' : '端末登録をリセット' }}
        </button>
        <p class="text-[10px] text-gray-400">
          着信が来ない / FCM が届かない / 環境を切り替えた後に使ってください。リセット後は再登録が必要です。
        </p>
      </div>
    </div>

    <!-- Android WebView: WebSocket ブリッジ経由のテスト -->
    <template v-if="isAndroidApp">
      <!-- FC-1200 セクション (Android) -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-4 py-3 bg-gray-50 border-b">
          <h3 class="text-sm font-medium text-gray-800">FC-1200 アルコールチェッカー</h3>
          <p class="text-xs text-gray-500">USB 接続 → WebSocket ブリッジ</p>
        </div>
        <div class="p-4">
          <!-- 接続状態 -->
          <div class="flex items-center gap-2 mb-3">
            <span class="w-2 h-2 rounded-full" :class="fc1200.isConnected.value ? 'bg-green-500' : 'bg-gray-300'" />
            <span class="text-sm" :class="fc1200.isConnected.value ? 'text-green-700' : 'text-gray-500'">
              {{ fc1200.isConnected.value ? '接続中' : '未接続' }}
            </span>
            <span v-if="fc1200.transport.value" class="text-xs text-gray-400">({{ fc1200.transport.value }})</span>
          </div>

          <!-- 測定中の状態表示 -->
          <div v-if="fc1200Measuring" class="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-3">
            <div class="flex items-center gap-3">
              <span class="w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
              <span class="text-sm font-medium text-blue-700">{{ fc1200StateText || '接続中...' }}</span>
            </div>
            <div v-if="fc1200.state.value === 'blow_waiting'" class="mt-3 bg-blue-100 rounded-lg p-3 text-center">
              <p class="text-blue-800 font-bold">息を吹きかけてください</p>
              <p class="text-blue-600 text-xs mt-1">FC-1200 のセンサー部に向かって約5秒間</p>
            </div>
            <button
              class="mt-3 px-3 py-1.5 text-xs text-red-600 border border-red-300 rounded-lg hover:bg-red-50"
              @click="stopFc1200Test"
            >
              中止
            </button>
          </div>

          <!-- テストボタン -->
          <div class="flex gap-2">
            <button
              class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              :disabled="fc1200Testing"
              @click="testFc1200"
            >
              {{ fc1200Testing ? 'テスト中...' : 'テスト測定' }}
            </button>
            <button
              class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              :disabled="fc1200Testing"
              @click="syncFc1200Date"
            >
              日時同期
            </button>
          </div>
          <p v-if="fc1200TestResult" class="text-xs mt-2" :class="fc1200TestResult.includes('失敗') || fc1200TestResult.includes('エラー') ? 'text-red-600' : 'text-green-600'">
            {{ fc1200TestResult }}
          </p>
        </div>
      </div>

      <!-- BLE セクション (Android) -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-4 py-3 bg-gray-50 border-b">
          <h3 class="text-sm font-medium text-gray-800">BLE 医療機器 (体温計・血圧計)</h3>
          <p class="text-xs text-gray-500">Android BLE スキャン → WebSocket ブリッジ</p>
        </div>
        <div class="p-4">
          <!-- 接続状態 -->
          <div class="flex items-center gap-2 mb-3">
            <span class="w-2 h-2 rounded-full" :class="bleGw.isConnected.value ? 'bg-green-500' : 'bg-gray-300'" />
            <span class="text-sm" :class="bleGw.isConnected.value ? 'text-green-700' : 'text-gray-500'">
              {{ bleGw.isConnected.value ? 'ブリッジ接続中' : '未接続' }}
            </span>
          </div>

          <!-- 検出済み機器 -->
          <div v-if="bleGw.isConnected.value" class="bg-green-50 rounded-lg p-3 mb-3">
            <div class="flex gap-4 text-xs">
              <span class="flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full" :class="bleGw.thermometerConnected.value ? 'bg-green-500' : 'bg-gray-300'" />
                体温計: {{ bleGw.thermometerConnected.value ? '検出' : '未検出' }}
              </span>
              <span class="flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full" :class="bleGw.bloodPressureConnected.value ? 'bg-green-500' : 'bg-gray-300'" />
                血圧計: {{ bleGw.bloodPressureConnected.value ? '検出' : '未検出' }}
              </span>
            </div>
          </div>

          <!-- テストボタン -->
          <button
            class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            :disabled="bleGwTesting"
            @click="testAndroidBle"
          >
            {{ bleGwTesting ? '接続テスト中...' : '接続テスト' }}
          </button>
          <p v-if="bleGwTestResult" class="text-xs mt-2" :class="bleGwTestResult.includes('失敗') || bleGwTestResult.includes('エラー') ? 'text-red-600' : 'text-green-600'">
            {{ bleGwTestResult }}
          </p>
        </div>
      </div>

      <!-- 説明 (Android) -->
      <div class="bg-blue-50 rounded-xl p-4 text-sm text-blue-800">
        <p class="font-medium mb-1">Android デバイステスト</p>
        <p class="text-xs text-blue-700">
          FC-1200 と BLE 医療機器はアプリ内の WebSocket ブリッジ経由で接続されます。
          テストを実行して接続状態を確認できます。
        </p>
      </div>
    </template>

    <!-- WebSerial 非対応 & Android でもない -->
    <div v-else-if="!isSupported" class="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-center">
      <p class="text-yellow-700 text-sm">デバイス管理は Chrome/Edge ブラウザ版でのみ利用可能です</p>
    </div>

    <!-- WebSerial 対応 (PC Chrome/Edge) -->
    <template v-else>
      <!-- FC-1200 セクション -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
          <div>
            <h3 class="text-sm font-medium text-gray-800">FC-1200 アルコールチェッカー</h3>
            <p class="text-xs text-gray-500">9600 baud</p>
          </div>
          <button
            class="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs hover:bg-blue-700 transition-colors"
            @click="registerFc1200"
          >
            デバイスを追加
          </button>
        </div>

        <div class="p-4">
          <!-- 登録済みポート -->
          <div v-if="fc1200Ports.length > 0" class="divide-y divide-gray-100 mb-3">
            <div
              v-for="(entry, i) in fc1200Ports"
              :key="i"
              class="flex items-center justify-between py-2"
            >
              <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full bg-green-500" />
                <div>
                  <p class="text-sm text-gray-800">FC-1200</p>
                  <p class="text-xs text-gray-500 font-mono">{{ formatVidPid(entry.info) }}</p>
                </div>
              </div>
              <button
                class="px-2 py-1 text-xs text-red-600 border border-red-300 rounded hover:bg-red-50"
                @click="forgetPort(entry.port)"
              >
                解除
              </button>
            </div>
          </div>
          <p v-else class="text-xs text-gray-400 mb-3">未登録</p>

          <!-- 測定中の状態表示 -->
          <div v-if="fc1200Measuring" class="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-3">
            <div class="flex items-center gap-3">
              <span class="w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
              <span class="text-sm font-medium text-blue-700">{{ fc1200StateText || '接続中...' }}</span>
            </div>
            <div v-if="fc1200.state.value === 'blow_waiting'" class="mt-3 bg-blue-100 rounded-lg p-3 text-center">
              <p class="text-blue-800 font-bold">息を吹きかけてください</p>
              <p class="text-blue-600 text-xs mt-1">FC-1200 のセンサー部に向かって約5秒間</p>
            </div>
            <button
              class="mt-3 px-3 py-1.5 text-xs text-red-600 border border-red-300 rounded-lg hover:bg-red-50"
              @click="stopFc1200Test"
            >
              中止
            </button>
          </div>

          <!-- 診断ボタン -->
          <div class="flex gap-2">
            <button
              class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              :disabled="fc1200Testing || fc1200Ports.length === 0"
              @click="testFc1200"
            >
              {{ fc1200Testing ? 'テスト中...' : 'テスト測定' }}
            </button>
            <button
              class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              :disabled="fc1200Testing || fc1200Ports.length === 0"
              @click="syncFc1200Date"
            >
              日時同期
            </button>
          </div>
          <p v-if="fc1200TestResult" class="text-xs mt-2" :class="fc1200TestResult.includes('失敗') || fc1200TestResult.includes('エラー') ? 'text-red-600' : 'text-green-600'">
            {{ fc1200TestResult }}
          </p>
        </div>
      </div>

      <!-- BLE ゲートウェイ セクション -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
          <div>
            <h3 class="text-sm font-medium text-gray-800">BLE ゲートウェイ (ATOM Lite)</h3>
            <p class="text-xs text-gray-500">体温計・血圧計接続用 / 115200 baud</p>
          </div>
          <button
            class="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs hover:bg-blue-700 transition-colors"
            @click="registerBleGw"
          >
            デバイスを追加
          </button>
        </div>

        <div class="p-4">
          <!-- 登録済みポート -->
          <div v-if="bleGwPorts.length > 0" class="divide-y divide-gray-100 mb-3">
            <div
              v-for="(entry, i) in bleGwPorts"
              :key="i"
              class="flex items-center justify-between py-2"
            >
              <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full" :class="bleGw.isConnected.value ? 'bg-green-500' : 'bg-gray-300'" />
                <div>
                  <p class="text-sm text-gray-800">ATOM Lite BLE Gateway</p>
                  <p class="text-xs text-gray-500 font-mono">{{ formatVidPid(entry.info) }}</p>
                </div>
              </div>
              <button
                class="px-2 py-1 text-xs text-red-600 border border-red-300 rounded hover:bg-red-50"
                @click="forgetPort(entry.port)"
              >
                解除
              </button>
            </div>
          </div>
          <p v-else class="text-xs text-gray-400 mb-3">未登録</p>

          <!-- ゲートウェイ状態 (接続中の場合) -->
          <div v-if="bleGw.isConnected.value" class="bg-green-50 rounded-lg p-3 mb-3">
            <div class="flex gap-4 text-xs">
              <span v-if="bleGw.gatewayVersion.value" class="text-green-700">FW: v{{ bleGw.gatewayVersion.value }}</span>
              <span class="flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full" :class="bleGw.thermometerConnected.value ? 'bg-green-500' : 'bg-gray-300'" />
                体温計
              </span>
              <span class="flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full" :class="bleGw.bloodPressureConnected.value ? 'bg-green-500' : 'bg-gray-300'" />
                血圧計
              </span>
            </div>
          </div>

          <!-- 診断ボタン -->
          <div class="flex gap-2">
            <button
              class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              :disabled="bleGwTesting || bleGwPorts.length === 0"
              @click="testBleGw"
            >
              {{ bleGwTesting ? '接続テスト中...' : '接続テスト' }}
            </button>
          </div>
          <p v-if="bleGwTestResult" class="text-xs mt-2" :class="bleGwTestResult.includes('失敗') || bleGwTestResult.includes('エラー') ? 'text-red-600' : 'text-green-600'">
            {{ bleGwTestResult }}
          </p>
        </div>
      </div>

      <!-- 説明 -->
      <div class="bg-blue-50 rounded-xl p-4 text-sm text-blue-800">
        <p class="font-medium mb-1">デバイス登録について</p>
        <p class="text-xs text-blue-700">
          ここでデバイスを登録すると、測定画面で自動的に接続されます。
          USB ポートを変更する場合は、古いデバイスを「解除」してから新しいデバイスを追加してください。
        </p>
      </div>
    </template>
  </div>
</template>
