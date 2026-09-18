<script setup lang="ts">
import type { CommunicationItem, ApiEmployee } from '~/types'
import { listCommunicationItems, createCommunicationItem, updateCommunicationItem, deleteCommunicationItem, getEmployees } from '~/utils/api'

const items = ref<CommunicationItem[]>([])
const employees = ref<ApiEmployee[]>([])
const loading = ref(false)
const total = ref(0)
const page = ref(1)
const perPage = 20

// Filters
const filterActive = ref<string>('true')

// New item form
const showForm = ref(false)
const newTitle = ref('')
const newContent = ref('')
const newPriority = ref('normal')
const newTargetId = ref('')
const newFrom = ref('')
const newUntil = ref('')
const newCreatedBy = ref('')
const saving = ref(false)

const PRIORITIES = [
  { value: 'urgent', label: '緊急', color: 'bg-red-100 text-red-700' },
  { value: 'normal', label: '通常', color: 'bg-blue-100 text-blue-700' },
  { value: 'low', label: '低', color: 'bg-gray-100 text-gray-600' },
]

function priorityInfo(val: string) {
  return PRIORITIES.find(p => p.value === val) || PRIORITIES[1]!
}

async function load() {
  loading.value = true
  try {
    const res = await listCommunicationItems({
      is_active: filterActive.value === '' ? undefined : filterActive.value === 'true',
      page: page.value,
      per_page: perPage,
    })
    items.value = res.items
    total.value = res.total
  } catch (e) {
    console.error('伝達事項取得エラー:', e)
  } finally {
    loading.value = false
  }
}

async function loadEmployees() {
  try { employees.value = await getEmployees() } catch {}
}

watch([filterActive], () => { page.value = 1; load() })
watch(page, load)

async function handleCreate() {
  if (!newTitle.value.trim()) return
  saving.value = true
  try {
    await createCommunicationItem({
      title: newTitle.value.trim(),
      content: newContent.value.trim() || undefined,
      priority: newPriority.value,
      target_employee_id: newTargetId.value || null,
      effective_from: newFrom.value ? new Date(newFrom.value).toISOString() : null,
      effective_until: newUntil.value ? new Date(newUntil.value).toISOString() : null,
      created_by: newCreatedBy.value.trim() || undefined,
    })
    newTitle.value = ''
    newContent.value = ''
    newPriority.value = 'normal'
    newTargetId.value = ''
    newFrom.value = ''
    newUntil.value = ''
    showForm.value = false
    await load()
  } catch (e) {
    console.error('伝達事項作成エラー:', e)
  } finally {
    saving.value = false
  }
}

async function toggleActive(item: CommunicationItem) {
  try {
    await updateCommunicationItem(item.id, { is_active: !item.is_active } as any)
    await load()
  } catch (e) {
    console.error('伝達事項更新エラー:', e)
  }
}

async function handleDelete(id: string) {
  if (!confirm('この伝達事項を削除しますか？')) return
  try {
    await deleteCommunicationItem(id)
    await load()
  } catch (e) {
    console.error('伝達事項削除エラー:', e)
  }
}

