<script setup lang="ts">
import type { GuidanceRecord, GuidanceRecordAttachment, ApiEmployee } from '~/types'
import { listGuidanceRecords, createGuidanceRecord, deleteGuidanceRecord, getEmployees, uploadGuidanceAttachment, deleteGuidanceAttachment } from '~/utils/api'

const records = ref<GuidanceRecord[]>([])
const employees = ref<ApiEmployee[]>([])
const loading = ref(false)
const total = ref(0)
const page = ref(1)
const perPage = 20

// Filters
const filterEmployee = ref('')
const filterType = ref('')

// Form state
const showForm = ref(false)
const formParentId = ref<string | null>(null)
const formParentTitle = ref('')
const newEmployeeSearch = ref('')
const newEmployeeId = ref('')
const showDropdown = ref(false)
const newType = ref('general')
const newTitle = ref('')
const newContent = ref('')
const newGuidedBy = ref('')
const showGuidedByDropdown = ref(false)
const newGuidedAt = ref(new Date().toISOString().slice(0, 16))
const saving = ref(false)

// Expanded records
const expandedIds = ref(new Set<string>())

// Upload state
const uploadingId = ref<string | null>(null)

const GUIDANCE_TYPES = [
  { value: 'general', label: '一般' },
  { value: 'safety', label: '安全運転' },
  { value: 'legal', label: '法令遵守' },
  { value: 'skill', label: '技能向上' },
  { value: 'other', label: 'その他' },
]

function typeLabel(value: string): string {
  return GUIDANCE_TYPES.find(t => t.value === value)?.label ?? value
}

function typeColor(value: string): string {
  const map: Record<string, string> = {
    general: 'bg-blue-100 text-blue-700',
    safety: 'bg-green-100 text-green-700',
    legal: 'bg-yellow-100 text-yellow-700',
    skill: 'bg-purple-100 text-purple-700',
    other: 'bg-gray-100 text-gray-600',
  }
  return map[value] || map.other!
}

// Employee search (対象者)
const employeeSearchResults = computed(() => {
  const q = newEmployeeSearch.value.trim().toLowerCase()
  if (!q) return employees.value
  return employees.value.filter(e =>
    e.name.toLowerCase().includes(q) || (e.code && e.code.toLowerCase().includes(q))
  )
})

const employeeHighlight = ref(-1)

function selectEmployee(emp: ApiEmployee) {
  newEmployeeId.value = emp.id
  newEmployeeSearch.value = emp.code ? `${emp.code} - ${emp.name}` : emp.name
  showDropdown.value = false
  employeeHighlight.value = -1
}

function onEmployeeInput() { newEmployeeId.value = ''; showDropdown.value = true; employeeHighlight.value = -1 }
function onEmployeeFocus() { if (!newEmployeeId.value) showDropdown.value = true }
function onEmployeeBlur() { setTimeout(() => { showDropdown.value = false; employeeHighlight.value = -1 }, 200) }

function onEmployeeKeydown(e: KeyboardEvent) {
  const results = employeeSearchResults.value.slice(0, 10)
  if (!showDropdown.value || results.length === 0) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    employeeHighlight.value = Math.min(employeeHighlight.value + 1, results.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    employeeHighlight.value = Math.max(employeeHighlight.value - 1, 0)
  } else if (e.key === 'Enter' && employeeHighlight.value >= 0) {
    e.preventDefault()
    selectEmployee(results[employeeHighlight.value]!)
  }
}

// Guided-by search (指導者)
const guidedByResults = computed(() => {
  const q = newGuidedBy.value.trim().toLowerCase()
  const pastNames = new Set<string>()
  function collectNames(recs: GuidanceRecord[]) {
    for (const r of recs) {
      if (r.guided_by) pastNames.add(r.guided_by)
      if (r.children) collectNames(r.children)
    }
  }
  collectNames(records.value)
  const all = [
    ...employees.value.map(e => e.code ? `${e.code} - ${e.name}` : e.name),
    ...pastNames,
  ]
  const unique = [...new Set(all)]
  if (!q) return unique.slice(0, 10)
  return unique.filter(n => n.toLowerCase().includes(q)).slice(0, 10)
})

const guidedByHighlight = ref(-1)

function selectGuidedBy(name: string) { newGuidedBy.value = name; showGuidedByDropdown.value = false; guidedByHighlight.value = -1 }
function onGuidedByInput() { showGuidedByDropdown.value = true; guidedByHighlight.value = -1 }
function onGuidedByFocus() { showGuidedByDropdown.value = true }
function onGuidedByBlur() { setTimeout(() => { showGuidedByDropdown.value = false; guidedByHighlight.value = -1 }, 200) }

