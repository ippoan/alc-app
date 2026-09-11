<script setup lang="ts">
import type { SubmitMedicalData } from '~/types'
import { SHOW_BLOOD_PRESSURE } from '~/utils/medical-inputs'

const emit = defineEmits<{
  submit: [data: SubmitMedicalData]
  skip: []
}>()

const temperature = ref<number | null>(36.5)
// 血圧欄を隠している間は既定値を送らない (偽の 120/80 が送信され続けないように)
const systolic = ref<number | null>(SHOW_BLOOD_PRESSURE ? 120 : null)
const diastolic = ref<number | null>(SHOW_BLOOD_PRESSURE ? 80 : null)
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
      <div v-if="SHOW_BLOOD_PRESSURE" class="flex flex-col gap-1">
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
      <div v-if="SHOW_BLOOD_PRESSURE" class="flex flex-col gap-1">
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
