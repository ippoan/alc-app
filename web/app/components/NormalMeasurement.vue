<script setup lang="ts">
import type { FaceAuthResult, MeasurementResult } from '~/types'
import { getEmployeeByNfcId, getEmployeeByCode, startMeasurement, updateMeasurement, uploadFacePhoto, uploadBlowVideo } from '~/utils/api'
import { saveVideo, markVideoUploaded, getPendingVideos, cleanupOldVideos } from '~/utils/video-store'
import { checkLicenseExpiry, formatExpiryDate, type LicenseExpiryStatus } from '~/utils/license'
import { checkFaceApproval } from '~/utils/face-approval'
import { employeeNotFoundByNfc, employeeNotFoundByCode } from '~/utils/employee-lookup-messages'

const { isDemoMode: isDemoModeFromUrl } = useDemoMode()

const props = defineProps<{
  demoMode?: boolean
  landscape?: boolean
}>()

const isDemoMode = computed(() => props.demoMode || isDemoModeFromUrl.value)

const step = ref<'nfc' | 'face_auth' | 'medical' | 'measuring' | 'result'>('nfc')
const employeeId = ref('')
const authResult = ref<FaceAuthResult | null>(null)
const measurementResult = ref<MeasurementResult | null>(null)
const faceSnapshot = ref<Blob | null>(null)

const saveError = ref<string | null>(null)
const isSaving = ref(false)
const saveStatus = ref<'saved' | 'queued' | null>(null)

// 免許証有効期限
const licenseExpiryDate = ref<Date | null>(null)
const licenseExpiryStatus = ref<LicenseExpiryStatus | null>(null)

// オフライン同期
const { isOnline, pending, isSyncing, save: offlineSave, syncQueue } = useOfflineSync()

// シングルトン再呼出で共有状態取得
const { isDeviceActivated } = useAuth()
const { isSyncing: isFaceSyncing, sync: faceSync } = useFaceSync()

// 手動入力フォールバック
const manualIdInput = ref('')
const useManualInput = ref(false)

// 測定レコード早期作成
const activeMeasurementId = ref<string | null>(null)
const facePhotoUploaded = ref(false)
const faceVerified = ref<boolean | null>(null)

// 録画 (measuring ステップ用)
const {
  stream: measuringStream,
  videoRef: measuringVideoRef,
  isActive: isMeasuringCameraActive,
  start: startMeasuringCamera,
  stop: stopMeasuringCamera,
} = useCamera()
const { isRecording, startRecording, stopRecording } = useVideoRecorder()
const recordedVideoBlob = ref<Blob | null>(null)
const videoStoreId = ref<string | null>(null)
const videoUploadStatus = ref<'pending' | 'uploading' | 'uploaded' | 'failed' | null>(null)

/** 測定開始レコードを作成 (best-effort: 失敗しても測定フローは続行) */
async function tryStartMeasurement(empId: string) {
  console.log('[Measurement] tryStartMeasurement called, empId:', empId, 'isOnline:', isOnline.value)
  if (!isOnline.value) return
  try {
    const m = await startMeasurement(empId)
    activeMeasurementId.value = m.id
    console.log('[Measurement] startMeasurement success, id:', m.id)
  } catch (e) {
    console.warn('[Measurement] startMeasurement failed:', e)
    activeMeasurementId.value = null
  }
}

// NFC 読み取り → employee UUID を解決
const employeeName = ref('')
const approvalError = ref<string | null>(null)
async function onNfcRead(nfcId: string, expiryDate?: Date) {
  approvalError.value = null
  if (expiryDate) {
    licenseExpiryDate.value = expiryDate
    licenseExpiryStatus.value = checkLicenseExpiry(expiryDate)
  }
  try {
    const emp = await getEmployeeByNfcId(nfcId)
    const err = checkFaceApproval(emp)
    if (err) { approvalError.value = err; return }
    employeeId.value = emp.id
    employeeName.value = emp.name
    await tryStartMeasurement(emp.id)
    await faceSync()
    step.value = 'face_auth'
  } catch {
    const msg = employeeNotFoundByNfc(nfcId)
    console.error(msg)
    approvalError.value = msg
  }
}