function onGuidedByKeydown(e: KeyboardEvent) {
  const results = guidedByResults.value
  if (!showGuidedByDropdown.value || results.length === 0) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    guidedByHighlight.value = Math.min(guidedByHighlight.value + 1, results.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    guidedByHighlight.value = Math.max(guidedByHighlight.value - 1, 0)
  } else if (e.key === 'Enter' && guidedByHighlight.value >= 0) {
    e.preventDefault()
    selectGuidedBy(results[guidedByHighlight.value]!)
  }
}

async function load() {
  loading.value = true
  try {
    const res = await listGuidanceRecords({
      employee_id: filterEmployee.value || undefined,
      guidance_type: filterType.value || undefined,
      page: page.value,
      per_page: perPage,
    })
    records.value = res.records
    total.value = res.total
  } catch (e) {
    console.error('指導記録取得エラー:', e)
  } finally {
    loading.value = false
  }
}

async function loadEmployees() {
  try { employees.value = await getEmployees() } catch {}
}

watch([filterEmployee, filterType], () => { page.value = 1; load() })
watch(page, load)

function openForm(parentId?: string, parentTitle?: string) {
  formParentId.value = parentId || null
  formParentTitle.value = parentTitle || ''
  showForm.value = true
}

function closeForm() {
  showForm.value = false
  formParentId.value = null
  formParentTitle.value = ''
}

async function handleCreate() {
  if (!newEmployeeId.value || !newTitle.value.trim()) return
  saving.value = true
  try {
    await createGuidanceRecord({
      employee_id: newEmployeeId.value,
      guidance_type: newType.value,
      title: newTitle.value.trim(),
      content: newContent.value.trim() || undefined,
      guided_by: newGuidedBy.value.trim() || undefined,
      guided_at: newGuidedAt.value ? new Date(newGuidedAt.value).toISOString() : undefined,
      parent_id: formParentId.value,
    })
    newTitle.value = ''
    newContent.value = ''
    closeForm()
    await load()
  } catch (e) {
    console.error('指導記録作成エラー:', e)
  } finally {
    saving.value = false
  }
}

async function handleDelete(id: string) {
  if (!confirm('この記録と子記録をすべて削除しますか？')) return
  try {
    await deleteGuidanceRecord(id)
    await load()
  } catch (e) {
    console.error('指導記録削除エラー:', e)
  }
}

async function handleUpload(recordId: string, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploadingId.value = recordId
  try {
    await uploadGuidanceAttachment(recordId, file)
    await load()
  } catch (e) {
    console.error('ファイルアップロードエラー:', e)
  } finally {
    uploadingId.value = null
    input.value = ''
  }
}

async function handleDeleteAttachment(recordId: string, attId: string) {
  if (!confirm('この添付ファイルを削除しますか？')) return
  try {
    await deleteGuidanceAttachment(recordId, attId)
    await load()
  } catch (e) {
    console.error('添付削除エラー:', e)
  }
}

function toggleExpand(id: string) {
  if (expandedIds.value.has(id)) {
    expandedIds.value.delete(id)
  } else {
    expandedIds.value.add(id)
  }
}

function isImage(type: string) {
  return type.startsWith('image/')
}

