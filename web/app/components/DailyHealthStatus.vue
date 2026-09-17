<script setup lang="ts">
import type { DailyHealthRow, DailyHealthResponse } from '~/types'
import { getDailyHealthStatus } from '~/utils/api'
import { alcoholResultClass, alcoholResultLabel } from '~/utils/alcohol'

const data = ref<DailyHealthResponse | null>(null)
const loading = ref(false)
const selectedDate = ref(new Date().toLocaleDateString('sv-SE')) // YYYY-MM-DD
const selectedEmployeeId = ref<string | null>(null)

let refreshTimer: ReturnType<typeof setInterval> | undefined

async function load() {
  loading.value = true
  try {
    data.value = await getDailyHealthStatus(selectedDate.value)
  } catch (e) {
    console.error('日常健康状態取得エラー:', e)
  } finally {
    loading.value = false
  }
}

watch(selectedDate, load)
onMounted(() => {
  load()
  refreshTimer = setInterval(load, 60_000)
})
onUnmounted(() => { if (refreshTimer) clearInterval(refreshTimer) })

// pass / fail は遠隔点呼だけの値で helper に無いのでここに残す
function alcoholLabel(r: string) {
  const extra: Record<string, string> = { pass: '正常', fail: '検出' }
  return extra[r] ?? alcoholResultLabel(r)
}

function alcoholClass(r: string) {
  return alcoholResultClass(r === 'pass' ? 'normal' : r)
}

function formatTime(d: string | null) {
  if (!d) return '-'
  return new Date(d).toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}

function tempDiff(row: DailyHealthRow): string {
  if (row.temperature == null || row.baseline_temperature == null) return ''
  const diff = row.temperature - row.baseline_temperature
  return `(${diff >= 0 ? '+' : ''}${diff.toFixed(1)})`
}

function bpDiff(row: DailyHealthRow, key: 'systolic' | 'diastolic'): string {
  const val = row[key]
  const base = key === 'systolic' ? row.baseline_systolic : row.baseline_diastolic
  if (val == null || base == null) return ''
  const diff = val - base
  return `${diff >= 0 ? '+' : ''}${diff}`
}

function isTempOver(row: DailyHealthRow): boolean {
  if (row.temperature == null || row.baseline_temperature == null || row.temperature_tolerance == null) return false
  return Math.abs(row.temperature - row.baseline_temperature) > row.temperature_tolerance
}

function isBpOver(row: DailyHealthRow, key: 'systolic' | 'diastolic'): boolean {
  const val = row[key]
  const base = key === 'systolic' ? row.baseline_systolic : row.baseline_diastolic
  const tol = key === 'systolic' ? row.systolic_tolerance : row.diastolic_tolerance
  if (val == null || base == null || tol == null) return false
  return Math.abs(val - base) > tol
}

function selfDeclLabel(row: DailyHealthRow): string {
  if (!row.self_declaration) return '-'
  const items: string[] = []
  if (row.self_declaration.illness) items.push('病気')
  if (row.self_declaration.fatigue) items.push('疲労')
  if (row.self_declaration.sleep_deprivation) items.push('睡眠不足')
  return items.length > 0 ? items.join(', ') : '異常なし'
}

function hasSelfDeclIssue(row: DailyHealthRow): boolean {
  if (!row.self_declaration) return false
  return row.self_declaration.illness || row.self_declaration.fatigue || row.self_declaration.sleep_deprivation
}

function judgmentStatus(row: DailyHealthRow): 'pass' | 'fail' | null {
  if (!row.safety_judgment) return null
  return row.safety_judgment.status as 'pass' | 'fail'
}

function rowBg(row: DailyHealthRow): string {
  const j = judgmentStatus(row)
  if (j === 'fail') return 'bg-red-50'
  if (!row.session_id) return 'bg-gray-50'
  return ''
}
</script>