// 手動入力 (社員番号で検索)
const manualError = ref<string | null>(null)
async function onManualSubmit() {
  const input = manualIdInput.value.trim()
  if (!input) return
  manualError.value = null
  approvalError.value = null
  try {
    const emp = await getEmployeeByCode(input)
    const err = checkFaceApproval(emp)
    if (err) { approvalError.value = err; return }
    employeeId.value = emp.id
    employeeName.value = emp.name
    await tryStartMeasurement(emp.id)
    await faceSync()
    step.value = 'face_auth'
  } catch {
    manualError.value = employeeNotFoundByCode(input)
  }
}

// BLE Medical Gateway
const {
  latestTemperature: bleTemperature,
  latestBloodPressure: bleBloodPressure,
} = useBleGateway()

// 医療ステップ: BLE / 手動入力 タブ
const medicalInputTab = ref<'ble' | 'manual'>('ble')
watch(isDemoMode, (v) => {
  if (v) medicalInputTab.value = 'manual'
}, { immediate: true })

// 手動入力の医療データ (BLE未接続フォールバック用)
const manualMedicalData = ref<import('~/types').SubmitMedicalData | null>(null)
const medicalInputSource = ref<'ble' | 'manual' | null>(null)

// 顔認証結果
function onFaceAuthResult(result: FaceAuthResult) {
  authResult.value = result
  if (result.verified) {
    faceVerified.value = true
    if (result.snapshot) {
      faceSnapshot.value = result.snapshot
    }
    // 顔認証成功 → この端末と社員を紐付け（次回から指紋認証可能に）
    if (employeeId.value) authorizeEmployee(employeeId.value)
    step.value = 'medical'

    // 顔写真 + face_verified を started レコードに記録（best-effort）
    console.log('[Measurement] onFaceAuth: activeMeasurementId:', activeMeasurementId.value, 'hasSnapshot:', !!result.snapshot)
    if (activeMeasurementId.value) {
      if (result.snapshot) {
        uploadFacePhoto(result.snapshot)
          .then(url => {
            console.log('[Measurement] face photo uploaded:', url)
            facePhotoUploaded.value = true
            return updateMeasurement(activeMeasurementId.value!, { face_photo_url: url, face_verified: true })
          })
          .then(() => console.log('[Measurement] face photo + face_verified saved to record'))
          .catch(e => console.error('[Measurement] face photo upload/save failed:', e))
      } else {
        updateMeasurement(activeMeasurementId.value, { face_verified: true })
          .catch(e => console.error('[Measurement] face_verified update failed:', e))
      }
    }
  }
}

// 顔認証スキップ
function onFaceAuthSkip() {
  faceVerified.value = false
  step.value = 'medical'

  // face_verified = false を started レコードに記録（best-effort）
  if (activeMeasurementId.value) {
    updateMeasurement(activeMeasurementId.value, { face_verified: false })
      .catch(e => console.error('[Measurement] face_verified skip update failed:', e))
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
      faceVerified.value = true
      step.value = 'medical'
      if (activeMeasurementId.value) {
        updateMeasurement(activeMeasurementId.value, { face_verified: true })
          .catch(e => console.error('[Measurement] fingerprint face_verified update failed:', e))
      }
    }
  }
  window.addEventListener('fingerprint-result', handler)
  onUnmounted(() => window.removeEventListener('fingerprint-result', handler))

  // 録画: 7日超のローカル録画を削除 + 未アップロード分をリトライ
  cleanupOldVideos(7).catch(() => {})
  getPendingVideos().then(pending => {
    for (const v of pending) {
      if (!v.measurementId) continue
      const mId = v.measurementId
      uploadBlowVideo(v.videoBlob)
        .then(url => {
          console.log('[VideoRetry] Uploaded pending video:', v.id)
          updateMeasurement(mId, { video_url: url }).catch(() => {})
          markVideoUploaded(v.id).catch(() => {})
        })
        .catch(() => console.warn('[VideoRetry] Failed:', v.id))
    }
  }).catch(() => {})
})