function formatDate(d: string | null) {
  if (!d) return '-'
  return new Date(d).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const totalPages = computed(() => Math.ceil(total.value / perPage))

onMounted(() => { load(); loadEmployees() })
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between flex-wrap gap-2">
      <h3 class="text-lg font-bold">伝達事項</h3>
      <button
        class="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
        @click="showForm = !showForm"
      >
        {{ showForm ? '閉じる' : '+ 新規追加' }}
      </button>
    </div>
    <p class="text-sm text-gray-500">遠隔点呼時に運転者に伝達すべき事項を管理します。</p>

    <!-- 新規フォーム -->
    <div v-if="showForm" class="bg-gray-50 p-4 rounded-lg border space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs text-gray-500 mb-1">優先度</label>
          <select v-model="newPriority" class="w-full border rounded px-3 py-1.5 text-sm">
            <option v-for="p in PRIORITIES" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">対象者 (空=全員)</label>
          <EmployeeSearchSelect v-model="newTargetId" :employees="employees" placeholder="対象者 (空=全員、名前・社員番号で検索)" />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">有効開始</label>
          <input v-model="newFrom" type="datetime-local" class="w-full border rounded px-3 py-1.5 text-sm" />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">有効終了</label>
          <input v-model="newUntil" type="datetime-local" class="w-full border rounded px-3 py-1.5 text-sm" />
        </div>
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">作成者</label>
        <input v-model="newCreatedBy" type="text" placeholder="管理者名" class="w-full border rounded px-3 py-1.5 text-sm" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">タイトル</label>
        <input v-model="newTitle" type="text" placeholder="伝達事項のタイトル" class="w-full border rounded px-3 py-1.5 text-sm" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">内容</label>
        <textarea v-model="newContent" placeholder="伝達内容の詳細" class="w-full border rounded px-3 py-1.5 text-sm" rows="3" />
      </div>
      <div class="flex justify-end">
        <button
          class="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
          :disabled="!newTitle.trim() || saving"
          @click="handleCreate"
        >
          {{ saving ? '保存中...' : '保存' }}
        </button>
      </div>
    </div>

    <!-- フィルタ -->
    <div class="flex items-center gap-3">
      <select v-model="filterActive" class="border rounded px-2 py-1 text-sm">
        <option value="">全て</option>
        <option value="true">有効のみ</option>
        <option value="false">無効のみ</option>
      </select>
      <span class="text-xs text-gray-400">{{ total }} 件</span>
    </div>

    <!-- 一覧 -->
    <div v-if="loading" class="text-center py-4 text-gray-400">読み込み中...</div>
    <div v-else-if="items.length === 0" class="text-center py-8 text-gray-400">伝達事項がありません</div>
    <div v-else class="space-y-2">
      <div
        v-for="item in items"
        :key="item.id"
        class="border rounded-lg p-3"
        :class="item.is_active ? 'bg-white' : 'bg-gray-50 opacity-60'"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="flex-1">
            <div class="flex items-center gap-2 mb-1">
              <span class="font-medium text-sm">{{ item.title }}</span>
              <span class="text-xs px-1.5 py-0.5 rounded" :class="priorityInfo(item.priority).color">
                {{ priorityInfo(item.priority).label }}
              </span>
              <span v-if="!item.is_active" class="text-xs bg-gray-200 text-gray-500 px-1.5 py-0.5 rounded">無効</span>
            </div>
            <div class="text-xs text-gray-500 flex items-center gap-3 flex-wrap">
              <span>対象: <strong>{{ item.target_employee_name || '全員' }}</strong></span>
              <span v-if="item.created_by">作成: {{ item.created_by }}</span>
              <span v-if="item.effective_from">有効: {{ formatDate(item.effective_from) }} 〜 {{ formatDate(item.effective_until) }}</span>
              <span>{{ formatDate(item.created_at) }}</span>
            </div>
            <div v-if="item.content" class="mt-1 text-sm text-gray-700 whitespace-pre-wrap">{{ item.content }}</div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button
              class="text-xs px-2 py-1 rounded"
              :class="item.is_active ? 'text-yellow-600 hover:bg-yellow-50' : 'text-green-600 hover:bg-green-50'"
              @click="toggleActive(item)"
            >
              {{ item.is_active ? '無効化' : '有効化' }}
            </button>
            <button class="text-xs text-gray-400 hover:text-red-600 px-2 py-1" @click="handleDelete(item.id)">削除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ページネーション -->
    <div v-if="totalPages > 1" class="flex justify-center gap-2">
      <button class="px-3 py-1 rounded text-sm border" :disabled="page <= 1" @click="page--">前</button>
      <span class="text-sm text-gray-500 self-center">{{ page }} / {{ totalPages }}</span>
      <button class="px-3 py-1 rounded text-sm border" :disabled="page >= totalPages" @click="page++">次</button>
    </div>
  </div>
</template>
