<script setup lang="ts">
import type { ApiEmployee } from '~/types'
import { getEmployees, createEmployee, updateEmployee, deleteEmployee, uploadFacePhoto, updateEmployeeFace, approveFace, rejectFace, getTenkoCallDrivers, type TenkoCallDriver } from '~/utils/api'
import { getRawFaceDescriptor, getAllDescriptorsWithTimestamp } from '~/utils/face-db'
import { FACE_MODEL_VERSION } from '~/composables/useFaceDetection'

const employees = ref<ApiEmployee[]>([])
const tenkoDrivers = ref<TenkoCallDriver[]>([])
const isLoading = ref(false)
const error = ref<string | null>(null)

const ROLES = [
  { value: 'driver', label: '運行者' },
  { value: 'manager', label: '運行管理者' },
  { value: 'admin', label: 'システム管理者' },
] as const

// 新規登録フォーム
const showForm = ref(false)
const newName = ref('')
const newCode = ref('')
const newRole = ref<string[]>(['driver'])
const isSaving = ref(false)

// 編集
const editingId = ref<string | null>(null)
const editName = ref('')
const editCode = ref('')
const editRole = ref<string[]>(['driver'])
const isUpdating = ref(false)

// 削除確認
const deletingId = ref<string | null>(null)
const isDeleting = ref(false)

// 顔登録
const faceRegEmployee = ref<ApiEmployee | null>(null)
const faceRegUploading = ref(false)

// ローカル顔データ (IndexedDB)
const localFaceIds = ref(new Set<string>())
const syncingId = ref<string | null>(null)

async function handleCreate() {
  if (!newName.value.trim() || !newCode.value.trim()) return
  isSaving.value = true
  error.value = null
  try {
    await createEmployee({ code: newCode.value.trim(), name: newName.value.trim(), role: newRole.value })
    newName.value = ''
    newCode.value = ''
    newRole.value = ['driver']
    showForm.value = false
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '登録エラー'
  } finally {
    isSaving.value = false
  }
}

function startEdit(emp: ApiEmployee) {
  editingId.value = emp.id
  editName.value = emp.name
  editCode.value = emp.code || ''
  editRole.value = [...emp.role]
  deletingId.value = null
}

function cancelEdit() {
  editingId.value = null
}

async function handleUpdate() {
  if (!editingId.value || !editName.value.trim()) return
  isUpdating.value = true
  error.value = null
  try {
    await updateEmployee(editingId.value, {
      name: editName.value.trim(),
      code: editCode.value.trim() || null,
      role: editRole.value,
    })
    editingId.value = null
    await fetchData()
  } catch (e) {
    if (e instanceof Error && e.message.includes('409')) {
      error.value = 'この社員番号は既に使用されています'
    } else {
      error.value = e instanceof Error ? e.message : '更新エラー'
    }
  } finally {
    isUpdating.value = false
  }
}

async function handleDelete(id: string) {
  isDeleting.value = true
  error.value = null
  try {
    await deleteEmployee(id)
    deletingId.value = null
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '削除エラー'
  } finally {
    isDeleting.value = false
  }
}

function startFaceReg(emp: ApiEmployee) {
  faceRegEmployee.value = emp
  editingId.value = null
  deletingId.value = null
}

function closeFaceReg() {
  faceRegEmployee.value = null
}

async function onFaceRegistered(snapshot: Blob | null) {
  if (!faceRegEmployee.value) return
  error.value = null

  faceRegUploading.value = true
  try {
    let url: string | undefined
    if (snapshot) {
      url = await uploadFacePhoto(snapshot)
    }
    const embedding = await getRawFaceDescriptor(faceRegEmployee.value.id)
    await updateEmployeeFace(faceRegEmployee.value.id, url, embedding ?? undefined, FACE_MODEL_VERSION)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '顔写真アップロードエラー'
  } finally {
    faceRegUploading.value = false
  }

  // 2秒後に自動で閉じてリロード
  setTimeout(async () => {
    faceRegEmployee.value = null
    await fetchData()
  }, 2000)
}

async function fetchLocalFaceData() {
  try {
    const records = await getAllDescriptorsWithTimestamp()
    localFaceIds.value = new Set(records.map(r => r.employeeId))
  } catch {
    // IndexedDB 読み取り失敗は無視
  }
}

async function handleSyncToServer(emp: ApiEmployee) {
  syncingId.value = emp.id
  error.value = null
  try {
    const embedding = await getRawFaceDescriptor(emp.id)
    if (!embedding) {
      error.value = 'ローカルに顔データが見つかりません'
      return
    }
    await updateEmployeeFace(emp.id, undefined, embedding, FACE_MODEL_VERSION)
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '同期エラー'
  } finally {
    syncingId.value = null
  }
}

