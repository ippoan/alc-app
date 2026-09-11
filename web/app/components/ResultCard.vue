<script setup lang="ts">
import type { MeasurementResult } from '~/types'

const props = defineProps<{
  result: MeasurementResult
  facePhotoBlob?: Blob | null
  employeeName?: string
}>()

const emit = defineEmits<{
  reset: []
}>()

const facePhotoUrl = computed(() => {
  if (props.facePhotoBlob) {
    return URL.createObjectURL(props.facePhotoBlob)
  }
  return props.result.facePhotoUrl ?? null
})

onUnmounted(() => {
  if (facePhotoUrl.value && props.facePhotoBlob) {
    URL.revokeObjectURL(facePhotoUrl.value)
  }
})

const resultColor = computed(() => {
  switch (props.result.resultType) {
    case 'normal': return 'bg-green-50 border-green-300'
    case 'over': return 'bg-red-50 border-red-300'
    case 'error': return 'bg-yellow-50 border-yellow-300'
  }
})

const resultLabel = computed(() => {
  switch (props.result.resultType) {
    case 'normal': return '正常'
    case 'over': return '基準値超過'
    case 'error': return 'エラー'
  }
})

const resultLabelColor = computed(() => {
  switch (props.result.resultType) {
    case 'normal': return 'text-green-700 bg-green-100'
    case 'over': return 'text-red-700 bg-red-100'
    case 'error': return 'text-yellow-700 bg-yellow-100'
  }
})

const alcoholDisplay = computed(() => {
  return `${props.result.alcoholValue.toFixed(2)} mg/L`
})

const hasMedicalData = computed(() =>
  props.result.temperature != null || props.result.systolic != null,
)

const timeDisplay = computed(() => {
  return props.result.measuredAt.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
})
</script>

<template>
  <div :class="['border-2 rounded-2xl p-6', resultColor]">
    <!-- 結果ヘッダー -->
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-semibold text-gray-800">測定結果</h2>
      <span :class="['px-3 py-1 rounded-full text-sm font-medium', resultLabelColor]">
        {{ resultLabel }}
      </span>
    </div>

    <!-- 顔写真 + データ -->
    <div class="flex gap-4">
      <div v-if="facePhotoUrl" class="flex-shrink-0">
        <img
          :src="facePhotoUrl"
          alt="認証時の顔写真"
          class="w-20 h-20 rounded-xl object-cover"
        >
      </div>

      <div class="flex-1 space-y-2">
        <div class="flex justify-between">
          <span class="text-sm text-gray-500">乗務員</span>
          <span class="font-medium">{{ employeeName || result.employeeId }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-sm text-gray-500">アルコール濃度</span>
          <span class="font-mono font-bold text-lg">{{ alcoholDisplay }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-sm text-gray-500">測定日時</span>
          <span class="text-sm">{{ timeDisplay }}</span>
        </div>
      </div>
    </div>

    <!-- 医療データ -->
    <div v-if="hasMedicalData" class="border-t border-gray-200 mt-4 pt-3">
      <p class="text-xs text-gray-400 mb-2">医療データ</p>
      <div class="space-y-1">
        <div v-if="result.temperature != null" class="flex justify-between">
          <span class="text-sm text-gray-500">体温</span>
          <span class="font-mono font-medium">{{ result.temperature.toFixed(1) }} &#8451;</span>
        </div>
        <div v-if="result.systolic != null" class="flex justify-between">
          <span class="text-sm text-gray-500">血圧</span>
          <span class="font-mono font-medium">{{ result.systolic }}/{{ result.diastolic }}</span>
        </div>
        <div v-if="result.pulse != null" class="flex justify-between">
          <span class="text-sm text-gray-500">脈拍</span>
          <span class="font-mono font-medium">{{ result.pulse }} bpm</span>
        </div>
      </div>
    </div>

    <!-- 次の測定へ -->
    <button
      class="w-full mt-6 px-6 py-3 bg-gray-800 text-white rounded-xl font-medium hover:bg-gray-900 transition-colors"
      @click="emit('reset')"
    >
      次の測定へ
    </button>
  </div>
</template>