// BLE 体温・血圧を取得時に即レコード更新（best-effort）
watch(bleTemperature, (t) => {
  console.log('[Measurement] bleTemperature changed:', t?.value, 'activeMeasurementId:', activeMeasurementId.value)
  if (t && activeMeasurementId.value) {
    updateMeasurement(activeMeasurementId.value, {
      temperature: t.value,
      medical_measured_at: t.measuredAt.toISOString(),
    })
      .then(() => console.log('[Measurement] temperature saved'))
      .catch(e => console.error('[Measurement] temperature update failed:', e))
  }
})

watch(bleBloodPressure, (bp) => {
  console.log('[Measurement] bleBloodPressure changed:', bp, 'activeMeasurementId:', activeMeasurementId.value)
  if (bp && activeMeasurementId.value) {
    updateMeasurement(activeMeasurementId.value, {
      systolic: bp.systolic,
      diastolic: bp.diastolic,
      pulse: bp.pulse,
      medical_measured_at: bp.measuredAt.toISOString(),
    })
      .then(() => console.log('[Measurement] blood pressure saved'))
      .catch(e => console.error('[Measurement] blood pressure update failed:', e))
  }
})

// BLE ステップ → 次へ or スキップ
function onMedicalNext() {
  medicalInputSource.value = 'ble'
  step.value = 'measuring'
}
function onMedicalSkip() {
  medicalInputSource.value = null
  step.value = 'measuring'
}

// 手動入力 → 次へ
function onManualMedicalSubmit(data: import('~/types').SubmitMedicalData) {
  manualMedicalData.value = data
  medicalInputSource.value = 'manual'
  step.value = 'measuring'
}

// measuring ステップでカメラ起動/停止
watch(step, async (s, prev) => {
  if (s === 'measuring') {
    try {
      await startMeasuringCamera('user')
      console.log('[Measurement] Recording camera started')
      // デモモードではすぐに録画開始 (FC-1200 state 変化がないため)
      if (isDemoMode.value && measuringStream.value) {
        startRecording(measuringStream.value)
      }
    } catch (e) {
      console.warn('[Measurement] Recording camera failed:', e)
    }
  } else if (prev === 'measuring') {
    stopMeasuringCamera()
  }
})

// AlcMeasurement の状態変化 → 録画開始/停止
function onAlcStateChange(alcState: string) {
  if (alcState === 'blow_waiting' && measuringStream.value && !isRecording.value) {
    startRecording(measuringStream.value)
  }
}

