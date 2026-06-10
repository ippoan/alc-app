<script setup lang="ts">
import QRCode from 'qrcode'
import { createDeviceRegistrationRequest, checkDeviceRegistrationStatus } from '~/utils/api'

const { isDeviceActivated, activateDevice, loginWithGoogleRedirect } = useAuth()

const registrationCode = ref('')
const qrDataUrl = ref('')
const expiresAt = ref('')
const status = ref<'idle' | 'generating' | 'polling' | 'approved' | 'error'>('idle')
const errorMessage = ref('')
let pollingTimer: ReturnType<typeof setInterval> | null = null

async function startRegistration() {
  status.value = 'generating'
  errorMessage.value = ''
  try {
    const res = await createDeviceRegistrationRequest()
    registrationCode.value = res.registration_code
    expiresAt.value = res.expires_at

    // QRコード生成: 承認ページのURL
    const approveUrl = `${window.location.origin}/device-approve?code=${res.registration_code}`
    qrDataUrl.value = await QRCode.toDataURL(approveUrl, { width: 280, margin: 2 })

    status.value = 'polling'
    startPolling()
  } catch (e) {
    status.value = 'error'
    errorMessage.value = e instanceof Error ? e.message : '登録リクエストの生成に失敗しました'
  }
}

function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer)
  pollingTimer = setInterval(async () => {
    try {
      const res = await checkDeviceRegistrationStatus(registrationCode.value)
      if (res.status === 'approved' && res.tenant_id && res.device_id) {
        stopPolling()
        activateDevice(res.tenant_id, res.device_id, res.settings_token)
        status.value = 'approved'
      } else if (res.status === 'expired') {
        stopPolling()
        status.value = 'error'
        errorMessage.value = 'QRコードの有効期限が切れました。再生成してください。'
      }
    } catch {
      // ポーリングエラーは無視して継続
    }
  }, 3000)
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer)
    pollingTimer = null
  }
}

function reset() {
  stopPolling()
  registrationCode.value = ''
  qrDataUrl.value = ''
  status.value = 'idle'
  errorMessage.value = ''
}

onUnmounted(() => stopPolling())
</script>

<template>
  <div class="w-full max-w-md mx-auto">
    <!-- 既にアクティベート済み -->
    <div v-if="isDeviceActivated" class="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
      <p class="text-green-700 text-sm font-medium">この端末は登録済みです</p>
    </div>

    <!-- 未登録: 登録方法選択 -->
    <div v-else class="space-y-4">
      <!-- QR登録 -->
      <div class="bg-white rounded-xl shadow-sm p-6">
        <h3 class="text-sm font-medium text-gray-800 mb-2">QRコードで端末登録</h3>
        <p class="text-xs text-gray-500 mb-4">QRコードを表示して管理者にスキャンしてもらうと、この端末が登録されます。QRは10分間有効です。</p>

        <!-- 初期状態: QR生成ボタン -->
        <div v-if="status === 'idle' || status === 'error'" class="text-center space-y-3">
          <button
            class="px-6 py-3 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
            @click="startRegistration"
          >
            QRコードを表示
          </button>
          <p v-if="errorMessage" class="text-red-600 text-xs">{{ errorMessage }}</p>
        </div>

        <!-- QR生成中 -->
        <div v-else-if="status === 'generating'" class="text-center py-8">
          <span class="text-gray-500 text-sm">生成中...</span>
        </div>

        <!-- QR表示 + ポーリング中 -->
        <div v-else-if="status === 'polling'" class="text-center space-y-3">
          <img :src="qrDataUrl" alt="QR Code" class="mx-auto" />
          <p class="text-xs text-gray-600">管理者のスマホでこのQRコードをスキャンしてください</p>
          <p class="text-xs text-gray-400">コード: {{ registrationCode }}</p>
          <div class="flex items-center justify-center gap-2 text-blue-600">
            <span class="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            <span class="text-xs">承認待ち...</span>
          </div>
          <button class="text-xs text-gray-400 underline" @click="reset">キャンセル</button>
        </div>

        <!-- 承認完了 -->
        <div v-else-if="status === 'approved'" class="text-center py-4 space-y-3">
          <div class="text-green-600 text-lg font-bold">登録完了</div>
          <p class="text-sm text-gray-600">端末が正常に登録されました</p>
        </div>
      </div>

      <!-- Google OAuth フォールバック -->
      <div class="bg-gray-50 rounded-xl p-4 text-center">
        <p class="text-xs text-gray-500 mb-2">または管理者アカウントでログイン</p>
        <button
          class="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-white transition-colors"
          @click="loginWithGoogleRedirect()"
        >
          Google でログイン
        </button>
      </div>
    </div>
  </div>
</template>
