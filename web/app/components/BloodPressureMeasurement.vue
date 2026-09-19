<script setup lang="ts">
import type { FaceAuthResult } from '~/types'
import { getEmployeeByNfcId, startMeasurement, updateMeasurement } from '~/utils/api'
import { checkFaceApproval } from '~/utils/face-approval'
import { employeeNotFoundByNfc } from '~/utils/employee-lookup-messages'

/**
 * 血圧だけを測る端末の画面 (Refs ippoan/alc-app-s3#135)。
 *
 * 測る場所と点呼する場所を分けたいという要望から、**カードをかざす → 顔認証 →
 * 血圧を測る → 完了**だけを行う。ここで測った値は「直近の血圧」として後から
 * 点呼が引き当てる (引き当て側は別 PR)。
 *
 * - **点呼のセッションは作らない。** `useTenkoKiosk` も `saveMeasurement` も使わない —
 *   前者は点呼のセッションが前提の作りで、後者は `record_as_tenko: true` を固定で送る。
 *   保存は通常点呼と同じ `startMeasurement` → `updateMeasurement` の口を使い、
 *   `record_as_tenko` を**付けない**ので点呼の記録にはならない。
 * - 顔の扱いは `utils/face-approval.ts` の判定 1 か所に従う。**未登録なら飛ばせる**
 *   (乗務員の点呼と同じ方針)。審査中・却下は登録済みなので従来どおり弾く。
 * - 血圧計が使えない端末では案内だけを出す。判定は**生の `bpEnabled` ではなく
 *   `useBpUiEnabled()` の `bpUiState`** を見る (Refs ippoan/alc-app#353) —
 *   測定台は `devices` に行を持たず `deviceId` が構造的に空なので、サーバ設定
 *   (`devices.bp_enabled`) は**永久に false** で、直参照だと測定台が 1 台も測れない。
 *   `checking` (まだ署名を取りに行っていない) は**「使わない設定」に倒さず待つ** —
 *   倒すと起動直後に必ず詰まる。
 */

type BpStep = 'nfc' | 'face_auth' | 'measure' | 'done'

const { bpUiState } = useBpUiEnabled()
const { latestBloodPressure } = useBleGateway()

const step = ref<BpStep>('nfc')
const employeeId = ref('')
const employeeName = ref('')
const error = ref<string | null>(null)
const measureNotice = ref<string | null>(null)
const isSaving = ref(false)
const saveError = ref<string | null>(null)
const savedReading = ref<{ systolic: number; diastolic: number; pulse?: number } | null>(null)

// 顔が未登録の乗務員は顔認証を飛ばせる (判定は utils/face-approval.ts、通すかは入口が決める)
const faceSkippable = ref(false)
const faceSkipNotice = ref<string | null>(null)

/** 通してよければ true。通す場合はスキップ可否も控える */
function applyFaceApproval(emp: { name: string; face_approval_status?: string }): boolean {
  const approval = checkFaceApproval(emp)
  if (approval.kind === 'blocked') { error.value = approval.message; return false }
  faceSkippable.value = approval.kind === 'unregistered'
  faceSkipNotice.value = approval.kind === 'unregistered'
    ? `${approval.message}。顔認証をスキップして進めます`
    : null
  return true
}

async function onNfcRead(nfcId: string) {
  error.value = null
  try {
    const emp = await getEmployeeByNfcId(nfcId)
    if (!applyFaceApproval(emp)) return
    employeeId.value = emp.id
    employeeName.value = emp.name
    step.value = 'face_auth'
  } catch {
    error.value = employeeNotFoundByNfc(nfcId)
  }
}

function onFaceAuthResult(result: FaceAuthResult) {
  if (!result.verified) return
  measureNotice.value = null
  step.value = 'measure'
}

function skipFaceAuth() {
  onFaceAuthResult({ verified: true, similarity: 0, skipped: true })
}

/**
 * 血圧を 1 件だけ保存する。`record_as_tenko` を送らないので点呼の記録は作られない。
 * アルコール値は無いので `alcohol_value` / `result_type` は触らない。
 */
async function save(bp: NonNullable<typeof latestBloodPressure.value>) {
  isSaving.value = true
  saveError.value = null
  try {
    const measurement = await startMeasurement(employeeId.value)
    await updateMeasurement(measurement.id, {
      status: 'completed',
      systolic: bp.systolic,
      diastolic: bp.diastolic,
      pulse: bp.pulse,
      medical_measured_at: bp.measuredAt.toISOString(),
    })
    savedReading.value = { systolic: bp.systolic, diastolic: bp.diastolic, pulse: bp.pulse }
    step.value = 'done'
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : '血圧の保存に失敗しました'
  } finally {
    isSaving.value = false
  }
}

