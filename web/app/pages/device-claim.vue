<script setup lang="ts">
import { initApi, claimDeviceRegistration, checkDeviceRegistrationStatus } from '~/utils/api'
import type { DeviceFlowType } from '~/types'

const config = useRuntimeConfig()
const route = useRoute()
const { activateDevice, accessToken, deviceTenantId, refreshAccessToken } = useAuth()

// API 初期化 (device-claim は index.vue を経由しない場合がある)
initApi(
  config.public.apiBase as string,
  () => accessToken.value,
  () => deviceTenantId.value,
  () => refreshAccessToken(),
)

const token = computed(() => route.query.token as string || '')
const phoneNumber = ref('')
const deviceName = ref('')
const status = ref<'form' | 'submitting' | 'waiting' | 'activated' | 'error'>('form')
const flowType = ref<DeviceFlowType | ''>('')
const errorMessage = ref('')
let pollingTimer: ReturnType<typeof setInterval> | null = null

// Android App Links (autoVerify) はサイドロード配布 (Play 経由でない) だと自動検証が
// 効かず、ブラウザ (Chrome) でこのページが開かれてしまうことがある。window.Android
// bridge が無ければブラウザ経由と判断し、intent:// URI で AlcoholChecker アプリを
// package 明示で確実に起動するフォールバックボタンを出す (autoVerify のドメイン検証に
// 依存しない経路)。Chrome for Developers: https://developer.chrome.com/docs/android/intents
const ANDROID_PACKAGE = 'com.example.alcoholchecker'
const hasAndroidBridge = ref(true) // SSR/初期描画中はボタンを出さない (hydration mismatch 回避)
const appIntentUrl = ref('')

async function submit() {
  if (!token.value) {
    errorMessage.value = '登録トークンが指定されていません'
    status.value = 'error'
    return
  }

  status.value = 'submitting'
  errorMessage.value = ''

  try {
    const res = await claimDeviceRegistration({
      registration_code: token.value,
      phone_number: phoneNumber.value || undefined,
      device_name: deviceName.value || undefined,
    })

    flowType.value = res.flow_type

    if (res.flow_type === 'url' && res.device_id && res.tenant_id) {
      // URLフロー: 即アクティベート
      activateDevice(res.tenant_id, res.device_id, res.settings_token)
      status.value = 'activated'
    } else if (res.flow_type === 'qr_permanent') {
      // QR永久: 承認待ち
      status.value = 'waiting'
      startPolling()
    } else {
      status.value = 'error'
      errorMessage.value = res.message || '予期しないレスポンスです'
    }
  } catch (e) {
    status.value = 'error'
    errorMessage.value = e instanceof Error ? e.message : '登録に失敗しました'
  }
}

function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer)
  pollingTimer = setInterval(async () => {
    try {
      const res = await checkDeviceRegistrationStatus(token.value)
      if (res.status === 'approved' && res.tenant_id && res.device_id) {
        stopPolling()
        activateDevice(res.tenant_id, res.device_id, res.settings_token)
        status.value = 'activated'
      } else if (res.status === 'rejected') {
        stopPolling()
        status.value = 'error'
        errorMessage.value = '管理者によって登録が拒否されました'
      }
    } catch {
      // ポーリングエラーは無視
    }
  }, 3000)
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer)
    pollingTimer = null
  }
}

onMounted(async () => {
  // 登録情報を事前取得し、管理者が設定したデバイス名をプリセット
  if (token.value) {
    try {
      console.log('[device-claim] fetching status for token:', token.value.slice(0, 8))
      const info = await checkDeviceRegistrationStatus(token.value)
      console.log('[device-claim] status response:', JSON.stringify(info))
      if (info.device_name) deviceName.value = info.device_name
    } catch (e) {
      console.error('[device-claim] status fetch failed:', e)
    }
  }

  const android = (window as any).Android
  hasAndroidBridge.value = !!android
  if (android?.getPhoneNumber) {
    try {
      const number = android.getPhoneNumber()
      if (number) phoneNumber.value = number
    } catch (e) {
      console.warn('Failed to get phone number:', e)
    }
    // パーミッション許可後にAndroid側からイベントが来る
    window.addEventListener('phone-number', ((e: CustomEvent) => {
      if (e.detail && !phoneNumber.value) phoneNumber.value = e.detail
    }) as EventListener)
  } else {
    // ブラウザ経由 (App Links 未検証等) — アプリ起動用 intent:// URI を組み立てる
    const url = new URL(window.location.href)
    const rest = `${url.host}${url.pathname}${url.search}`
    const fallback = encodeURIComponent(url.href)
    appIntentUrl.value = `intent://${rest}#Intent;scheme=https;package=${ANDROID_PACKAGE};S.browser_fallback_url=${fallback};end`
  }
})

onUnmounted(() => stopPolling())
</script>

<template>
  <div class="min-h-screen bg-gray-100 flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl shadow-lg p-8 w-full max-w-sm">
      <h1 class="text-lg font-bold text-gray-800 mb-2 text-center">端末登録</h1>
      <p class="text-xs text-gray-500 text-center mb-6">デバイス名を入力して登録してください。電話番号は任意です。</p>

      <!-- App Links (autoVerify) が効かずブラウザで開かれた場合のフォールバック -->
      <div v-if="!hasAndroidBridge && appIntentUrl" class="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-center">
        <p class="text-xs text-amber-700 mb-2">ブラウザで開かれています。電話番号の自動入力にはアプリでの表示が必要です。</p>
        <a
          :href="appIntentUrl"
          class="inline-block px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700"
        >
          AlcoholChecker アプリで開く
        </a>
      </div>

      <!-- 入力フォーム -->
      <div v-if="status === 'form' || status === 'error'" class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">デバイス名</label>
          <input
            v-model="deviceName"
            type="text"
            placeholder="例: 営業車A"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">電話番号 (任意)</label>
          <input
            v-model="phoneNumber"
            type="tel"
            placeholder="例: 090-1234-5678"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
        </div>
        <p v-if="errorMessage" class="text-red-600 text-xs">{{ errorMessage }}</p>
        <button
          class="w-full px-4 py-3 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          @click="submit"
        >
          登録する
        </button>
      </div>

      <!-- 送信中 -->
      <div v-else-if="status === 'submitting'" class="text-center py-8">
        <div class="flex items-center justify-center gap-2 text-blue-600">
          <span class="w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
          <span class="text-sm">登録中...</span>
        </div>
      </div>

      <!-- 承認待ち (QR永久) -->
      <div v-else-if="status === 'waiting'" class="text-center py-8 space-y-3">
        <div class="flex items-center justify-center gap-2 text-blue-600">
          <span class="w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
          <span class="text-sm">管理者の承認待ち...</span>
        </div>
        <p class="text-xs text-gray-500">管理者が承認すると自動的にアクティベートされます</p>
      </div>

      <!-- アクティベート完了 -->
      <div v-else-if="status === 'activated'" class="text-center py-8 space-y-3">
        <div class="text-green-600 text-3xl font-bold">OK</div>
        <p class="text-sm text-gray-700">端末が正常に登録されました</p>
        <NuxtLink
          to="/"
          class="inline-block px-6 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
        >
          トップへ
        </NuxtLink>
      </div>
    </div>
  </div>
</template>
