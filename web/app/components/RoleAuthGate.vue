<script setup lang="ts">
/**
 * 【セキュリティ要件】
 * - manager: NFC/社員番号 + 顔認証が必須。Google ログイン単独では通過不可。
 * - admin  : Google ログインで通過 (watch で即時認証)。
 *
 * 注意: Google ログインリンクは admin タブ専用。
 * manager タブでは表示しないこと (バイパス防止)。
 * (/login 後は /dashboard にリダイレクトされ顔認証が完全にスキップされるため)
 */
import type { FaceAuthResult } from '~/types'
import { getEmployeeByNfcId, getEmployeeByCode, getEmployeeById, updateDeviceLastLogin } from '~/utils/api'
import { checkFaceApproval } from '~/utils/face-approval'
import { employeeNotFoundByNfc, employeeNotFoundByCode } from '~/utils/employee-lookup-messages'

const props = defineProps<{
  requiredRole: 'manager' | 'admin'
}>()

const { isAuthenticated, deviceId } = useAuth()
const { setManagerId, loadFromDevice, authenticatedManagerId } = useManagerAuth()

// デバイスに保存された管理者情報を表示用に取得
const deviceManagerName = ref<string | null>(null)
onMounted(async () => {
  loadFromDevice()
  if (authenticatedManagerId.value) {
    try {
      const emp = await getEmployeeById(authenticatedManagerId.value)
      deviceManagerName.value = emp.name
    }
    catch { deviceManagerName.value = null }
  }
})
const { sync: faceSync, isSyncing: isFaceSyncing } = useFaceSync()

// 認証状態
const authState = ref<'pending' | 'authenticated' | 'denied'>('pending')

// admin は Google ログインで直接通過 (computed で reactive に判定)
const isGranted = computed(() =>
  authState.value === 'authenticated' ||
  (props.requiredRole === 'admin' && isAuthenticated.value)
)
const authenticatedEmployee = ref<{ id: string; name: string; role: string[] } | null>(null)
const errorMessage = ref<string | null>(null)

// NFC / 手動入力
const employeeId = ref('')
const employeeName = ref('')
const manualIdInput = ref('')
const useManualInput = ref(true)
const manualError = ref<string | null>(null)
const isSubmitting = ref(false)
const step = ref<'nfc' | 'face_auth'>('nfc')


// ロール階層チェック
function hasRole(employeeRole: string[]): boolean {
  if (props.requiredRole === 'manager') {
    return employeeRole.includes('manager') || employeeRole.includes('admin')
  }
  return employeeRole.includes('admin')
}


const roleLabel: Record<string, string> = {
  manager: '運行管理者',
  admin: 'システム管理者',
}

// NFC 読み取り
async function onNfcRead(nfcId: string) {
  if (isSubmitting.value) return
  isSubmitting.value = true
  errorMessage.value = null
  try {
    const emp = await getEmployeeByNfcId(nfcId)
    employeeId.value = emp.id
    employeeName.value = emp.name
    if (!hasRole(emp.role)) {
      errorMessage.value = `${emp.name}さんには${roleLabel[props.requiredRole]}の権限がありません (現在のロール: ${emp.role.join(', ')})`
      return
    }
    const approvalErr = checkFaceApproval(emp)
    if (approvalErr) { errorMessage.value = approvalErr; return }
    authenticatedEmployee.value = { id: emp.id, name: emp.name, role: emp.role }
    await faceSync()
    step.value = 'face_auth'
  } catch {
    errorMessage.value = employeeNotFoundByNfc(nfcId)
  } finally {
    isSubmitting.value = false
  }
}

// 手動入力
async function onManualSubmit() {
  const input = manualIdInput.value.trim()
  if (!input || isSubmitting.value) return
  isSubmitting.value = true
  manualError.value = null
  errorMessage.value = null
  try {
    const emp = await getEmployeeByCode(input)
    employeeId.value = emp.id
    employeeName.value = emp.name
    if (!hasRole(emp.role)) {
      errorMessage.value = `${emp.name}さんには${roleLabel[props.requiredRole]}の権限がありません (現在のロール: ${emp.role.join(', ')})`
      return
    }
    const approvalErr = checkFaceApproval(emp)
    if (approvalErr) { errorMessage.value = approvalErr; return }
    authenticatedEmployee.value = { id: emp.id, name: emp.name, role: emp.role }
    await faceSync()
    step.value = 'face_auth'
  } catch {
    manualError.value = employeeNotFoundByCode(input)
  } finally {
    isSubmitting.value = false
  }
}

// 顔認証完了
function onFaceAuthResult(result: FaceAuthResult) {
  if (result.verified) {
    if (employeeId.value) authorizeEmployee(employeeId.value)
    authState.value = 'authenticated'
    if (props.requiredRole === 'manager' && authenticatedEmployee.value) {
      setManagerId(authenticatedEmployee.value.id)
      // デバイス登録済みなら最終ログインを記録
      if (deviceId.value) {
        updateDeviceLastLogin(
          deviceId.value,
          authenticatedEmployee.value.id,
          authenticatedEmployee.value.name,
          authenticatedEmployee.value.role,
        ).catch(() => {})
      }
    }
  } else {
    errorMessage.value = '顔認証に失敗しました。もう一度お試しください。'
    step.value = 'nfc'
  }
}

// 指紋認証 (Android Bridge)
const {
  isFingerprintAvailable,
  isEmployeeAuthorized,
  authorizeEmployee,
  requestFingerprint: triggerFingerprint,
} = useFingerprint()

