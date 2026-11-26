<script setup lang="ts">
import type { ApiMeasurement } from '~/types'
import { alcoholResultClass, alcoholResultLabel } from '~/utils/alcohol'
import { excludeMeasurementBp } from '~/utils/api'

const props = defineProps<{
  measurement: ApiMeasurement
  employeeName: string
}>()

const emit = defineEmits<{
  close: []
  /** 血圧を外した後の測定 (親が表示中の測定を差し替える) */
  updated: [measurement: ApiMeasurement]
}>()

// --- 血圧を外す (測定台で人が入れ替わった血圧。Refs ippoan/alc-app#676) ---
const excludeOpen = ref(false)
const excludeReason = ref('')
const excludeByName = ref('')
const excluding = ref(false)
const excludeError = ref<string | null>(null)

function openExclude() {
  excludeOpen.value = true
  excludeReason.value = ''
  excludeByName.value = ''
  excludeError.value = null
}

async function submitExclude() {
  const reason = excludeReason.value.trim()
  if (!reason || excluding.value) return
  excluding.value = true
  excludeError.value = null
  try {
    const byName = excludeByName.value.trim()
    const updated = await excludeMeasurementBp(props.measurement.id, byName ? { reason, excluded_by_name: byName } : { reason })
    excludeOpen.value = false
    emit('updated', updated)
  }
  catch (e) {
    const err = e as { status?: number, message?: string } | null
    excludeError.value = err?.status === 409
      ? 'この血圧はすでに外されています'
      : (err?.message || '血圧を外せませんでした')
  }
  finally {
    excluding.value = false
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

function onBackdropClick(e: MouseEvent) {
  if (e.target === e.currentTarget) emit('close')
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function statusLabel(m: ApiMeasurement) {
  if (m.status === 'completed') return '完了'
  if (m.face_photo_url) return '顔認証済'
  return '開始'
}

function statusColor(m: ApiMeasurement) {
  if (m.status === 'completed') return 'bg-green-100 text-green-800'
  if (m.face_photo_url) return 'bg-blue-100 text-blue-800'
  return 'bg-gray-100 text-gray-600'
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    @click="onBackdropClick"
  >
    <div class="bg-white rounded-2xl shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
      <!-- ヘッダー -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <h2 class="text-lg font-semibold text-gray-800">測定詳細</h2>
        <button
          class="p-1 text-gray-400 hover:text-gray-600 transition-colors"
          @click="emit('close')"
        >
          <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="p-6 space-y-5">
        <!-- 顔写真 -->
        <MeasurementFacePhoto :measurement="measurement" />

        <!-- 基本情報 -->
        <div class="space-y-3">
          <div class="flex justify-between items-center">
            <span class="text-sm text-gray-500">乗務員</span>
            <span class="font-medium text-gray-800">{{ employeeName }}</span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-sm text-gray-500">測定日時</span>
            <span class="text-sm text-gray-700">{{ formatDate(measurement.measured_at) }}</span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-sm text-gray-500">状態</span>
            <span
              class="inline-block px-2 py-1 rounded-full text-xs font-medium"
              :class="statusColor(measurement)"
            >
              {{ statusLabel(measurement) }}
            </span>
          </div>
        </div>

        <!-- 録画 -->
        <MeasurementVideo :measurement="measurement" />

        <!-- アルコール検査 -->
        <div class="bg-gray-50 rounded-xl p-4 space-y-3">
          <p class="text-xs text-gray-400 font-medium">アルコール検査</p>
          <div class="flex justify-between items-center">
            <span class="text-sm text-gray-500">アルコール値</span>
            <span class="font-mono font-bold text-lg text-gray-800">
              {{ measurement.alcohol_value != null ? measurement.alcohol_value.toFixed(3) + ' mg/L' : '-' }}
            </span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-sm text-gray-500">結果</span>
            <span
              v-if="measurement.result_type"
              class="inline-block px-2 py-1 rounded-full text-xs font-medium"
              :class="alcoholResultClass(measurement.result_type, measurement.alcohol_value ?? 0)"
            >
              {{ alcoholResultLabel(measurement.result_type, measurement.alcohol_value ?? 0) }}
            </span>
            <span v-else class="text-gray-400 text-xs">-</span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-sm text-gray-500">使用回数</span>
            <span class="font-mono text-gray-700">{{ measurement.device_use_count }} 回</span>
          </div>
        </div>

        <!-- 医療データ -->
        <div
          v-if="measurement.temperature != null || measurement.systolic != null || measurement.pulse != null"
          class="bg-gray-50 rounded-xl p-4 space-y-3"
        >
          <p class="text-xs text-gray-400 font-medium">医療データ</p>
          <div v-if="measurement.temperature != null" class="flex justify-between items-center">
            <span class="text-sm text-gray-500">体温</span>
            <span class="font-mono font-medium text-gray-700">{{ measurement.temperature.toFixed(1) }} &#8451;</span>
          </div>
          <div v-if="measurement.systolic != null" class="flex justify-between items-center">
            <span class="text-sm text-gray-500">血圧</span>
            <span
              class="font-mono font-medium"
              :class="measurement.bp_excluded_at ? 'text-gray-400 line-through' : 'text-gray-700'"
            >{{ measurement.systolic }}/{{ measurement.diastolic }}</span>
          </div>
          <template v-if="measurement.systolic != null">
            <p
              v-if="measurement.bp_excluded_at"
              data-testid="bp-excluded"
              class="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2"
            >
              外した ({{ measurement.bp_excluded_reason }}・{{ measurement.bp_excluded_by_name }}・{{ formatDate(measurement.bp_excluded_at) }})
            </p>
            <button
              v-else-if="!excludeOpen"
              data-testid="bp-exclude-open"
              class="text-xs text-red-600 underline"
              @click="openExclude"
            >
              本人の測定ではない (外す)
            </button>
            <div v-else data-testid="bp-exclude-form" class="space-y-2 border-t border-gray-200 pt-3">
              <p class="text-xs text-gray-500">
                外した血圧は回数にも点呼にも入りません。測定の記録は残ります。
              </p>
              <label class="block text-xs text-gray-600">
                理由 (必須)
                <input
                  v-model="excludeReason"
                  data-testid="bp-exclude-reason"
                  type="text"
                  class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  placeholder="例: 別の人が測った"
                >
              </label>
              <label class="block text-xs text-gray-600">
                外した人の氏名 (空ならログインの名前)
                <input
                  v-model="excludeByName"
                  data-testid="bp-exclude-by-name"
                  type="text"
                  class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                >
              </label>
              <p v-if="excludeError" data-testid="bp-exclude-error" class="text-xs text-red-600">{{ excludeError }}</p>
              <div class="flex gap-2">
                <button
                  data-testid="bp-exclude-submit"
                  class="flex-1 px-3 py-2 bg-red-600 text-white rounded-lg text-sm disabled:opacity-50"
                  :disabled="!excludeReason.trim() || excluding"
                  @click="submitExclude"
                >
                  {{ excluding ? '外しています...' : '外す' }}
                </button>
                <button
                  data-testid="bp-exclude-cancel"
                  class="flex-1 px-3 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm"
                  :disabled="excluding"
                  @click="excludeOpen = false"
                >
                  やめる
                </button>
              </div>
            </div>
          </template>
          <div v-if="measurement.pulse != null" class="flex justify-between items-center">
            <span class="text-sm text-gray-500">脈拍</span>
            <span class="font-mono font-medium text-gray-700">{{ measurement.pulse }} bpm</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
