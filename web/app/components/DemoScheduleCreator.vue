<script setup lang="ts">
import type { TenkoType, TenkoSchedule } from '~/types'
import { createSchedule, getEmployeeByCode } from '~/utils/api'
import { tenkoTypeLabel } from '~/utils/tenko-type'

const employeeCode = ref('')
const tenkoType = ref<TenkoType>('pre_operation')
const managerName = ref('デモ管理者')
const isLoading = ref(false)
const successMessage = ref<string | null>(null)
const errorMessage = ref<string | null>(null)
const createdSchedules = ref<TenkoSchedule[]>([])

async function submit() {
  if (!employeeCode.value.trim()) {
    errorMessage.value = '社員番号を入力してください'
    return
  }
  errorMessage.value = null
  successMessage.value = null
  isLoading.value = true
  try {
    // 社員番号 → UUID を解決
    const emp = await getEmployeeByCode(employeeCode.value.trim())
    const s = await createSchedule({
      employee_id: emp.id,
      tenko_type: tenkoType.value,
      responsible_manager_name: managerName.value.trim() || 'デモ管理者',
      scheduled_at: new Date().toISOString(),
      instruction: tenkoType.value === 'pre_operation' ? 'デモ点呼 — 安全運転に努めてください' : undefined,
    })
    createdSchedules.value.unshift(s)
    successMessage.value = `${emp.name} の点呼予定を作成しました`
    employeeCode.value = ''
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '作成に失敗しました'
  } finally {
    isLoading.value = false
  }
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="bg-white rounded-2xl p-4 shadow-sm">
    <p class="text-sm font-semibold text-gray-700 mb-3">デモ用点呼予定を追加</p>

    <!-- 点呼タイプ -->
    <div class="flex gap-2 mb-3">
      <button
        class="flex-1 py-1.5 rounded-lg text-sm font-medium border transition-colors"
        :class="tenkoType === 'pre_operation'
          ? 'bg-blue-600 text-white border-blue-600'
          : 'bg-white text-blue-600 border-blue-300 hover:bg-blue-50'"
        @click="tenkoType = 'pre_operation'"
      >
        {{ tenkoTypeLabel('pre_operation') }}
      </button>
      <button
        class="flex-1 py-1.5 rounded-lg text-sm font-medium border transition-colors"
        :class="tenkoType === 'post_operation'
          ? 'bg-orange-500 text-white border-orange-500'
          : 'bg-white text-orange-500 border-orange-300 hover:bg-orange-50'"
        @click="tenkoType = 'post_operation'"
      >
        {{ tenkoTypeLabel('post_operation') }}
      </button>
    </div>

    <!-- 社員番号 -->
    <input
      v-model="employeeCode"
      type="text"
      placeholder="社員番号"
      class="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
    />

    <!-- 管理者名 -->
    <input
      v-model="managerName"
      type="text"
      placeholder="管理者名"
      class="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
    />

    <!-- 作成ボタン -->
    <button
      class="w-full py-2 rounded-xl text-sm font-medium text-white transition-colors"
      :class="isLoading ? 'bg-blue-400' : 'bg-blue-600 hover:bg-blue-700'"
      :disabled="isLoading"
      @click="submit"
    >
      {{ isLoading ? '作成中...' : '予定を作成' }}
    </button>

    <!-- メッセージ -->
    <p v-if="successMessage" class="mt-2 text-xs text-green-700 bg-green-50 rounded-lg px-3 py-1.5">
      {{ successMessage }}
    </p>
    <p v-if="errorMessage" class="mt-2 text-xs text-red-700 bg-red-50 rounded-lg px-3 py-1.5">
      {{ errorMessage }}
    </p>

    <!-- 作成済み一覧 -->
    <div v-if="createdSchedules.length > 0" class="mt-3 space-y-1">
      <p class="text-xs text-gray-500">作成済み</p>
      <div
        v-for="s in createdSchedules"
        :key="s.id"
        class="flex items-center gap-2 text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-1.5"
      >
        <span
          class="px-1.5 py-0.5 rounded font-bold text-white"
          :class="s.tenko_type === 'pre_operation' ? 'bg-blue-500' : 'bg-orange-500'"
        >
          {{ tenkoTypeLabel(s.tenko_type) }}
        </span>
        <span>{{ s.employee_id }}</span>
        <span class="ml-auto text-gray-400">{{ formatTime(s.created_at) }}</span>
      </div>
    </div>
  </div>
</template>
