<script setup lang="ts">
import type { TenkoDashboard, TenkoSchedule, ApiEmployee } from '~/types'
import { getTenkoDashboard, getEmployees } from '~/utils/api'
import { tenkoTypeLabel } from '~/utils/tenko-type'

const dashboard = ref<TenkoDashboard | null>(null)
const isLoading = ref(false)
const error = ref<string | null>(null)
const employeeMap = ref<Record<string, string>>({})

async function loadEmployees() {
  try {
    const list = await getEmployees()
    employeeMap.value = Object.fromEntries(list.map(e => [e.id, e.name]))
  } catch {}
}

function employeeName(id: string) {
  return employeeMap.value[id] || id.slice(0, 8)
}

async function refresh() {
  isLoading.value = true
  error.value = null
  try {
    dashboard.value = await getTenkoDashboard()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '取得エラー'
  } finally {
    isLoading.value = false
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function overdueMinutes(schedule: TenkoSchedule) {
  const diff = Date.now() - new Date(schedule.scheduled_at).getTime()
  return Math.floor(diff / 60000)
}

defineExpose({ refresh })

onMounted(() => {
  loadEmployees()
  refresh()
})
</script>

<template>
  <div>
    <!-- エラー -->
    <div v-if="error" class="bg-red-50 text-red-700 p-3 rounded-lg mb-4 text-sm">
      {{ error }}
    </div>

    <!-- ローディング -->
    <div v-if="isLoading && !dashboard" class="text-center py-8 text-gray-500">
      読み込み中...
    </div>

    <template v-if="dashboard">
      <!-- サマリカード -->
      <div class="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-4">
        <div class="bg-white rounded-xl p-4 shadow-sm">
          <p class="text-xs text-gray-500">未消費予定</p>
          <p class="text-2xl font-bold text-blue-600">{{ dashboard.pending_schedules }}</p>
        </div>
        <div class="bg-white rounded-xl p-4 shadow-sm">
          <p class="text-xs text-gray-500">進行中セッション</p>
          <p class="text-2xl font-bold text-yellow-600">{{ dashboard.active_sessions }}</p>
        </div>
        <div class="bg-white rounded-xl p-4 shadow-sm">
          <p class="text-xs text-gray-500">中断中</p>
          <p class="text-2xl font-bold text-orange-500">{{ dashboard.interrupted_sessions }}</p>
        </div>
        <div class="bg-white rounded-xl p-4 shadow-sm">
          <p class="text-xs text-gray-500">本日完了</p>
          <p class="text-2xl font-bold text-green-600">{{ dashboard.completed_today }}</p>
        </div>
        <div class="bg-white rounded-xl p-4 shadow-sm">
          <p class="text-xs text-gray-500">本日キャンセル</p>
          <p class="text-2xl font-bold text-red-600">{{ dashboard.cancelled_today }}</p>
        </div>
      </div>

      <!-- 期限超過スケジュール -->
      <div v-if="dashboard.overdue_schedules.length > 0" class="bg-red-50 rounded-xl shadow-sm overflow-hidden mb-4">
        <div class="px-4 py-3 border-b border-red-100">
          <h3 class="text-sm font-medium text-red-800">
            期限超過スケジュール ({{ dashboard.overdue_schedules.length }}件)
          </h3>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-red-100/50 text-red-700">
              <tr>
                <th class="px-4 py-2 text-left font-medium">乗務員</th>
                <th class="px-4 py-2 text-left font-medium">種別</th>
                <th class="px-4 py-2 text-left font-medium">予定日時</th>
                <th class="px-4 py-2 text-left font-medium">管理者</th>
                <th class="px-4 py-2 text-right font-medium">超過</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-red-100">
              <tr v-for="s in dashboard.overdue_schedules" :key="s.id">
                <td class="px-4 py-2 text-red-800">{{ employeeName(s.employee_id) }}</td>
                <td class="px-4 py-2 text-red-800">{{ tenkoTypeLabel(s.tenko_type) }}</td>
                <td class="px-4 py-2 text-red-800">{{ formatDate(s.scheduled_at) }}</td>
                <td class="px-4 py-2 text-red-800">{{ s.responsible_manager_name }}</td>
                <td class="px-4 py-2 text-right text-red-800 font-medium">{{ overdueMinutes(s) }}分</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 更新ボタン -->
      <div class="flex justify-end">
        <button
          :disabled="isLoading"
          class="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors disabled:opacity-50"
          @click="refresh"
        >
          {{ isLoading ? '更新中...' : '更新' }}
        </button>
      </div>
    </template>
  </div>
</template>