<template>
  <div class="space-y-4">
    <!-- Header -->
    <div class="flex items-center justify-between flex-wrap gap-2">
      <h2 class="text-lg font-bold text-gray-800">日常健康状態</h2>
      <div class="flex items-center gap-2">
        <input
          v-model="selectedDate"
          type="date"
          class="border rounded px-2 py-1 text-sm"
        />
        <button
          class="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
          :disabled="loading"
          @click="load"
        >
          更新
        </button>
      </div>
    </div>

    <!-- Summary Cards -->
    <div v-if="data" class="grid grid-cols-2 sm:grid-cols-5 gap-2">
      <div class="bg-white border rounded-lg p-3 text-center">
        <div class="text-2xl font-bold text-gray-800">{{ data.summary.total_employees }}</div>
        <div class="text-xs text-gray-500">全従業員</div>
      </div>
      <div class="bg-white border rounded-lg p-3 text-center">
        <div class="text-2xl font-bold text-blue-600">{{ data.summary.checked_count }}</div>
        <div class="text-xs text-gray-500">確認済</div>
      </div>
      <div class="bg-white border rounded-lg p-3 text-center">
        <div class="text-2xl font-bold text-gray-400">{{ data.summary.unchecked_count }}</div>
        <div class="text-xs text-gray-500">未確認</div>
      </div>
      <div class="bg-white border rounded-lg p-3 text-center">
        <div class="text-2xl font-bold text-green-600">{{ data.summary.pass_count }}</div>
        <div class="text-xs text-gray-500">合格</div>
      </div>
      <div class="bg-white border rounded-lg p-3 text-center">
        <div class="text-2xl font-bold text-red-600">{{ data.summary.fail_count }}</div>
        <div class="text-xs text-gray-500">不合格</div>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading && !data" class="text-center py-8 text-gray-400">読み込み中...</div>

    <!-- Table -->
    <div v-if="data" class="overflow-x-auto border rounded-lg">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-gray-100 text-gray-600 text-xs">
            <th class="px-3 py-2 text-left whitespace-nowrap">従業員</th>
            <th class="px-3 py-2 text-center whitespace-nowrap">確認</th>
            <th class="px-3 py-2 text-center whitespace-nowrap">時刻</th>
            <th class="px-3 py-2 text-center whitespace-nowrap">体温</th>
            <th class="px-3 py-2 text-center whitespace-nowrap">血圧</th>
            <th class="px-3 py-2 text-center whitespace-nowrap">脈拍</th>
            <th class="px-3 py-2 text-center whitespace-nowrap">アルコール</th>
            <th class="px-3 py-2 text-center whitespace-nowrap">自己申告</th>
            <th class="px-3 py-2 text-center whitespace-nowrap">判定</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in data.employees"
            :key="row.employee_id"
            class="border-t cursor-pointer hover:bg-blue-50 transition-colors"
            :class="rowBg(row)"
            @click="selectedEmployeeId = row.employee_id"
          >
            <!-- 従業員 -->
            <td class="px-3 py-2 whitespace-nowrap">
              <div class="font-medium">{{ row.employee_name }}</div>
              <div v-if="row.employee_code" class="text-xs text-gray-400">{{ row.employee_code }}</div>
            </td>
            <!-- 確認状態 -->
            <td class="px-3 py-2 text-center">
              <span v-if="row.session_id" class="text-green-600 font-bold">&#10003;</span>
              <span v-else class="text-gray-300">-</span>
            </td>
            <!-- 時刻 -->
            <td class="px-3 py-2 text-center text-xs">
              {{ formatTime(row.completed_at) }}
            </td>
            <!-- 体温 -->
            <td class="px-3 py-2 text-center whitespace-nowrap">
              <template v-if="row.temperature != null">
                <span :class="isTempOver(row) ? 'text-red-600 font-bold' : ''">
                  {{ row.temperature.toFixed(1) }}&#176;C
                </span>
                <span v-if="row.has_baseline" class="text-xs ml-0.5" :class="isTempOver(row) ? 'text-red-400' : 'text-gray-400'">
                  {{ tempDiff(row) }}
                </span>
              </template>
              <span v-else class="text-gray-300">-</span>
            </td>
            <!-- 血圧 -->
            <td class="px-3 py-2 text-center whitespace-nowrap">
              <template v-if="row.systolic != null && row.diastolic != null">
                <span :class="isBpOver(row, 'systolic') || isBpOver(row, 'diastolic') ? 'text-red-600 font-bold' : ''">
                  {{ row.systolic }}/{{ row.diastolic }}
                </span>
                <span v-if="row.has_baseline" class="text-xs ml-0.5" :class="isBpOver(row, 'systolic') || isBpOver(row, 'diastolic') ? 'text-red-400' : 'text-gray-400'">
                  ({{ bpDiff(row, 'systolic') }}/{{ bpDiff(row, 'diastolic') }})
                </span>
              </template>
              <span v-else class="text-gray-300">-</span>
            </td>
            <!-- 脈拍 -->
            <td class="px-3 py-2 text-center">
              {{ row.pulse ?? '-' }}
            </td>
            <!-- アルコール -->
            <td class="px-3 py-2 text-center whitespace-nowrap">
              <template v-if="row.alcohol_result">
                <span
                  class="px-1.5 py-0.5 rounded text-xs font-medium"
                  :class="alcoholClass(row.alcohol_result)"
                >
                  {{ row.alcohol_value != null ? row.alcohol_value.toFixed(2) : '' }}
                  {{ alcoholLabel(row.alcohol_result) }}
                </span>
              </template>
              <span v-else class="text-gray-300">-</span>
            </td>
            <!-- 自己申告 -->
            <td class="px-3 py-2 text-center whitespace-nowrap">
              <span
                v-if="row.self_declaration"
                class="text-xs"
                :class="hasSelfDeclIssue(row) ? 'text-red-600 font-bold' : 'text-green-600'"
              >
                {{ selfDeclLabel(row) }}
              </span>
              <span v-else class="text-gray-300">-</span>
            </td>
            <!-- 安全判定 -->
            <td class="px-3 py-2 text-center">
              <span
                v-if="judgmentStatus(row) === 'pass'"
                class="px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700"
              >合格</span>
              <span
                v-else-if="judgmentStatus(row) === 'fail'"
                class="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700"
                :title="row.safety_judgment?.failed_items?.join(', ')"
              >不合格</span>
              <span v-else class="text-gray-300">-</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="data.employees.length === 0" class="text-center py-8 text-gray-400">従業員が登録されていません</div>
    </div>

    <!-- Detail Panel -->
    <TenkoDriverInfoPanel
      v-if="selectedEmployeeId"
      :employee-id="selectedEmployeeId"
      @close="selectedEmployeeId = null"
    />
  </div>
</template>