// FC-1200 測定結果 → BLE 医療データ / 手動入力データをマージ → API に保存
async function onMeasurementResult(result: MeasurementResult) {
  // BLE Medical Gateway のデータをマージ
  if (bleTemperature.value) {
    result.temperature = bleTemperature.value.value
  }
  if (bleBloodPressure.value) {
    result.systolic = bleBloodPressure.value.systolic
    result.diastolic = bleBloodPressure.value.diastolic
    result.pulse = bleBloodPressure.value.pulse
  }
  // BLE データがない場合は手動入力データをマージ
  if (!bleTemperature.value && manualMedicalData.value?.temperature !== undefined) {
    result.temperature = manualMedicalData.value.temperature
  }
  if (!bleBloodPressure.value && manualMedicalData.value) {
    if (manualMedicalData.value.systolic !== undefined) result.systolic = manualMedicalData.value.systolic
    if (manualMedicalData.value.diastolic !== undefined) result.diastolic = manualMedicalData.value.diastolic
    if (manualMedicalData.value.pulse !== undefined) result.pulse = manualMedicalData.value.pulse
  }
  if (manualMedicalData.value?.medical_measured_at && !bleTemperature.value && !bleBloodPressure.value) {
    result.medicalMeasuredAt = new Date(manualMedicalData.value.medical_measured_at)
  }
  if (bleTemperature.value || bleBloodPressure.value) {
    const times = [
      bleTemperature.value?.measuredAt,
      bleBloodPressure.value?.measuredAt,
    ].filter((t): t is Date => t !== undefined)
    if (times.length > 0) {
      result.medicalMeasuredAt = times.sort((a, b) => b.getTime() - a.getTime())[0]
    }
  }

  measurementResult.value = result
  step.value = 'result'

  // 録画停止 + ローカル保存
  const videoBlob = await stopRecording()
  if (videoBlob) {
    recordedVideoBlob.value = videoBlob
    const vid = crypto.randomUUID()
    videoStoreId.value = vid
    saveVideo(vid, videoBlob, employeeId.value, activeMeasurementId.value || undefined)
      .catch(e => console.warn('[Measurement] video local save failed:', e))
    console.log(`[Measurement] Video recorded: ${(videoBlob.size / 1024).toFixed(0)}KB`)
  }
  stopMeasuringCamera()

  isSaving.value = true
  saveError.value = null
  saveStatus.value = null
  try {
    console.log('[Measurement] activeMeasurementId:', activeMeasurementId.value, 'isOnline:', isOnline.value)
    if (activeMeasurementId.value && isOnline.value) {
      // started レコードを completed に更新
      let facePhotoUrl: string | undefined
      if (faceSnapshot.value && !facePhotoUploaded.value) {
        facePhotoUrl = await uploadFacePhoto(faceSnapshot.value)
      }
      const updateData = {
        status: 'completed',
        alcohol_value: result.alcoholValue,
        result_type: result.resultType,
        device_use_count: result.deviceUseCount,
        face_photo_url: facePhotoUrl || result.facePhotoUrl,
        measured_at: result.measuredAt.toISOString(),
        temperature: result.temperature,
        systolic: result.systolic,
        diastolic: result.diastolic,
        pulse: result.pulse,
        medical_measured_at: result.medicalMeasuredAt?.toISOString(),
        face_verified: faceVerified.value,
        medical_manual_input: medicalInputSource.value === 'manual' ? true : undefined,
      }
      console.log('[Measurement] updateMeasurement PUT data:', JSON.stringify(updateData))
      await updateMeasurement(activeMeasurementId.value, updateData)
      console.log('[Measurement] updateMeasurement success')
      saveStatus.value = 'saved'

      // 録画をバックグラウンドでアップロード
      if (recordedVideoBlob.value && activeMeasurementId.value) {
        const mId = activeMeasurementId.value
        const vId = videoStoreId.value
        videoUploadStatus.value = 'uploading'
        uploadBlowVideo(recordedVideoBlob.value)
          .then(url => {
            console.log('[Measurement] Video uploaded:', url)
            videoUploadStatus.value = 'uploaded'
            updateMeasurement(mId, { video_url: url }).catch(() => {})
            if (vId) markVideoUploaded(vId).catch(() => {})
          })
          .catch(e => {
            console.warn('[Measurement] Video upload failed (will retry later):', e)
            videoUploadStatus.value = 'failed'
          })
      } else if (recordedVideoBlob.value) {
        videoUploadStatus.value = 'pending'
      }
    } else {
      // オフラインまたは activeMeasurementId なし → 従来のフロー
      console.log('[Measurement] fallback to offlineSave')
      saveStatus.value = await offlineSave(result, faceSnapshot.value || undefined, activeMeasurementId.value || undefined, videoStoreId.value || undefined)
      if (recordedVideoBlob.value) videoUploadStatus.value = 'pending'
    }
  } catch (e) {
    // 更新失敗時はオフラインキューにフォールバック
    console.error('[Measurement] updateMeasurement failed:', e)
    try {
      saveStatus.value = await offlineSave(result, faceSnapshot.value || undefined, activeMeasurementId.value || undefined, videoStoreId.value || undefined)
      if (recordedVideoBlob.value) videoUploadStatus.value = 'pending'
    } catch (e2) {
      saveError.value = e2 instanceof Error ? e2.message : '保存エラー'
      console.warn('測定結果の保存に失敗:', e2)
    }
  } finally {
    isSaving.value = false
  }
}

