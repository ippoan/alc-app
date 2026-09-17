<script setup lang="ts">
import type { ApiMeasurement } from '~/types'
import { alcoholResultClass, alcoholResultLabel } from '~/utils/alcohol'

defineProps<{
  measurement: ApiMeasurement
  employeeName: string
}>()

const emit = defineEmits<{
  close: []
}>()

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
              :class="alcoholResultClass(measurement.result_type)"
            >
              {{ alcoholResultLabel(measurement.result_type) }}
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
            <span class="font-mono font-medium text-gray-700">{{ measurement.systolic }}/{{ measurement.diastolic }}</span>
          </div>
          <div v-if="measurement.pulse != null" class="flex justify-between items-center">
            <span class="text-sm text-gray-500">脈拍</span>
            <span class="font-mono font-medium text-gray-700">{{ measurement.pulse }} bpm</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
