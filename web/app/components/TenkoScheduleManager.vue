<script setup lang="ts">
import type { TenkoSchedule, TenkoScheduleFilter, CreateTenkoSchedule, ApiEmployee, TenkoType } from '~/types'
import { listSchedules, createSchedule, batchCreateSchedules, updateSchedule, deleteSchedule, getEmployees } from '~/utils/api'
import { tenkoTypeLabel } from '~/utils/tenko-type'

const schedules = ref<TenkoSchedule[]>([])
const total = ref(0)
const page = ref(1)
const perPage = 20
const isLoading = ref(false)
const error = ref<string | null>(null)

// 従業員マップ
const employees = ref<ApiEmployee[]>([])
const employeeMap = ref<Record<string, string>>({})
async function loadEmployees() {
  try {
    const list = await getEmployees()
    employees.value = list
    employeeMap.value = Object.fromEntries(list.map(e => [e.id, e.name]))
  } catch {}
}
function employeeName(id: string) {
  return employeeMap.value[id] || id.slice(0, 8)
}

// フィルタ
const filterEmployeeId = ref('')
const filterTenkoType = ref<'' | TenkoType>('')
const filterConsumed = ref<'' | 'true' | 'false'>('')
const filterDateFrom = ref('')
const filterDateTo = ref('')

async function fetchData() {
  isLoading.value = true
  error.value = null
  try {
    const filter: TenkoScheduleFilter = { page: page.value, per_page: perPage }
    if (filterEmployeeId.value) filter.employee_id = filterEmployeeId.value
    if (filterTenkoType.value) filter.tenko_type = filterTenkoType.value
    if (filterConsumed.value) filter.consumed = filterConsumed.value === 'true'
    if (filterDateFrom.value) filter.date_from = filterDateFrom.value
    if (filterDateTo.value) filter.date_to = filterDateTo.value
    const res = await listSchedules(filter)
    schedules.value = res.schedules
    total.value = res.total
  } catch (e) {
    error.value = e instanceof Error ? e.message : '取得エラー'
  } finally {
    isLoading.value = false
  }
}

function applyFilter() { page.value = 1; fetchData() }
function changePage(p: number) { page.value = p; fetchData() }
const totalPages = computed(() => Math.ceil(total.value / perPage))

// 新規作成
const showForm = ref(false)
const isSaving = ref(false)
const newRows = ref<{ employee_id: string; tenko_type: TenkoType; scheduled_at: string; responsible_manager_name: string; instruction: string }[]>([])

function addRow() {
  newRows.value.push({ employee_id: '', tenko_type: 'pre_operation', scheduled_at: '', responsible_manager_name: '', instruction: '' })
}

function removeRow(i: number) {
  newRows.value.splice(i, 1)
}

async function handleCreate() {
  const valid = newRows.value.filter(r => r.employee_id && r.scheduled_at && r.responsible_manager_name)
  if (valid.length === 0) return
  isSaving.value = true
  error.value = null
  try {
    const data: CreateTenkoSchedule[] = valid.map(r => ({
      employee_id: r.employee_id,
      tenko_type: r.tenko_type,
      scheduled_at: new Date(r.scheduled_at).toISOString(),
      responsible_manager_name: r.responsible_manager_name,
      instruction: r.instruction || undefined,
    }))
    if (data.length === 1) {
      await createSchedule(data[0]!)
    } else {
      await batchCreateSchedules(data)
    }
    newRows.value = []
    showForm.value = false
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '作成エラー'
  } finally {
    isSaving.value = false
  }
}

// 編集
const editingId = ref<string | null>(null)
const editManager = ref('')
const editScheduledAt = ref('')
const editInstruction = ref('')
const isUpdating = ref(false)

function startEdit(s: TenkoSchedule) {
  editingId.value = s.id
  editManager.value = s.responsible_manager_name
  editScheduledAt.value = s.scheduled_at.slice(0, 16)
  editInstruction.value = s.instruction || ''
  deletingId.value = null
}

function cancelEdit() { editingId.value = null }

async function handleUpdate() {
  if (!editingId.value || !editManager.value.trim()) return
  isUpdating.value = true
  error.value = null
  try {
    await updateSchedule(editingId.value, {
      responsible_manager_name: editManager.value.trim(),
      scheduled_at: new Date(editScheduledAt.value).toISOString(),
      instruction: editInstruction.value.trim() || undefined,
    })
    editingId.value = null
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '更新エラー'
  } finally {
    isUpdating.value = false
  }
}

