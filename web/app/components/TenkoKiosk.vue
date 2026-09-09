<script setup lang="ts">
import type { FaceAuthResult, MeasurementResult, SubmitMedicalData } from '~/types'
import { getEmployeeByNfcId, getEmployeeByCode } from '~/utils/api'
import { checkFaceApproval } from '~/utils/face-approval'

const props = defineProps<{
  demoMode?: boolean
  remoteMode?: boolean
  landscape?: boolean
}>()

// シングルトン再呼出で共有状態取得
const { isDeviceActivated } = useAuth()
const { isSyncing: isFaceSyncing } = useFaceSync()

// デモモード (prop 優先、なければ URL クエリ)
const { isDemoMode: isDemoModeFromUrl } = useDemoMode()
const isDemoMode = computed(() => props.demoMode || isDemoModeFromUrl.value)

// --- 遠隔点呼 WebRTC (インスタンス生成のみ; watch は useTenkoKiosk 後に設定) ---
const config = useRuntimeConfig()
const webRtc = useWebRtc('device')
const camera = useCamera()
let audioStream: MediaStream | null = null  // マイク音声 (WebRTC用)
const combinedStream = ref<MediaStream | null>(null)  // 映像+音声 (TenkoVideoCall用)

// 点呼キオスク状態管理
const {
  step, employeeId, employeeName, pendingSchedules, selectedSchedule, session,
  error, isLoading, safetyJudgment, tenkoType, isPreOperation,
  stepLabels, currentStepIndex,
  identifyEmployee, selectSchedule, onFaceAuthComplete,
  onAlcoholResult, onMedicalSubmit, onSelfDeclarationSubmit,
  onDailyInspectionSubmit, carryingItems, loadCarryingItems, onCarryingItemsSubmit,
  onInstructionConfirm, onReportSubmit,
  reset,
} = useTenkoKiosk({ remoteMode: props.remoteMode })

// carrying_items ステップに入ったら携行品マスタをロード
watch(() => step.value, (s) => {
  if (s === 'carrying_items') loadCarryingItems()
})

// アルコール測定完了後 (instruction / report ステップ) に WebRTC 接続
watch(
  () => step.value,
  async (newStep) => {
    if (!props.remoteMode || !session.value?.id) return
    if (newStep === 'instruction' || newStep === 'report') {
      try {
        await camera.start('user')
        // カメラ映像 + マイク音声を合成して送信
        let streamToSend = camera.stream.value
        try {
          audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
          if (streamToSend) {
            streamToSend = new MediaStream([
              ...streamToSend.getVideoTracks(),
              ...audioStream.getAudioTracks(),
            ])
          }
        }
        catch {
          // マイク拒否時はビデオのみで続行
        }
        combinedStream.value = streamToSend
        await webRtc.connect(config.public.signalingUrl, session.value.id)
        if (streamToSend) {
          await webRtc.startStreaming(streamToSend)
        }
      }
      catch {
        // カメラ/WebRTC 失敗は点呼フローをブロックしない
      }
    }
  }
)

// 管理者が切断 → オーバーレイ表示
const hadPeerConnected = ref(false)
watch(
  () => webRtc.isPeerConnected.value,
  (connected) => {
    if (!props.remoteMode) return
    if (connected) hadPeerConnected.value = true
  }
)
const isDisconnected = computed(
  () => props.remoteMode && hadPeerConnected.value && !webRtc.isPeerConnected.value
)

async function reconnect() {
  if (!session.value?.id) return
  try {
    await webRtc.connect(config.public.signalingUrl, session.value.id)
    if (camera.stream.value) await webRtc.startStreaming(camera.stream.value)
  } catch {
    // 失敗しても点呼フローはブロックしない
  }
}

// BLE Medical Gateway (体温・血圧)
const {
  latestTemperature: bleTemperature,
  latestBloodPressure: bleBloodPressure,
} = useBleGateway()