// リセット
function reset() {
  step.value = 'nfc'
  employeeId.value = ''
  employeeName.value = ''
  manualIdInput.value = ''
  manualError.value = null
  useManualInput.value = false
  authResult.value = null
  measurementResult.value = null
  faceSnapshot.value = null
  saveError.value = null
  saveStatus.value = null
  isSaving.value = false
  licenseExpiryDate.value = null
  licenseExpiryStatus.value = null
  activeMeasurementId.value = null
  facePhotoUploaded.value = false
  faceVerified.value = null
  manualMedicalData.value = null
  medicalInputSource.value = null
  recordedVideoBlob.value = null
  videoStoreId.value = null
  videoUploadStatus.value = null
  stopMeasuringCamera()
}

const steps = ['NFC', '顔認証', '体温・血圧', '測定', '結果'] as const
const stepKeys = ['nfc', 'face_auth', 'medical', 'measuring', 'result'] as const
const currentStepIndex = computed(() => stepKeys.indexOf(step.value))
</script>

<template>
  <div :class="[
    'w-full flex-1 overflow-y-auto p-4',
    landscape ? 'flex gap-4 max-w-4xl mx-auto' : 'flex flex-col items-center'
  ]">
    <!-- 左列 (横画面) / 上部 (縦画面): バナー + ステップ + フッターリンク -->
    <div :class="landscape ? 'w-2/5 flex flex-col shrink-0' : 'w-full flex flex-col items-center'">
      <!-- 端末未アクティベート警告 -->
      <ClientOnly>
        <div
          v-if="!isDeviceActivated"
          :class="['w-full bg-red-50 border border-red-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-red-700', landscape ? '' : 'max-w-md']"
        >
          端末未登録 — <NuxtLink to="/login" class="underline font-medium">管理者ログイン</NuxtLink>で端末を登録してください
        </div>
      </ClientOnly>
      <!-- オフラインバナー -->
      <div
        v-if="!isOnline"
        :class="['w-full bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-amber-700', landscape ? '' : 'max-w-md']"
      >
        オフライン — 測定結果はローカルに保存されます
      </div>
      <!-- 未送信キュー通知 -->
      <div
        v-if="pending > 0 && isOnline && !isSyncing"
        :class="['w-full bg-blue-50 border border-blue-200 rounded-xl px-4 py-2 mb-2 flex items-center justify-between text-sm', landscape ? '' : 'max-w-md']"
      >
        <span class="text-blue-700">未送信の測定結果: {{ pending }}件</span>
        <button class="text-blue-600 font-medium hover:underline" @click="syncQueue">同期する</button>
      </div>
      <div
        v-if="isSyncing"
        :class="['w-full bg-blue-50 border border-blue-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-blue-700', landscape ? '' : 'max-w-md']"
      >
        同期中...
      </div>
      <div
        v-if="isFaceSyncing"
        :class="['w-full bg-green-50 border border-green-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-green-700', landscape ? '' : 'max-w-md']"
      >
        顔データ同期中...
      </div>

      <!-- 免許証有効期限切れ警告 -->
      <div
        v-if="licenseExpiryStatus === 'expired' && licenseExpiryDate"
        :class="['w-full bg-red-50 border border-red-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-red-700', landscape ? '' : 'max-w-md']"
      >
        免許証の有効期限が切れています ({{ formatExpiryDate(licenseExpiryDate) }})
      </div>
      <div
        v-if="licenseExpiryStatus === 'expiring_soon' && licenseExpiryDate"
        :class="['w-full bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-amber-700', landscape ? '' : 'max-w-md']"
      >
        免許証の有効期限が近づいています ({{ formatExpiryDate(licenseExpiryDate) }})
      </div>

      <header :class="['w-full text-center', landscape ? 'py-2' : 'max-w-md py-6']">
        <h1 :class="['font-bold text-gray-800', landscape ? 'text-lg' : 'text-2xl']">アルコールチェッカー</h1>
        <!-- ステップインジケーター -->
        <div :class="['flex items-center mt-3', landscape ? 'flex-wrap gap-1 justify-center' : 'justify-center']">
          <template v-for="(s, i) in steps" :key="i">
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
              v-if="i < steps.length - 1"
              class="w-4 h-4 mx-1 shrink-0"
              :class="i < currentStepIndex ? 'text-green-400' : 'text-gray-300'"
              fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </template>
        </div>
      </header>

      <!-- フッターリンク (横画面時は左列に配置) -->
      <div v-if="landscape" class="mt-auto pt-2">
        <div class="flex flex-wrap justify-center gap-4">
          <button
            v-if="step !== 'nfc'"
            class="text-gray-500 hover:text-gray-700 text-sm"
            @click="reset"
          >
            最初からやり直す
          </button>
          <NuxtLink to="/register" class="text-blue-600 hover:underline text-sm">
            顔登録
          </NuxtLink>
          <NuxtLink to="/maintenance" class="text-blue-600 hover:underline text-sm">
            メンテナンス
          </NuxtLink>
        </div>
      </div>
    </div>

    <!-- 右列 (横画面) / メインコンテンツ (縦画面) -->
    <main :class="['w-full flex-1', landscape ? 'min-h-0 overflow-y-auto' : 'max-w-md']">
      <!-- Step 1: NFC / 手動入力 -->
      <div v-if="step === 'nfc'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-6 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">乗務員ID</h2>

          <!-- 承認エラー -->
          <div v-if="approvalError" class="bg-red-50 border border-red-200 rounded-xl p-3 mb-4 text-sm text-red-700">
            {{ approvalError }}
          </div>

          <!-- NFC モード -->
          <div v-if="!useManualInput && !isDemoMode">
            <NfcStatus @read="onNfcRead" />
            <button
              class="w-full mt-4 text-sm text-gray-500 hover:text-gray-700 underline"
              @click="useManualInput = true"
            >
              手動でIDを入力する
            </button>
          </div>

          <!-- 手動入力モード -->
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

      <!-- Step 2: 顔認証 (フルスクリーンオーバーレイ) -->
      <Teleport to="body">
        <div v-if="step === 'face_auth'" class="fixed inset-0 z-50 bg-black flex flex-col">
          <!-- ヘッダー -->
          <div class="flex items-center justify-between px-4 py-2 bg-black/80 text-white">
            <div>
              <h2 class="text-base font-semibold">顔認証</h2>
              <p class="text-xs text-gray-300">{{ employeeName }}</p>
            </div>
            <button
              v-if="!isDemoMode"
              class="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded-lg"
              @click="onFaceAuthSkip"
            >
              スキップ
            </button>
          </div>
          <!-- カメラ (残り全体を使用) -->
          <div class="flex-1 min-h-0">
            <FaceAuth
              :employee-id="employeeId"
              mode="verify"
              :demo-mode="isDemoMode"
              @result="onFaceAuthResult"
            />
          </div>
          <!-- フッター: 指紋認証 -->
          <div v-if="canUseFingerprint" class="px-4 py-3 bg-black/80">
            <button
              class="w-full px-4 py-3 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2"
              @click="requestFingerprint"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11c0-1.1.9-2 2-2s2 .9 2 2v3c0 1.66-1.34 3-3 3"/><path d="M8 15V11c0-2.21 1.79-4 4-4s4 1.79 4 4"/><path d="M2 11c0-5.52 4.48-10 10-10s10 4.48 10 10v3c0 3.31-2.69 6-6 6"/><path d="M12 11v4c0 .55-.45 1-1 1"/><path d="M6 11c0-3.31 2.69-6 6-6s6 2.69 6 6v2"/></svg>
              指紋認証で本人確認
            </button>
          </div>
        </div>
      </Teleport>

      <!-- Step 3: 体温・血圧 (BLE Medical Gateway / 手動入力) -->
      <div v-if="step === 'medical'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-6 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-2">体温・血圧</h2>
          <p class="text-sm text-gray-500 mb-4">{{ employeeName }}</p>

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

      <!-- Step 4: FC-1200 測定 -->
      <div v-if="step === 'measuring'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-6 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">アルコール測定</h2>
          <p class="text-sm text-gray-500 mb-4">{{ employeeName }}</p>

          <!-- 録画カメラプレビュー -->
          <div v-if="isMeasuringCameraActive" class="relative mb-4 flex justify-center">
            <video
              ref="measuringVideoRef"
              autoplay
              playsinline
              muted
              class="w-40 h-30 rounded-lg object-cover border border-gray-200"
            />
            <div
              v-if="isRecording"
              class="absolute top-1 left-1 flex items-center gap-1 bg-red-600 text-white text-xs px-1.5 py-0.5 rounded"
            >
              <span class="w-2 h-2 rounded-full bg-white animate-pulse" />
              録画中
            </div>
          </div>

          <AlcMeasurement
            :employee-id="employeeId"
            :demo-mode="isDemoMode"
            @result="onMeasurementResult"
            @state-change="onAlcStateChange"
          />
        </div>
      </div>

      <!-- Step 5: 結果表示 -->
      <div v-if="step === 'result' && measurementResult" class="flex flex-col gap-4">
        <ResultCard
          :result="measurementResult"
          :face-photo-blob="faceSnapshot"
          :employee-name="employeeName"
          @reset="reset"
        />
        <!-- 医療データ入力元バッジ -->
        <div
          v-if="medicalInputSource && (measurementResult.temperature || measurementResult.systolic)"
          class="text-center text-xs"
        >
          <span
            class="inline-flex items-center gap-1 px-2 py-1 rounded-full"
            :class="medicalInputSource === 'manual' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'"
          >
            {{ medicalInputSource === 'manual' ? '手動入力' : 'BLE機器' }}
          </span>
        </div>
        <!-- API 保存状態 -->
        <div v-if="isSaving" class="text-center text-sm text-gray-500">
          保存中...
        </div>
        <div v-else-if="saveStatus === 'queued'" class="text-center text-sm text-amber-600">
          オフラインのためローカルに保存しました (オンライン復帰時に自動送信)
        </div>
        <div v-else-if="saveError" class="text-center text-sm text-red-500">
          保存失敗: {{ saveError }}
        </div>
        <!-- 録画アップロード状態 -->
        <div v-if="videoUploadStatus" class="text-center text-xs">
          <span
            class="inline-flex items-center gap-1 px-2 py-1 rounded-full"
            :class="{
              'bg-blue-100 text-blue-700': videoUploadStatus === 'uploading',
              'bg-green-100 text-green-700': videoUploadStatus === 'uploaded',
              'bg-amber-100 text-amber-700': videoUploadStatus === 'pending',
              'bg-red-100 text-red-700': videoUploadStatus === 'failed',
            }"
          >
            <template v-if="videoUploadStatus === 'uploading'">
              <span class="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              録画アップロード中...
            </template>
            <template v-else-if="videoUploadStatus === 'uploaded'">
              録画アップロード完了
            </template>
            <template v-else-if="videoUploadStatus === 'pending'">
              録画はローカルに保存済み (後でアップロード)
            </template>
            <template v-else-if="videoUploadStatus === 'failed'">
              録画アップロード失敗 (次回起動時にリトライ)
            </template>
          </span>
        </div>
      </div>
    </main>

    <!-- ナビゲーション (縦画面時のみ。横画面時は左列に配置) -->
    <footer v-if="!landscape" class="w-full max-w-md py-4">
      <div class="flex justify-center gap-4">
        <button
          v-if="step !== 'nfc'"
          class="text-gray-500 hover:text-gray-700 text-sm"
          @click="reset"
        >
          最初からやり直す
        </button>
        <NuxtLink to="/register" class="text-blue-600 hover:underline text-sm">
          顔登録
        </NuxtLink>
        <NuxtLink to="/maintenance" class="text-blue-600 hover:underline text-sm">
          メンテナンス
        </NuxtLink>
      </div>
    </footer>
  </div>
</template>