// 血圧が届いたら保存して完了へ。BleStatus が mount 時に読み値を消すので、
// 前の人の値では発火しない (immediate にしないのも同じ理由)
watch(latestBloodPressure, (bp) => {
  if (!bp || step.value !== 'measure') return
  void save(bp)
})

/** BleStatus の「次へ」。血圧が来る前に押されたら進めずに促す */
function onMeasureNext() {
  if (latestBloodPressure.value) return
  measureNotice.value = '血圧がまだ測れていません。血圧計で測ってください'
}

function reset() {
  step.value = 'nfc'
  employeeId.value = ''
  employeeName.value = ''
  error.value = null
  measureNotice.value = null
  saveError.value = null
  savedReading.value = null
  faceSkippable.value = false
  faceSkipNotice.value = null
}
</script>

<template>
  <div class="w-full max-w-md mx-auto p-4 flex flex-col gap-4">
    <!-- まだ署名を取りに行っている最中: 待つ (ここで「使わない」に倒すと起動直後に詰まる) -->
    <div v-if="bpUiState === 'checking'" class="bg-white rounded-2xl p-4 shadow-sm text-center">
      <h2 class="text-lg font-semibold text-gray-700 mb-2">血圧測定</h2>
      <div class="flex items-center justify-center gap-3 py-2 text-sm text-gray-500">
        <span class="inline-block w-5 h-5 border-2 border-gray-300 border-t-blue-600 rounded-full animate-spin" />
        血圧計を確認しています...
      </div>
    </div>

    <!-- 血圧計が使えない端末: 何も測らせない -->
    <div v-else-if="bpUiState !== 'show'" class="bg-white rounded-2xl p-4 shadow-sm text-center">
      <h2 class="text-lg font-semibold text-gray-700 mb-2">血圧測定</h2>
      <p class="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
        血圧計が見つかりません
      </p>
      <p class="mt-2 text-xs text-gray-500">
        血圧計の電源が入っていて、この端末とペアリング済みか確認してください。
      </p>
    </div>

    <template v-else>
      <div v-if="error" class="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
        {{ error }}
      </div>

      <!-- Step 1: カードをかざす -->
      <div v-if="step === 'nfc'" class="bg-white rounded-2xl p-4 shadow-sm">
        <h2 class="text-lg font-semibold text-gray-700 mb-4">乗務員ID</h2>
        <NfcStatus @read="onNfcRead" />
      </div>

      <!-- Step 2: 顔認証 -->
      <div v-else-if="step === 'face_auth'" class="bg-white rounded-2xl p-4 shadow-sm">
        <h2 class="text-lg font-semibold text-gray-700 mb-4">顔認証</h2>
        <p class="text-sm text-gray-500 mb-2">{{ employeeName }}さん</p>
        <!-- 顔が未登録: 顔写真なしで進める (審査中・却下はここまで来ない) -->
        <template v-if="faceSkippable">
          <p class="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4">
            {{ faceSkipNotice }}
          </p>
          <button
            class="w-full px-4 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
            @click="skipFaceAuth"
          >
            顔認証をスキップして進む
          </button>
        </template>
        <FaceAuth
          v-else
          :employee-id="employeeId"
          mode="verify"
          @result="onFaceAuthResult"
        />
      </div>

      <!-- Step 3: 血圧を測る -->
      <div v-else-if="step === 'measure'" class="bg-white rounded-2xl p-4 shadow-sm">
        <h2 class="text-lg font-semibold text-gray-700 mb-2">血圧測定</h2>
        <p class="text-sm text-gray-500 mb-4">{{ employeeName }}さん</p>
        <BleStatus @next="onMeasureNext" @skip="reset" />
        <p v-if="measureNotice" class="mt-3 text-sm text-amber-700 text-center">{{ measureNotice }}</p>
        <p v-if="isSaving" class="mt-3 text-sm text-gray-500 text-center">保存中...</p>
        <p v-if="saveError" class="mt-3 text-sm text-red-600 text-center">{{ saveError }}</p>
      </div>

      <!-- Step 4: 完了 -->
      <div v-else class="bg-white rounded-2xl p-4 shadow-sm text-center">
        <h2 class="text-lg font-semibold text-gray-700 mb-2">測定完了</h2>
        <p class="text-sm text-gray-500 mb-4">{{ employeeName }}さん</p>
        <p v-if="savedReading" class="text-3xl font-mono font-bold text-blue-700">
          {{ savedReading.systolic }}<span class="text-lg font-normal">/</span>{{ savedReading.diastolic }}
          <span class="text-sm font-normal text-gray-500">mmHg</span>
        </p>
        <p v-if="savedReading?.pulse" class="mt-1 text-sm text-gray-500">
          脈拍 {{ savedReading.pulse }} bpm
        </p>
        <button
          class="w-full mt-6 px-4 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
          @click="reset"
        >
          次の人へ
        </button>
      </div>
    </template>
  </div>
</template>