function faceStatus(emp: ApiEmployee): 'approved' | 'pending' | 'rejected' | 'local' | 'none' {
  if (emp.face_approval_status === 'approved') return 'approved'
  if (emp.face_approval_status === 'pending') return 'pending'
  if (emp.face_approval_status === 'rejected') return 'rejected'
  if (localFaceIds.value.has(emp.id)) return 'local'
  return 'none'
}

const approvingId = ref<string | null>(null)

async function handleApprove(id: string) {
  approvingId.value = id
  error.value = null
  try {
    await approveFace(id)
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '承認エラー'
  } finally {
    approvingId.value = null
  }
}

async function handleReject(id: string) {
  approvingId.value = id
  error.value = null
  try {
    await rejectFace(id)
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '却下エラー'
  } finally {
    approvingId.value = null
  }
}

// employee_code でマッチ
const tenkoDriverMap = computed(() => {
  const map = new Map<string, TenkoCallDriver>()
  for (const d of tenkoDrivers.value) {
    if (d.employee_code) map.set(d.employee_code, d)
  }
  return map
})

function getTenkoDriver(emp: ApiEmployee): TenkoCallDriver | undefined {
  if (!emp.code) return undefined
  return tenkoDriverMap.value.get(emp.code)
}

async function fetchData() {
  isLoading.value = true
  error.value = null
  try {
    const [emps, drivers] = await Promise.all([
      getEmployees(),
      getTenkoCallDrivers().catch(() => [] as TenkoCallDriver[]),
    ])
    employees.value = emps
    tenkoDrivers.value = drivers
  } catch (e) {
    error.value = e instanceof Error ? e.message : '取得エラー'
  } finally {
    isLoading.value = false
  }
  await fetchLocalFaceData()
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

const faceRegisteredCount = computed(() =>
  employees.value.filter(e => e.face_approval_status === 'approved').length
)

const facePendingCount = computed(() =>
  employees.value.filter(e => e.face_approval_status === 'pending').length
)

const localOnlyCount = computed(() =>
  employees.value.filter(e => faceStatus(e) === 'local').length
)

const nfcLinkedCount = computed(() =>
  employees.value.filter(e => e.nfc_id).length
)

onMounted(() => fetchData())
</script>

<template>
  <div>
    <!-- 顔登録モーダル -->
    <div
      v-if="faceRegEmployee"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="closeFaceReg"
    >
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold text-gray-800">
            顔登録: {{ faceRegEmployee.name }}
          </h3>
          <button
            class="text-gray-400 hover:text-gray-600 text-xl leading-none"
            @click="closeFaceReg"
          >
            &times;
          </button>
        </div>

        <FaceAuth
          :employee-id="faceRegEmployee.id"
          mode="register"
          @registered="onFaceRegistered"
        />

        <p v-if="faceRegUploading" class="mt-3 text-sm text-blue-600 text-center">
          写真アップロード中...
        </p>
      </div>
    </div>

    <!-- サマリ -->
    <div class="bg-white rounded-xl p-4 shadow-sm mb-4">
      <div class="flex items-center gap-6 text-sm text-gray-600">
        <span>登録数: <strong class="text-gray-800">{{ employees.length }}</strong> 名</span>
        <span>顔承認済: <strong class="text-green-700">{{ faceRegisteredCount }}</strong></span>
        <span v-if="facePendingCount > 0" class="text-yellow-700">承認待ち: <strong>{{ facePendingCount }}</strong></span>
        <span v-if="localOnlyCount > 0" class="text-yellow-700">ローカルのみ: <strong>{{ localOnlyCount }}</strong></span>
        <span>NFC紐付: <strong class="text-blue-700">{{ nfcLinkedCount }}</strong></span>
        <div class="ml-auto flex gap-2">
          <button
            class="px-3 py-1.5 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition-colors"
            @click="showForm = !showForm"
          >
            {{ showForm ? '閉じる' : '+ 新規登録' }}
          </button>
          <button
            class="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors"
            @click="fetchData"
          >
            更新
          </button>
        </div>
      </div>
    </div>

    <!-- 新規登録フォーム -->
    <div v-if="showForm" class="bg-white rounded-xl p-4 shadow-sm mb-4">
      <h3 class="text-sm font-medium text-gray-700 mb-3">乗務員を登録</h3>
      <div class="flex gap-3 items-end">
        <div class="flex-1">
          <label class="block text-xs text-gray-500 mb-1">社員番号</label>
          <input
            v-model="newCode"
            type="text"
            placeholder="001"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
        </div>
        <div class="flex-1">
          <label class="block text-xs text-gray-500 mb-1">名前</label>
          <input
            v-model="newName"
            type="text"
            placeholder="山田 太郎"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
        </div>
        <div class="flex items-end gap-2">
          <div>
            <label class="block text-xs text-gray-500 mb-1">ロール</label>
            <div class="flex gap-2">
              <label v-for="r in ROLES" :key="r.value" class="flex items-center gap-1 text-xs cursor-pointer">
                <input type="checkbox" :value="r.value" v-model="newRole" class="rounded">
                {{ r.label }}
              </label>
            </div>
          </div>
          <button
            :disabled="!newName.trim() || !newCode.trim() || newRole.length === 0 || isSaving"
            class="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition-colors disabled:opacity-50"
            @click="handleCreate"
          >
            {{ isSaving ? '登録中...' : '登録' }}
          </button>
        </div>
      </div>
      <p class="mt-2 text-xs text-gray-400">NFC カードは測定端末でタッチして紐付けます</p>
    </div>

    <!-- エラー -->
    <div v-if="error" class="bg-red-50 text-red-700 p-3 rounded-lg mb-4 text-sm">
      {{ error }}
    </div>

    <!-- ローディング -->
    <div v-if="isLoading" class="text-center py-8 text-gray-500">
      読み込み中...
    </div>

    <!-- テーブル -->
    <div v-else-if="employees.length > 0" class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-gray-600">
            <tr>
              <th class="px-4 py-3 text-left font-medium">社員番号</th>
              <th class="px-4 py-3 text-left font-medium">名前</th>
              <th class="px-4 py-3 text-left font-medium">ロール</th>
              <th class="px-4 py-3 text-center font-medium">NFC</th>
              <th class="px-4 py-3 text-center font-medium">顔登録</th>
              <th class="px-4 py-3 text-center font-medium">中間点呼</th>
              <th class="px-4 py-3 text-left font-medium">登録日</th>
              <th class="px-4 py-3 text-center font-medium">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="emp in employees" :key="emp.id" class="hover:bg-gray-50">
              <!-- 編集モード -->
              <template v-if="editingId === emp.id">
                <td class="px-4 py-3">
                  <input
                    v-model="editCode"
                    type="text"
                    placeholder="001"
                    class="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  >
                </td>
                <td class="px-4 py-3">
                  <input
                    v-model="editName"
                    type="text"
                    placeholder="名前"
                    class="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    @keyup.enter="handleUpdate"
                  >
                </td>
                <td class="px-4 py-3">
                  <div class="flex flex-col gap-1">
                    <label v-for="r in ROLES" :key="r.value" class="flex items-center gap-1 text-xs cursor-pointer">
                      <input type="checkbox" :value="r.value" v-model="editRole" class="rounded">
                      {{ r.label }}
                    </label>
                  </div>
                </td>
                <td class="px-4 py-3 text-center">
                  <span
                    v-if="emp.nfc_id"
                    class="inline-block px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800"
                  >済</span>
                  <span v-else class="inline-block px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-500">未</span>
                </td>
                <td class="px-4 py-3 text-center">
                  <span
                    v-if="faceStatus(emp) === 'approved'"
                    class="inline-block px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800"
                  >承認済</span>
                  <span
                    v-else-if="faceStatus(emp) === 'pending'"
                    class="inline-block px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800"
                  >承認待ち</span>
                  <span
                    v-else-if="faceStatus(emp) === 'rejected'"
                    class="inline-block px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800"
                  >却下</span>
                  <span
                    v-else-if="faceStatus(emp) === 'local'"
                    class="inline-block px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800"
                  >ローカルのみ</span>
                  <span v-else class="inline-block px-2 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-800">未登録</span>
                </td>
                <td class="px-4 py-3 text-center">
                  <template v-if="getTenkoDriver(emp)">
                    <span class="text-xs font-mono text-gray-600">{{ getTenkoDriver(emp)!.phone_number }}</span>
                  </template>
                  <span v-else class="text-xs text-gray-400">-</span>
                </td>
                <td class="px-4 py-3 text-gray-600">{{ formatDate(emp.created_at) }}</td>
                <td class="px-4 py-3 text-center">
                  <div class="flex justify-center gap-1">
                    <button
                      :disabled="!editName.trim() || isUpdating"
                      class="px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-50"
                      @click="handleUpdate"
                    >
                      {{ isUpdating ? '保存中...' : '保存' }}
                    </button>
                    <button
                      class="px-2 py-1 bg-gray-200 text-gray-700 rounded text-xs hover:bg-gray-300"
                      @click="cancelEdit"
                    >
                      取消
                    </button>
                  </div>
                </td>
              </template>

              <!-- 通常表示 -->
              <template v-else>
                <td class="px-4 py-3 text-gray-800 font-mono">{{ emp.code || '-' }}</td>
                <td class="px-4 py-3 text-gray-800 font-medium">{{ emp.name }}</td>
                <td class="px-4 py-3">
                  <div class="flex flex-wrap gap-1">
                    <span
                      v-for="r in emp.role" :key="r"
                      class="inline-block px-1.5 py-0.5 rounded text-xs font-medium"
                      :class="{
                        'bg-gray-100 text-gray-700': r === 'driver',
                        'bg-blue-100 text-blue-800': r === 'manager',
                        'bg-purple-100 text-purple-800': r === 'admin',
                      }"
                    >{{ ROLES.find(x => x.value === r)?.label ?? r }}</span>
                  </div>
                </td>
                <td class="px-4 py-3 text-center">
                  <span
                    v-if="emp.nfc_id"
                    class="inline-block px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800"
                  >済</span>
                  <span v-else class="inline-block px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-500">未</span>
                </td>
                <td class="px-4 py-3 text-center">
                  <span
                    v-if="faceStatus(emp) === 'approved'"
                    class="inline-block px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800"
                  >承認済</span>
                  <span
                    v-else-if="faceStatus(emp) === 'pending'"
                    class="inline-block px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800"
                  >承認待ち</span>
                  <span
                    v-else-if="faceStatus(emp) === 'rejected'"
                    class="inline-block px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800"
                  >却下</span>
                  <span
                    v-else-if="faceStatus(emp) === 'local'"
                    class="inline-block px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800"
                  >ローカルのみ</span>
                  <span v-else class="inline-block px-2 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-800">未登録</span>
                </td>
                <td class="px-4 py-3 text-center">
                  <template v-if="getTenkoDriver(emp)">
                    <span class="text-xs font-mono text-gray-600">{{ getTenkoDriver(emp)!.phone_number }}</span>
                  </template>
                  <span v-else class="text-xs text-gray-400">-</span>
                </td>
                <td class="px-4 py-3 text-gray-600">{{ formatDate(emp.created_at) }}</td>
                <td class="px-4 py-3 text-center">
                  <div class="flex justify-center gap-1">
                    <button
                      v-if="faceStatus(emp) === 'local'"
                      :disabled="syncingId === emp.id"
                      class="px-2 py-1 text-yellow-700 hover:bg-yellow-50 rounded text-xs"
                      @click="handleSyncToServer(emp)"
                    >
                      {{ syncingId === emp.id ? '同期中...' : '同期' }}
                    </button>
                    <button
                      v-if="faceStatus(emp) === 'pending'"
                      :disabled="approvingId === emp.id"
                      class="px-2 py-1 text-green-700 hover:bg-green-50 rounded text-xs font-medium"
                      @click="handleApprove(emp.id)"
                    >
                      承認
                    </button>
                    <button
                      v-if="faceStatus(emp) === 'pending'"
                      :disabled="approvingId === emp.id"
                      class="px-2 py-1 text-red-600 hover:bg-red-50 rounded text-xs"
                      @click="handleReject(emp.id)"
                    >
                      却下
                    </button>
                    <button
                      class="px-2 py-1 text-green-600 hover:bg-green-50 rounded text-xs"
                      @click="startFaceReg(emp)"
                    >
                      顔登録
                    </button>
                    <button
                      class="px-2 py-1 text-blue-600 hover:bg-blue-50 rounded text-xs"
                      @click="startEdit(emp)"
                    >
                      編集
                    </button>
                    <button
                      v-if="deletingId === emp.id"
                      :disabled="isDeleting"
                      class="px-2 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700 disabled:opacity-50"
                      @click="handleDelete(emp.id)"
                    >
                      {{ isDeleting ? '削除中...' : '本当に削除' }}
                    </button>
                    <button
                      v-else
                      class="px-2 py-1 text-red-600 hover:bg-red-50 rounded text-xs"
                      @click="deletingId = emp.id"
                    >
                      削除
                    </button>
                  </div>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 空状態 -->
    <div v-else class="text-center py-8 text-gray-500">
      乗務員が登録されていません
    </div>
  </div>
</template>