// 削除
const deletingId = ref<string | null>(null)
const isDeleting = ref(false)

async function handleDelete(id: string) {
  isDeleting.value = true
  error.value = null
  try {
    await deleteSchedule(id)
    deletingId.value = null
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '削除エラー'
  } finally {
    isDeleting.value = false
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

onMounted(() => { loadEmployees(); fetchData() })
</script>

<template>
  <div>
    <!-- フィルタ -->
    <div class="bg-white rounded-xl p-4 shadow-sm mb-4">
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <select v-model="filterEmployeeId" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">全乗務員</option>
          <option v-for="emp in employees" :key="emp.id" :value="emp.id">{{ emp.name }}</option>
        </select>
        <select v-model="filterTenkoType" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">全種別</option>
          <option value="pre_operation">{{ tenkoTypeLabel('pre_operation') }}</option>
          <option value="post_operation">{{ tenkoTypeLabel('post_operation') }}</option>
        </select>
        <select v-model="filterConsumed" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">全状態</option>
          <option value="false">未消費</option>
          <option value="true">消費済</option>
        </select>
        <input v-model="filterDateFrom" type="date" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        <input v-model="filterDateTo" type="date" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      </div>
      <div class="flex gap-2 mt-3">
        <button class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors" @click="applyFilter">検索</button>
        <button class="px-3 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition-colors" @click="showForm = !showForm; if (showForm && newRows.length === 0) addRow()">
          {{ showForm ? '閉じる' : '+ 新規作成' }}
        </button>
      </div>
    </div>

    <!-- 新規作成フォーム -->
    <div v-if="showForm" class="bg-white rounded-xl p-4 shadow-sm mb-4">
      <h3 class="text-sm font-medium text-gray-700 mb-3">スケジュール作成</h3>
      <div v-for="(row, i) in newRows" :key="i" class="grid grid-cols-1 sm:grid-cols-6 gap-2 mb-2">
        <select v-model="row.employee_id" class="px-2 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">乗務員</option>
          <option v-for="emp in employees" :key="emp.id" :value="emp.id">{{ emp.name }}</option>
        </select>
        <select v-model="row.tenko_type" class="px-2 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="pre_operation">{{ tenkoTypeLabel('pre_operation') }}</option>
          <option value="post_operation">{{ tenkoTypeLabel('post_operation') }}</option>
        </select>
        <input v-model="row.scheduled_at" type="datetime-local" class="px-2 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        <input v-model="row.responsible_manager_name" type="text" placeholder="管理者名" class="px-2 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        <input v-model="row.instruction" type="text" placeholder="指示事項 (任意)" class="px-2 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        <button class="px-2 py-2 text-red-600 hover:bg-red-50 rounded-lg text-sm" @click="removeRow(i)">削除</button>
      </div>
      <div class="flex gap-2 mt-2">
        <button class="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50" @click="addRow">+ 行追加</button>
        <button
          :disabled="isSaving || newRows.every(r => !r.employee_id || !r.scheduled_at || !r.responsible_manager_name)"
          class="px-4 py-1.5 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition-colors disabled:opacity-50"
          @click="handleCreate"
        >
          {{ isSaving ? '作成中...' : '作成' }}
        </button>
      </div>
    </div>

    <!-- エラー -->
    <div v-if="error" class="bg-red-50 text-red-700 p-3 rounded-lg mb-4 text-sm">{{ error }}</div>

    <!-- ローディング -->
    <div v-if="isLoading" class="text-center py-8 text-gray-500">読み込み中...</div>

    <!-- テーブル -->
    <div v-else-if="schedules.length > 0" class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-gray-600">
            <tr>
              <th class="px-4 py-3 text-left font-medium">乗務員</th>
              <th class="px-4 py-3 text-center font-medium">種別</th>
              <th class="px-4 py-3 text-left font-medium">予定日時</th>
              <th class="px-4 py-3 text-left font-medium">管理者</th>
              <th class="px-4 py-3 text-left font-medium">指示</th>
              <th class="px-4 py-3 text-center font-medium">状態</th>
              <th class="px-4 py-3 text-center font-medium">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="s in schedules" :key="s.id" class="hover:bg-gray-50">
              <!-- 編集モード -->
              <template v-if="editingId === s.id">
                <td class="px-4 py-3 text-gray-700">{{ employeeName(s.employee_id) }}</td>
                <td class="px-4 py-3 text-center text-gray-700">{{ tenkoTypeLabel(s.tenko_type) }}</td>
                <td class="px-4 py-3">
                  <input v-model="editScheduledAt" type="datetime-local" class="w-full px-2 py-1 border border-gray-300 rounded text-sm">
                </td>
                <td class="px-4 py-3">
                  <input v-model="editManager" type="text" class="w-full px-2 py-1 border border-gray-300 rounded text-sm">
                </td>
                <td class="px-4 py-3">
                  <input v-model="editInstruction" type="text" class="w-full px-2 py-1 border border-gray-300 rounded text-sm">
                </td>
                <td class="px-4 py-3 text-center">
                  <span class="inline-block px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">未消費</span>
                </td>
                <td class="px-4 py-3 text-center">
                  <div class="flex justify-center gap-1">
                    <button :disabled="isUpdating" class="px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-50" @click="handleUpdate">
                      {{ isUpdating ? '保存中...' : '保存' }}
                    </button>
                    <button class="px-2 py-1 bg-gray-200 text-gray-700 rounded text-xs hover:bg-gray-300" @click="cancelEdit">取消</button>
                  </div>
                </td>
              </template>

              <!-- 通常表示 -->
              <template v-else>
                <td class="px-4 py-3 text-gray-700">{{ employeeName(s.employee_id) }}</td>
                <td class="px-4 py-3 text-center">
                  <span
                    class="inline-block px-2 py-1 rounded-full text-xs font-medium"
                    :class="s.tenko_type === 'pre_operation' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'"
                  >{{ tenkoTypeLabel(s.tenko_type) }}</span>
                </td>
                <td class="px-4 py-3 text-gray-700">{{ formatDate(s.scheduled_at) }}</td>
                <td class="px-4 py-3 text-gray-700">{{ s.responsible_manager_name }}</td>
                <td class="px-4 py-3 text-gray-500 truncate max-w-[200px]">{{ s.instruction || '-' }}</td>
                <td class="px-4 py-3 text-center">
                  <span
                    class="inline-block px-2 py-1 rounded-full text-xs font-medium"
                    :class="s.consumed ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'"
                  >{{ s.consumed ? '消費済' : '未消費' }}</span>
                </td>
                <td class="px-4 py-3 text-center">
                  <div v-if="!s.consumed" class="flex justify-center gap-1">
                    <button class="px-2 py-1 text-blue-600 hover:bg-blue-50 rounded text-xs" @click="startEdit(s)">編集</button>
                    <button
                      v-if="deletingId === s.id"
                      :disabled="isDeleting"
                      class="px-2 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700 disabled:opacity-50"
                      @click="handleDelete(s.id)"
                    >{{ isDeleting ? '削除中...' : '本当に削除' }}</button>
                    <button v-else class="px-2 py-1 text-red-600 hover:bg-red-50 rounded text-xs" @click="deletingId = s.id">削除</button>
                  </div>
                  <span v-else class="text-gray-400 text-xs">-</span>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ページネーション -->
      <div v-if="totalPages > 1" class="flex items-center justify-between px-4 py-3 border-t border-gray-100">
        <p class="text-sm text-gray-500">全 {{ total }} 件中 {{ (page - 1) * perPage + 1 }}-{{ Math.min(page * perPage, total) }} 件</p>
        <div class="flex gap-1">
          <button :disabled="page <= 1" class="px-3 py-1 text-sm rounded border border-gray-300 disabled:opacity-50 hover:bg-gray-50" @click="changePage(page - 1)">前</button>
          <button :disabled="page >= totalPages" class="px-3 py-1 text-sm rounded border border-gray-300 disabled:opacity-50 hover:bg-gray-50" @click="changePage(page + 1)">次</button>
        </div>
      </div>
    </div>

    <!-- 空状態 -->
    <div v-else class="text-center py-8 text-gray-500">スケジュールがありません</div>
  </div>
</template>