const canUseFingerprint = computed(() =>
  isFingerprintAvailable.value && employeeId.value && isEmployeeAuthorized(employeeId.value),
)

function requestFingerprint() {
  triggerFingerprint()
}

onMounted(() => {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail
    if (detail?.success) {
      onFaceAuthResult({ verified: true, similarity: 1.0 })
    }
  }
  window.addEventListener('fingerprint-result', handler)
  onUnmounted(() => window.removeEventListener('fingerprint-result', handler))
})

// リセット
function resetAuth() {
  setManagerId(null)
  authState.value = 'pending'
  authenticatedEmployee.value = null
  errorMessage.value = null
  employeeId.value = ''
  employeeName.value = ''
  manualIdInput.value = ''
  manualError.value = null
  useManualInput.value = true
  isSubmitting.value = false
  step.value = 'nfc'
}
</script>

<template>
  <!-- 認証済み → slot 表示 -->
  <div v-if="isGranted" class="flex flex-col flex-1">
    <!-- 認証者バナー -->
    <div v-if="authenticatedEmployee" class="bg-green-50 border-b border-green-200 px-4 py-1.5 text-center text-xs text-green-700">
      {{ authenticatedEmployee.name }} ({{ roleLabel[requiredRole] }}) としてログイン中
      <button class="ml-2 underline hover:text-green-900" @click="resetAuth">ログアウト</button>
    </div>
    <slot />
  </div>

  <!-- 未認証 → 認証ゲート -->
  <div v-else class="flex flex-col items-center w-full flex-1 overflow-y-auto p-4">
    <div class="w-full max-w-md">
      <div class="bg-white rounded-2xl p-6 shadow-sm">
        <h2 class="text-lg font-semibold text-gray-700 mb-2">{{ roleLabel[requiredRole] }}認証</h2>
        <p class="text-sm text-gray-500 mb-4">
          {{ roleLabel[requiredRole] }}機能にアクセスするには、ID + 顔認証が必要です。
        </p>

        <!-- デバイスに保存された管理者情報 -->
        <div v-if="deviceManagerName && requiredRole === 'manager'" class="mb-4 rounded-xl bg-blue-50 border border-blue-200 px-3 py-2 text-sm text-blue-700">
          登録済み管理者: <strong>{{ deviceManagerName }}</strong>
        </div>

        <!-- エラー -->
        <div v-if="errorMessage" class="bg-red-50 border border-red-200 rounded-xl p-3 mb-4 text-sm text-red-700">
          {{ errorMessage }}
        </div>

        <!-- 顔データ同期中 -->
        <div v-if="isFaceSyncing" class="flex items-center justify-center gap-2 py-6 text-gray-500">
          <svg class="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
          <span class="text-sm">顔データを同期中...</span>
        </div>

        <!-- Step 1: NFC / 手動入力 -->
        <div v-else-if="step === 'nfc'">
          <div v-if="!useManualInput">
            <NfcStatus @read="onNfcRead" />
            <button
              class="w-full mt-4 text-sm text-gray-500 hover:text-gray-700 underline"
              @click="useManualInput = true"
            >
              手動でIDを入力する
            </button>
          </div>
          <div v-else>
            <p class="text-sm text-gray-500 mb-4">社員番号を入力してください</p>
            <input
              v-model="manualIdInput"
              type="text"
              placeholder="社員番号 (例: 001)"
              class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              @keyup.enter="onManualSubmit"
            >
            <p v-if="manualError" class="mt-2 text-sm text-red-600">{{ manualError }}</p>
            <button
              :disabled="!manualIdInput.trim() || isSubmitting"
              class="w-full mt-4 px-6 py-3 bg-blue-600 text-white rounded-xl font-medium disabled:opacity-50 hover:bg-blue-700 transition-colors"
              @click="onManualSubmit"
            >
              {{ isSubmitting ? '確認中...' : '次へ' }}
            </button>
            <button
              class="w-full mt-2 text-sm text-gray-500 hover:text-gray-700 underline"
              @click="useManualInput = false"
            >
              NFC で読み取る
            </button>
          </div>
        </div>

        <!-- Step 2: 顔認証 -->
        <div v-else-if="step === 'face_auth'">
          <p class="text-sm text-gray-500 mb-4">{{ employeeName }}</p>
          <FaceAuth
            :employee-id="employeeId"
            mode="verify"
            @result="onFaceAuthResult"
          />
          <button
            v-if="canUseFingerprint"
            class="w-full mt-4 px-4 py-3 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2"
            @click="requestFingerprint"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11c0-1.1.9-2 2-2s2 .9 2 2v3c0 1.66-1.34 3-3 3"/><path d="M8 15V11c0-2.21 1.79-4 4-4s4 1.79 4 4"/><path d="M2 11c0-5.52 4.48-10 10-10s10 4.48 10 10v3c0 3.31-2.69 6-6 6"/><path d="M12 11v4c0 .55-.45 1-1 1"/><path d="M6 11c0-3.31 2.69-6 6-6s6 2.69 6 6v2"/></svg>
            指紋認証で本人確認
          </button>
          <button
            class="w-full mt-4 text-sm text-gray-500 hover:text-gray-700 underline"
            @click="step = 'nfc'"
          >
            戻る
          </button>
        </div>

        <!-- Google ログインリンク (admin のみ表示: manager では顔認証バイパス防止) -->
        <div v-if="requiredRole === 'admin'" class="mt-6 pt-4 border-t border-gray-200 text-center">
          <NuxtLink to="/login" class="text-blue-600 hover:underline text-sm">
            Google アカウントでログイン
          </NuxtLink>
        </div>
      </div>
    </div>
  </div>
</template>