// 医療ステップ: BLE / 手動入力 タブ
const medicalInputTab = ref<'ble' | 'manual'>('ble')
watch(isDemoMode, (v) => {
  if (v) medicalInputTab.value = 'manual'
}, { immediate: true })

// --- NFC / 手動入力 ---
const manualIdInput = ref('')
const useManualInput = ref(false)
const manualError = ref<string | null>(null)

async function onNfcRead(nfcId: string) {
  try {
    const emp = await getEmployeeByNfcId(nfcId)
    const approvalErr = checkFaceApproval(emp)
    if (approvalErr) { error.value = approvalErr; return }
    await identifyEmployee(emp.id, emp.name)
  } catch {
    error.value = `乗務員が見つかりません (NFC ID: ${nfcId})`
  }
}

async function onManualSubmit() {
  const input = manualIdInput.value.trim()
  if (!input) return
  manualError.value = null
  try {
    const emp = await getEmployeeByCode(input)
    const approvalErr = checkFaceApproval(emp)
    if (approvalErr) { error.value = approvalErr; return }
    await identifyEmployee(emp.id, emp.name)
  } catch {
    manualError.value = `社員番号「${input}」の乗務員が見つかりません`
  }
}

// --- 顔認証結果 ---
function onFaceAuthResult(result: FaceAuthResult) {
  if (result.verified) {
    if (employeeId.value) authorizeEmployee(employeeId.value)
    onFaceAuthComplete(result)
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
      onFaceAuthComplete({ verified: true, similarity: 1.0 })
    }
  }
  window.addEventListener('fingerprint-result', handler)
  onUnmounted(() => window.removeEventListener('fingerprint-result', handler))
})

// --- アルコール測定結果 ---
function onMeasurementResult(result: MeasurementResult) {
  const alcoholResult = result.resultType === 'normal' ? 'pass' : 'fail'
  onAlcoholResult(alcoholResult, result.alcoholValue)
}

// --- BLE 医療データ → 送信 ---
function onMedicalNext() {
  medicalInputSource.value = 'ble'
  const data: SubmitMedicalData = {}
  if (bleTemperature.value) {
    data.temperature = bleTemperature.value.value
    data.medical_measured_at = bleTemperature.value.measuredAt.toISOString()
  }
  if (bleBloodPressure.value) {
    data.systolic = bleBloodPressure.value.systolic
    data.diastolic = bleBloodPressure.value.diastolic
    data.pulse = bleBloodPressure.value.pulse
    if (!data.medical_measured_at) {
      data.medical_measured_at = bleBloodPressure.value.measuredAt.toISOString()
    }
  }
  onMedicalSubmit(data)
}

function onMedicalSkip() {
  medicalInputSource.value = null
  onMedicalSubmit({})
}

// 医療データ入力元トラッキング
const medicalInputSource = ref<'ble' | 'manual' | null>(null)

// 手動入力からの医療データ送信
function onManualMedicalSubmit(data: SubmitMedicalData) {
  medicalInputSource.value = 'manual'
  onMedicalSubmit(data)
}

// --- リセット時に手動入力もクリア ---
function handleReset() {
  reset()
  manualIdInput.value = ''
  manualError.value = null
  useManualInput.value = false
  medicalInputSource.value = null
  medicalInputTab.value = isDemoMode.value ? 'manual' : 'ble'
  if (props.remoteMode) {
    webRtc.disconnect()
    camera.stop()
    audioStream?.getTracks().forEach(t => t.stop())
    audioStream = null
    combinedStream.value = null
  }
}

onUnmounted(() => {
  if (props.remoteMode) {
    webRtc.disconnect()
    camera.stop()
    audioStream?.getTracks().forEach(t => t.stop())
    audioStream = null
    combinedStream.value = null
  }
})
</script>

