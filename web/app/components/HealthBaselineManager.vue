<script setup lang="ts">
import type { EmployeeHealthBaseline, CreateHealthBaseline, UpdateHealthBaseline, ApiEmployee } from '~/types'
import { listBaselines, createBaseline, updateBaseline, deleteBaseline, getEmployees } from '~/utils/api'

const baselines = ref<EmployeeHealthBaseline[]>([])
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

// 未登録従業員
const unregisteredEmployees = computed(() => {
  const registered = new Set(baselines.value.map(b => b.employee_id))
  return employees.value.filter(e => !registered.has(e.id))
})

async function fetchData() {
  isLoading.value = true
  error.value = null
  try {
    baselines.value = await listBaselines()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '取得エラー'
  } finally {
    isLoading.value = false
  }
}

// 新規作成フォーム
const showForm = ref(false)
const isSaving = ref(false)
const newForm = ref<CreateHealthBaseline>({
  employee_id: '',
  baseline_systolic: 120,
  baseline_diastolic: 80,
  baseline_temperature: 36.5,
  systolic_tolerance: 10,
  diastolic_tolerance: 10,
  temperature_tolerance: 0.5,
  measurement_validity_minutes: 30,
})

function resetForm() {
  newForm.value = {
    employee_id: '',
    baseline_systolic: 120,
    baseline_diastolic: 80,
    baseline_temperature: 36.5,
    systolic_tolerance: 10,
    diastolic_tolerance: 10,
    temperature_tolerance: 0.5,
    measurement_validity_minutes: 30,
  }
}

