<script setup lang="ts">
import type { SubmitMedicalData } from '~/types'

/**
 * スキップの口を出すか。既定 true (従来どおり)。BleStatus.vue と同じ理由・同じ既定
 * (Refs #322)。`TenkoKiosk.vue` からだけ `false` を渡す。
 */
withDefaults(defineProps<{
  allowSkip?: boolean
}>(), {
  allowSkip: true,
})

const emit = defineEmits<{
  submit: [data: SubmitMedicalData]
  skip: []
}>()

const { bpEnabled } = useBloodPressureSetting()
const { hasBpHardware } = useBleGateway()

/** 手入力欄を出すか。未登録端末でも血圧計が在れば出す (Refs #322) */
const showBpUi = computed(() => bpEnabled.value || hasBpHardware.value)

const temperature = ref<number | null>(36.5)
// 血圧は空で始める。既定値 (120/80) を置くと、触っていない値が「測れた値」として
// そのまま送信されてしまう (Refs ippoan/alc-app-s3#135)。
const systolic = ref<number | null>(null)
const diastolic = ref<number | null>(null)
const pulse = ref<number | null>(70)

function handleSubmit() {
  const data: SubmitMedicalData = {
    medical_measured_at: new Date().toISOString(),
    medical_manual_input: true,
  }
  if (temperature.value !== null) data.temperature = temperature.value
  if (systolic.value !== null) data.systolic = systolic.value
  if (diastolic.value !== null) data.diastolic = diastolic.value
  if (pulse.value !== null) data.pulse = pulse.value
  emit('submit', data)
}

function handleSkip() {
  emit('skip')
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <p class="text-sm text-gray-500">
      測定値を入力してください
    </p>

    <div class="grid grid-cols-2 gap-3">
      <!-- 体温 -->
      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-gray-600">体温 (°C)</label>
        <input
          v-model.number="temperature"
          type="number"
          step="0.1"
          min="34"
          max="42"
          placeholder="36.5"
          class="px-3 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
      </div>

      <!-- 脈拍 -->
      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-gray-600">脈拍 (bpm)</label>
        <input
          v-model.number="pulse"
          type="number"
          step="1"
          min="30"
          max="220"
          placeholder="70"
          class="px-3 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
      </div>

      <!-- 収縮期血圧 -->
      <div v-if="showBpUi" class="flex flex-col gap-1">
        <label class="text-xs font-medium text-gray-600">収縮期血圧 (mmHg)</label>
        <input
          v-model.number="systolic"
          type="number"
          step="1"
          min="60"
          max="250"
          placeholder="120"
          class="px-3 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
      </div>

      <!-- 拡張期血圧 -->
      <div v-if="showBpUi" class="flex flex-col gap-1">
        <label class="text-xs font-medium text-gray-600">拡張期血圧 (mmHg)</label>
        <input
          v-model.number="diastolic"
          type="number"
          step="1"
          min="40"
          max="180"
          placeholder="80"
          class="px-3 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
      </div>
    </div>

    <div class="flex gap-3 pt-1">
      <button
        v-if="allowSkip"
        class="flex-1 px-4 py-3 border border-gray-300 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors"
        @click="handleSkip"
      >
        スキップ
      </button>
      <button
        class="flex-1 px-4 py-3 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors"
        @click="handleSubmit"
      >
        送信
      </button>
    </div>
  </div>
</template>