<template>
  <div :class="[
    'w-full flex-1 overflow-y-auto p-4',
    landscape ? 'flex gap-4 max-w-4xl mx-auto' : 'flex flex-col items-center'
  ]">
    <!-- 左列 (横画面) / 上部 (縦画面): バナー + ステップ -->
    <div :class="landscape ? 'w-2/5 flex flex-col shrink-0' : 'w-full flex flex-col items-center'">
      <!-- 遠隔点呼 ビデオ通話 -->
      <ClientOnly>
        <div v-if="remoteMode && (step === 'instruction' || step === 'report' || step === 'completed')" :class="['w-full mb-4', landscape ? '' : 'max-w-md']">
          <TenkoVideoCall
            :local-stream="combinedStream"
            :remote-stream="webRtc.remoteStream.value"
            :is-peer-connected="webRtc.isPeerConnected.value"
            :is-connected="webRtc.isConnected.value"
          />
          <!-- 切断時ボタン -->
          <div v-if="isDisconnected" class="flex gap-2 mt-2">
            <button
              class="flex-1 py-1.5 text-sm rounded-lg bg-blue-500 hover:bg-blue-400 text-white font-medium"
              @click="reconnect"
            >
              再接続
            </button>
            <button
              class="flex-1 py-1.5 text-sm rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-700 font-medium"
              @click="handleReset"
            >
              終了
            </button>
          </div>
        </div>
      </ClientOnly>

      <!-- 遠隔点呼バナー -->
      <ClientOnly>
        <div
          v-if="remoteMode"
          :class="['w-full bg-blue-50 border border-blue-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-blue-700 font-medium', landscape ? '' : 'max-w-md']"
        >
          遠隔点呼モード — 運行管理者がビデオ通話で確認しています
        </div>
      </ClientOnly>

      <!-- デモモードバナー -->
      <ClientOnly>
        <div
          v-if="isDemoMode"
          :class="['w-full bg-purple-50 border border-purple-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-purple-700 font-medium', landscape ? '' : 'max-w-md']"
        >
          デモモード — 実機不要で点呼フローを体験できます
        </div>
      </ClientOnly>

      <!-- デモ用点呼予定作成 (NFCステップのみ表示) -->
      <ClientOnly>
        <DemoScheduleCreator v-if="isDemoMode && !remoteMode && step === 'nfc'" :class="['w-full mb-4', landscape ? '' : 'max-w-md']" />
      </ClientOnly>

      <!-- 端末未アクティベート警告 -->
      <ClientOnly>
        <div
          v-if="!isDeviceActivated"
          :class="['w-full bg-red-50 border border-red-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-red-700', landscape ? '' : 'max-w-md']"
        >
          端末未登録 — <NuxtLink to="/login" class="underline font-medium">管理者ログイン</NuxtLink>で端末を登録してください
        </div>
      </ClientOnly>

      <!-- 顔データ同期中 -->
      <div
        v-if="isFaceSyncing"
        :class="['w-full bg-green-50 border border-green-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-green-700', landscape ? '' : 'max-w-md']"
      >
        顔データ同期中...
      </div>

      <header :class="['w-full text-center', landscape ? 'py-2' : 'max-w-md py-6']">
        <h1 :class="['font-bold text-gray-800', landscape ? 'text-lg' : 'text-2xl']">{{ remoteMode ? '遠隔点呼' : '自動点呼' }}</h1>
        <p v-if="tenkoType" class="mt-1 text-sm">
          <span
            class="px-2 py-0.5 rounded text-xs font-bold"
            :class="isPreOperation ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'"
          >
            {{ isPreOperation ? '業務前' : '業務後' }}
          </span>
        </p>
        <p v-if="employeeName && step !== 'nfc'" class="mt-1 text-sm font-medium text-gray-600">{{ employeeName }}</p>

        <!-- ステップインジケーター -->
        <div v-if="step !== 'nfc'" :class="['flex items-center mt-3 flex-wrap gap-y-1', landscape ? 'justify-center gap-x-0.5' : 'justify-center']">
          <template v-for="(s, i) in stepLabels" :key="i">
            <div
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap"
              :class="{
                'bg-blue-600 text-white': i === currentStepIndex,
                'bg-green-500 text-white': i < currentStepIndex,
                'bg-gray-200 text-gray-400': i > currentStepIndex,
              }"
            >
              <svg v-if="i < currentStepIndex" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              {{ s }}
            </div>
            <svg
              v-if="i < stepLabels.length - 1"
              class="w-4 h-4 mx-1 shrink-0"
              :class="i < currentStepIndex ? 'text-green-400' : 'text-gray-300'"
              fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </template>
        </div>
      </header>

      <!-- リセットリンク (横画面時は左列に配置) -->
      <div v-if="landscape && step !== 'nfc'" class="mt-auto pt-2">
        <div class="flex justify-center">
          <button class="text-gray-500 hover:text-gray-700 text-sm" @click="handleReset">
            最初からやり直す
          </button>
        </div>
      </div>
    </div>

    <!-- 右列 (横画面) / メインコンテンツ (縦画面) -->
    <main :class="['w-full flex-1', landscape ? 'min-h-0 overflow-y-auto' : 'max-w-md']">
      <!-- グローバルエラー -->
      <div v-if="error" class="bg-red-50 border border-red-200 rounded-xl p-3 mb-4 text-sm text-red-700">
        {{ error }}
      </div>

      <!-- ローディング -->
      <div v-if="isLoading" class="flex justify-center py-8">
        <span class="w-6 h-6 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
      </div>

      <!-- Step 1: NFC / 手動入力 -->
      <div v-else-if="step === 'nfc'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">乗務員ID</h2>

          <div v-if="!useManualInput && !isDemoMode">
            <NfcStatus @read="onNfcRead" />
            <button
              class="w-full mt-4 text-sm text-gray-500 hover:text-gray-700 underline"
              @click="useManualInput = true"
            >
              手動でIDを入力する
            </button>
          </div>

          <div v-else>
            <p class="text-sm text-gray-500 mb-4">
              {{ isDemoMode ? 'デモ: 社員番号を入力してください' : '社員番号を入力してください' }}
            </p>
            <input
              v-model="manualIdInput"
              type="text"
              placeholder="社員番号 (例: 001)"
              class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              @keyup.enter="onManualSubmit"
            >
            <p v-if="manualError" class="mt-2 text-sm text-red-600">{{ manualError }}</p>
            <button
              :disabled="!manualIdInput.trim()"
              class="w-full mt-4 px-6 py-3 bg-blue-600 text-white rounded-xl font-medium disabled:opacity-50 hover:bg-blue-700 transition-colors"
              @click="onManualSubmit"
            >
              次へ
            </button>
            <button
              v-if="!isDemoMode"
              class="w-full mt-2 text-sm text-gray-500 hover:text-gray-700 underline"
              @click="useManualInput = false"
            >
              NFC で読み取る
            </button>
          </div>
        </div>
      </div>

      <!-- Step 2: スケジュール選択 -->
      <div v-else-if="step === 'schedule_select'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">点呼予定選択</h2>
          <TenkoScheduleSelect
            :schedules="pendingSchedules"
            :employee-name="employeeName"
            @select="selectSchedule"
          />
        </div>
      </div>

      <!-- Step 3: 顔認証 -->
      <div v-else-if="step === 'face_auth'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">顔認証</h2>
          <FaceAuth
            :employee-id="employeeId"
            mode="verify"
            :demo-mode="isDemoMode"
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
        </div>
      </div>

      <!-- Step 4: アルコール測定 -->
      <div v-else-if="step === 'alcohol'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">アルコール測定</h2>
          <AlcMeasurement
            :employee-id="employeeId"
            :demo-mode="isDemoMode"
            @result="onMeasurementResult"
          />
        </div>
      </div>

      <!-- Step 5: 体温・血圧 (業務前のみ) -->
      <div v-else-if="step === 'medical'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-2">体温・血圧</h2>

          <!-- タブ切替 (デモ時は BLE タブ非表示) -->
          <div v-if="!isDemoMode" class="flex gap-1 bg-gray-100 rounded-lg p-1 mb-4">
            <button
              class="flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
              :class="medicalInputTab === 'ble' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
              @click="medicalInputTab = 'ble'"
            >
              BLE機器
            </button>
            <button
              class="flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
              :class="medicalInputTab === 'manual' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
              @click="medicalInputTab = 'manual'"
            >
              手動入力
            </button>
          </div>

          <BleStatus
            v-if="medicalInputTab === 'ble'"
            @next="onMedicalNext"
            @skip="onMedicalSkip"
          />
          <ManualMedicalInput
            v-else
            @submit="onManualMedicalSubmit"
            @skip="onMedicalSkip"
          />
        </div>
      </div>

      <!-- Step 6: 自己申告 (業務前のみ) -->
      <div v-else-if="step === 'self_declaration'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">自己申告</h2>
          <TenkoSelfDeclaration @submit="onSelfDeclarationSubmit" />
        </div>
      </div>

      <!-- Step 7: 日常点検 (業務前のみ) -->
      <div v-else-if="step === 'daily_inspection'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">日常点検</h2>
          <TenkoDailyInspection @submit="onDailyInspectionSubmit" />
        </div>
      </div>

      <!-- Step 7.5: 携行品チェック -->
      <div v-else-if="step === 'carrying_items'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <TenkoCarryingItemsCheck
            v-if="carryingItems.length > 0"
            :items="carryingItems"
            @submit="onCarryingItemsSubmit"
          />
          <div v-else class="text-center py-4 text-gray-400">携行品マスタ未登録</div>
        </div>
      </div>

      <!-- Step 8: 指示確認 -->
      <div v-else-if="step === 'instruction'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">指示事項</h2>
          <TenkoInstruction
            :instruction="selectedSchedule?.instruction ?? null"
            :manager-name="selectedSchedule?.responsible_manager_name ?? ''"
            @confirm="onInstructionConfirm"
          />
        </div>
      </div>

      <!-- Step 9: 運行報告 (業務後のみ) -->
      <div v-else-if="step === 'report'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">運行報告</h2>
          <TenkoOperationReport @submit="onReportSubmit" />
        </div>
      </div>

      <!-- 完了 -->
      <div v-else-if="step === 'completed' && session" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <TenkoCompleted
            :session="session"
            :employee-name="employeeName"
            @reset="handleReset"
          />
          <!-- 医療データ入力元バッジ (業務前のみ) -->
          <div
            v-if="medicalInputSource && isPreOperation && (session.temperature || session.systolic)"
            class="mt-3 text-center text-xs"
          >
            <span
              class="inline-flex items-center gap-1 px-2 py-1 rounded-full"
              :class="medicalInputSource === 'manual' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'"
            >
              体温・血圧: {{ medicalInputSource === 'manual' ? '手動入力' : 'BLE機器' }}
            </span>
          </div>
        </div>
      </div>

      <!-- 中断 (安全判定失敗 etc.) -->
      <div v-else-if="step === 'interrupted'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <TenkoInterrupted
            :employee-name="employeeName"
            :safety-judgment="safetyJudgment"
            @reset="handleReset"
          />
        </div>
      </div>

      <!-- キャンセル (アルコール検知 / 日常点検NG) -->
      <div v-else-if="step === 'cancelled'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <TenkoInterrupted
            :employee-name="employeeName"
            :reason="session?.cancel_reason ?? '点呼がキャンセルされました'"
            @reset="handleReset"
          />
        </div>
      </div>
    </main>

    <!-- ナビゲーション (縦画面時のみ。横画面時は左列に配置) -->
    <footer v-if="!landscape" class="w-full max-w-md py-4">
      <div class="flex justify-center gap-4">
        <button
          v-if="step !== 'nfc'"
          class="text-gray-500 hover:text-gray-700 text-sm"
          @click="handleReset"
        >
          最初からやり直す
        </button>
      </div>
    </footer>
  </div>
</template>