async function handleCreate() {
  if (!newForm.value.employee_id) return
  isSaving.value = true
  error.value = null
  try {
    await createBaseline(newForm.value)
    resetForm()
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
const isUpdating = ref(false)
const editForm = ref<UpdateHealthBaseline>({})

function startEdit(b: EmployeeHealthBaseline) {
  editingId.value = b.employee_id
  editForm.value = {
    baseline_systolic: b.baseline_systolic,
    baseline_diastolic: b.baseline_diastolic,
    baseline_temperature: b.baseline_temperature,
    systolic_tolerance: b.systolic_tolerance,
    diastolic_tolerance: b.diastolic_tolerance,
    temperature_tolerance: b.temperature_tolerance,
    measurement_validity_minutes: b.measurement_validity_minutes,
  }
  deletingId.value = null
}

function cancelEdit() { editingId.value = null }

async function handleUpdate() {
  if (!editingId.value) return
  isUpdating.value = true
  error.value = null
  try {
    await updateBaseline(editingId.value, editForm.value)
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

async function handleDelete(employeeId: string) {
  isDeleting.value = true
  error.value = null
  try {
    await deleteBaseline(employeeId)
    deletingId.value = null
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '削除エラー'
  } finally {
    isDeleting.value = false
  }
}

onMounted(() => { loadEmployees(); fetchData() })
</script>

<template>
  <div>
    <!-- ヘッダ -->
    <div class="bg-white rounded-xl p-4 shadow-sm mb-4">
      <div class="flex items-center justify-between">
        <p class="text-sm text-gray-600">
          登録数: <strong class="text-gray-800">{{ baselines.length }}</strong>
        </p>
        <div class="flex gap-2">
          <button
            class="px-3 py-1.5 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition-colors"
            @click="showForm = !showForm; if (showForm) resetForm()"
          >{{ showForm ? '閉じる' : '+ 新規作成' }}</button>
          <button class="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors" @click="fetchData">更新</button>
        </div>
      </div>
    </div>

    <!-- 新規作成フォーム -->
    <div v-if="showForm" class="bg-white rounded-xl p-4 shadow-sm mb-4">
      <h3 class="text-sm font-medium text-gray-700 mb-3">健康基準値を登録</h3>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <label class="block text-xs text-gray-500 mb-1">乗務員</label>
          <EmployeeSearchSelect v-model="newForm.employee_id" :employees="unregisteredEmployees" placeholder="乗務員を選択 (名前・社員番号で検索)" />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">収縮期 (mmHg)</label>
          <input v-model.number="newForm.baseline_systolic" type="number" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">拡張期 (mmHg)</label>
          <input v-model.number="newForm.baseline_diastolic" type="number" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">体温 (&#8451;)</label>
          <input v-model.number="newForm.baseline_temperature" type="number" step="0.1" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">収縮期 tolerance</label>
          <input v-model.number="newForm.systolic_tolerance" type="number" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">拡張期 tolerance</label>
          <input v-model.number="newForm.diastolic_tolerance" type="number" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">体温 tolerance</label>
          <input v-model.number="newForm.temperature_tolerance" type="number" step="0.1" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">有効時間 (分)</label>
          <input v-model.number="newForm.measurement_validity_minutes" type="number" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
        </div>
      </div>
      <button
        :disabled="!newForm.employee_id || isSaving"
        class="mt-3 px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition-colors disabled:opacity-50"
        @click="handleCreate"
      >{{ isSaving ? '登録中...' : '登録' }}</button>
    </div>

    <!-- エラー -->
    <div v-if="error" class="bg-red-50 text-red-700 p-3 rounded-lg mb-4 text-sm">{{ error }}</div>

    <!-- ローディング -->
    <div v-if="isLoading" class="text-center py-8 text-gray-500">読み込み中...</div>

    <!-- テーブル -->
    <div v-else-if="baselines.length > 0" class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-gray-600">
            <tr>
              <th class="px-4 py-3 text-left font-medium">乗務員</th>
              <th class="px-4 py-3 text-right font-medium">収縮期</th>
              <th class="px-4 py-3 text-right font-medium">拡張期</th>
              <th class="px-4 py-3 text-right font-medium">体温</th>
              <th class="px-4 py-3 text-right font-medium">収縮期±</th>
              <th class="px-4 py-3 text-right font-medium">拡張期±</th>
              <th class="px-4 py-3 text-right font-medium">体温±</th>
              <th class="px-4 py-3 text-right font-medium">有効(分)</th>
              <th class="px-4 py-3 text-center font-medium">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="b in baselines" :key="b.id" class="hover:bg-gray-50">
              <!-- 編集モード -->
              <template v-if="editingId === b.employee_id">
                <td class="px-4 py-3 text-gray-700 font-medium">{{ employeeName(b.employee_id) }}</td>
                <td class="px-4 py-3"><input v-model.number="editForm.baseline_systolic" type="number" class="w-full px-2 py-1 border border-gray-300 rounded text-sm text-right"></td>
                <td class="px-4 py-3"><input v-model.number="editForm.baseline_diastolic" type="number" class="w-full px-2 py-1 border border-gray-300 rounded text-sm text-right"></td>
                <td class="px-4 py-3"><input v-model.number="editForm.baseline_temperature" type="number" step="0.1" class="w-full px-2 py-1 border border-gray-300 rounded text-sm text-right"></td>
                <td class="px-4 py-3"><input v-model.number="editForm.systolic_tolerance" type="number" class="w-full px-2 py-1 border border-gray-300 rounded text-sm text-right"></td>
                <td class="px-4 py-3"><input v-model.number="editForm.diastolic_tolerance" type="number" class="w-full px-2 py-1 border border-gray-300 rounded text-sm text-right"></td>
                <td class="px-4 py-3"><input v-model.number="editForm.temperature_tolerance" type="number" step="0.1" class="w-full px-2 py-1 border border-gray-300 rounded text-sm text-right"></td>
                <td class="px-4 py-3"><input v-model.number="editForm.measurement_validity_minutes" type="number" class="w-full px-2 py-1 border border-gray-300 rounded text-sm text-right"></td>
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
                <td class="px-4 py-3 text-gray-700 font-medium">{{ employeeName(b.employee_id) }}</td>
                <td class="px-4 py-3 text-right text-gray-700">{{ b.baseline_systolic }}</td>
                <td class="px-4 py-3 text-right text-gray-700">{{ b.baseline_diastolic }}</td>
                <td class="px-4 py-3 text-right text-gray-700">{{ b.baseline_temperature.toFixed(1) }}</td>
                <td class="px-4 py-3 text-right text-gray-500">{{ b.systolic_tolerance }}</td>
                <td class="px-4 py-3 text-right text-gray-500">{{ b.diastolic_tolerance }}</td>
                <td class="px-4 py-3 text-right text-gray-500">{{ b.temperature_tolerance.toFixed(1) }}</td>
                <td class="px-4 py-3 text-right text-gray-500">{{ b.measurement_validity_minutes }}</td>
                <td class="px-4 py-3 text-center">
                  <div class="flex justify-center gap-1">
                    <button class="px-2 py-1 text-blue-600 hover:bg-blue-50 rounded text-xs" @click="startEdit(b)">編集</button>
                    <button
                      v-if="deletingId === b.employee_id"
                      :disabled="isDeleting"
                      class="px-2 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700 disabled:opacity-50"
                      @click="handleDelete(b.employee_id)"
                    >{{ isDeleting ? '削除中...' : '本当に削除' }}</button>
                    <button v-else class="px-2 py-1 text-red-600 hover:bg-red-50 rounded text-xs" @click="deletingId = b.employee_id">削除</button>
                  </div>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 空状態 -->
    <div v-else class="text-center py-8 text-gray-500">健康基準値が登録されていません</div>
  </div>
</template>