function formatDate(d: string) {
  return new Date(d).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatDateShort(d: string) {
  return new Date(d).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const totalPages = computed(() => Math.ceil(total.value / perPage))

onMounted(() => { load(); loadEmployees() })
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between flex-wrap gap-2">
      <h3 class="text-lg font-bold">指導監督の記録</h3>
      <button
        class="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
        @click="openForm()"
      >
        + 新規記録
      </button>
    </div>

    <!-- 新規記録フォーム -->
    <div v-if="showForm" class="bg-gray-50 p-4 rounded-lg border space-y-3">
      <div v-if="formParentId" class="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded">
        親記録: {{ formParentTitle }}
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="relative">
          <label class="block text-xs text-gray-500 mb-1">対象者</label>
          <input
            v-model="newEmployeeSearch"
            type="text"
            placeholder="名前または社員番号"
            class="w-full border rounded px-3 py-1.5 text-sm"
            :class="newEmployeeId ? 'border-blue-400 bg-blue-50' : ''"
            @input="onEmployeeInput" @focus="onEmployeeFocus" @blur="onEmployeeBlur" @keydown="onEmployeeKeydown"
          />
          <div v-if="showDropdown"
               class="absolute z-10 w-full mt-1 bg-white border rounded shadow-lg max-h-40 overflow-y-auto">
            <button v-for="(emp, idx) in employeeSearchResults.slice(0, 10)" :key="emp.id"
                    class="w-full text-left px-3 py-1.5 text-sm"
                    :class="idx === employeeHighlight ? 'bg-blue-100' : 'hover:bg-blue-50'"
                    @mousedown.prevent="selectEmployee(emp)">
              {{ emp.code ? `${emp.code} - ` : '' }}{{ emp.name }}
            </button>
            <div v-if="employeeSearchResults.length === 0" class="px-3 py-2 text-xs text-gray-400">該当なし</div>
          </div>
          <div v-if="newEmployeeSearch && !newEmployeeId" class="text-xs text-red-500 mt-0.5">候補から選択してください</div>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">指導種別</label>
          <select v-model="newType" class="w-full border rounded px-3 py-1.5 text-sm">
            <option v-for="t in GUIDANCE_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
          </select>
        </div>
        <div class="relative">
          <label class="block text-xs text-gray-500 mb-1">指導者</label>
          <input v-model="newGuidedBy" type="text" placeholder="指導者名"
                 class="w-full border rounded px-3 py-1.5 text-sm"
                 @input="onGuidedByInput" @focus="onGuidedByFocus" @blur="onGuidedByBlur" @keydown="onGuidedByKeydown" />
          <div v-if="showGuidedByDropdown && guidedByResults.length > 0"
               class="absolute z-10 w-full mt-1 bg-white border rounded shadow-lg max-h-40 overflow-y-auto">
            <button v-for="(name, idx) in guidedByResults" :key="name"
                    class="w-full text-left px-3 py-1.5 text-sm"
                    :class="idx === guidedByHighlight ? 'bg-blue-100' : 'hover:bg-blue-50'"
                    @mousedown.prevent="selectGuidedBy(name)">{{ name }}</button>
          </div>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">実施日時</label>
          <input v-model="newGuidedAt" type="datetime-local" class="w-full border rounded px-3 py-1.5 text-sm" />
        </div>
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">タイトル</label>
        <input v-model="newTitle" type="text" placeholder="指導内容のタイトル" class="w-full border rounded px-3 py-1.5 text-sm" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">内容</label>
        <textarea v-model="newContent" placeholder="指導内容の詳細" class="w-full border rounded px-3 py-1.5 text-sm" rows="3" />
      </div>
      <div class="flex justify-end gap-2">
        <button class="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300" @click="closeForm">取消</button>
        <button
          class="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
          :disabled="!newEmployeeId || !newTitle.trim() || saving"
          @click="handleCreate"
        >{{ saving ? '保存中...' : '保存' }}</button>
      </div>
    </div>

    <!-- フィルタ -->
    <div class="flex items-center gap-3 flex-wrap">
      <EmployeeSearchSelect v-model="filterEmployee" :employees="employees" />
      <select v-model="filterType" class="border rounded px-2 py-1 text-sm">
        <option value="">全種別</option>
        <option v-for="t in GUIDANCE_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
      </select>
      <span class="text-xs text-gray-400">{{ total }} 件</span>
    </div>

    <!-- タイムラインツリー -->
    <div v-if="loading" class="text-center py-4 text-gray-400">読み込み中...</div>
    <div v-else-if="records.length === 0" class="text-center py-8 text-gray-400">指導記録がありません</div>
    <div v-else class="space-y-1">
      <template v-for="rec in records" :key="rec.id">
        <GuidanceRecordNode
          :record="rec"
          :depth="0"
          :expanded-ids="expandedIds"
          :uploading-id="uploadingId"
          @toggle="toggleExpand"
          @add-child="openForm($event.id, $event.title)"
          @delete="handleDelete"
          @upload="handleUpload"
          @delete-attachment="handleDeleteAttachment"
        />
      </template>
    </div>

    <!-- ページネーション -->
    <div v-if="totalPages > 1" class="flex justify-center gap-2">
      <button class="px-3 py-1 rounded text-sm border" :disabled="page <= 1" @click="page--">前</button>
      <span class="text-sm text-gray-500 self-center">{{ page }} / {{ totalPages }}</span>
      <button class="px-3 py-1 rounded text-sm border" :disabled="page >= totalPages" @click="page++">次</button>
    </div>
  </div>
</template>
