<script setup lang="ts">
import type { TenkoSession } from '~/types'
import { tenkoTypeLabel } from '~/utils/tenko-type'

defineProps<{
  session: TenkoSession
  employeeName: string
}>()

const emit = defineEmits<{
  reset: []
}>()

function formatTime(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="flex flex-col items-center gap-4">
    <!-- 完了アイコン -->
    <div class="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
      <svg class="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    </div>

    <h3 class="text-xl font-bold text-green-700">点呼完了</h3>
    <p class="text-gray-500 text-sm">{{ employeeName }}</p>

    <!-- サマリ -->
    <div class="w-full rounded-xl border border-gray-200 divide-y divide-gray-100 text-sm">
      <div class="flex justify-between px-4 py-2">
        <span class="text-gray-500">点呼種別</span>
        <span class="font-medium">{{ tenkoTypeLabel(session.tenko_type) }}</span>
      </div>
      <div class="flex justify-between px-4 py-2">
        <span class="text-gray-500">運行管理者</span>
        <span class="font-medium">{{ session.responsible_manager_name }}</span>
      </div>
      <div class="flex justify-between px-4 py-2">
        <span class="text-gray-500">開始</span>
        <span class="font-medium">{{ formatTime(session.started_at) }}</span>
      </div>
      <div class="flex justify-between px-4 py-2">
        <span class="text-gray-500">完了</span>
        <span class="font-medium">{{ formatTime(session.completed_at) }}</span>
      </div>
      <div v-if="session.alcohol_value != null" class="flex justify-between px-4 py-2">
        <span class="text-gray-500">アルコール</span>
        <span class="font-medium">{{ session.alcohol_value.toFixed(3) }} mg/L</span>
      </div>
      <div v-if="session.temperature != null" class="flex justify-between px-4 py-2">
        <span class="text-gray-500">体温</span>
        <span class="font-medium">{{ session.temperature.toFixed(1) }} &#8451;</span>
      </div>
      <div v-if="session.systolic != null && session.diastolic != null" class="flex justify-between px-4 py-2">
        <span class="text-gray-500">血圧</span>
        <span class="font-medium">{{ session.systolic }}/{{ session.diastolic }} mmHg</span>
      </div>
    </div>

    <button
      class="w-full py-3 bg-gray-200 text-gray-700 rounded-xl font-medium hover:bg-gray-300 transition-colors"
      @click="emit('reset')"
    >
      次の点呼へ
    </button>
  </div>
</template>
