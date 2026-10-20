<script setup lang="ts">
import type { MeasurementResult } from '~/types'
import { alcoholResultClass, alcoholResultLabel, alcoholTone } from '~/utils/alcohol'

const props = defineProps<{
  result: MeasurementResult
  facePhotoBlob?: Blob | null
  employeeName?: string
  /**
   * 「IT点呼 / 終了」を出す (Refs ippoan/alc-app#436)。渡したときだけ「次の測定へ」の代わりに
   * 2 つのボタンと残り秒数を出す。**渡さなければ今までと同一**
   */
  itOffer?: { secondsLeft: number, busy: boolean } | null
}>()

const emit = defineEmits<{
  reset: []
  it: []
  finish: []
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

// Tailwind が拾えるよう、クラス名はリテラルで持つ。色調は alcoholTone で決める
const TONE_CARD = {
  green: 'bg-green-50 border-green-300',
  yellow: 'bg-yellow-50 border-yellow-300',
  red: 'bg-red-50 border-red-300',
} as const
const resultColor = computed(() => TONE_CARD[alcoholTone(props.result.resultType, props.result.alcoholValue)])

const resultLabel = computed(() => alcoholResultLabel(props.result.resultType, props.result.alcoholValue))

const resultLabelColor = computed(() => alcoholResultClass(props.result.resultType, props.result.alcoholValue))

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

    <!-- IT点呼 か 終了 (押されなければ残り秒数が尽きたところで通常点呼として記録される) -->
    <div v-if="itOffer" class="mt-6 flex flex-col gap-3">
      <button
        data-testid="result-it"
        :disabled="itOffer.busy"
        class="w-full px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
        @click="emit('it')"
      >
        IT点呼 (運行管理者と通話)
      </button>
      <button
        data-testid="result-finish"
        :disabled="itOffer.busy"
        class="w-full px-6 py-3 bg-gray-800 text-white rounded-xl font-medium hover:bg-gray-900 transition-colors disabled:opacity-50"
        @click="emit('finish')"
      >
        終了
      </button>
      <p data-testid="result-countdown" class="text-sm text-gray-500 text-center">
        あと {{ itOffer.secondsLeft }} 秒で終了します
      </p>
    </div>
    <!-- 次の測定へ -->
    <button
      v-else
      data-testid="result-reset"
      class="w-full mt-6 px-6 py-3 bg-gray-800 text-white rounded-xl font-medium hover:bg-gray-900 transition-colors"
      @click="emit('reset')"
    >
      次の測定へ
    </button>
  </div>
</template>
