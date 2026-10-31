<script setup lang="ts">
import type { EquipmentFailure, EquipmentFailureFilter, CreateEquipmentFailure } from '~/types'
import { listFailures, createFailure, resolveFailure, downloadFailuresCsv } from '~/utils/api'

const failures = ref<EquipmentFailure[]>([])
const total = ref(0)
const page = ref(1)
const perPage = 20
const isLoading = ref(false)
const error = ref<string | null>(null)
const isDownloading = ref(false)

// フィルタ
const filterType = ref('')
const filterResolved = ref<'' | 'true' | 'false'>('')
const filterDateFrom = ref('')
const filterDateTo = ref('')

const failureTypes = [
  { value: 'face_recognition_error', label: '顔認識エラー' },
  { value: 'measurement_recording_failed', label: '測定記録失敗' },
  { value: 'kiosk_offline', label: 'キオスクオフライン' },
  { value: 'database_sync_error', label: 'DB同期エラー' },
  { value: 'webhook_delivery_failed', label: 'Webhook配信失敗' },
  { value: 'session_state_error', label: 'セッション状態エラー' },
  { value: 'photo_storage_error', label: '写真保存エラー' },
  { value: 'manual_report', label: '手動報告' },
]

function failureTypeLabel(t: string) {
  return failureTypes.find(ft => ft.value === t)?.label || t
}

function buildFilter(): EquipmentFailureFilter {
  const f: EquipmentFailureFilter = {}
  if (filterType.value) f.failure_type = filterType.value
  if (filterResolved.value) f.resolved = filterResolved.value === 'true'
  if (filterDateFrom.value) f.date_from = filterDateFrom.value
  if (filterDateTo.value) f.date_to = filterDateTo.value
  return f
}

async function fetchData() {
  isLoading.value = true
  error.value = null
  try {
    const res = await listFailures({ ...buildFilter(), page: page.value, per_page: perPage }, 'tenko-monitor')
    failures.value = res.failures
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
const newForm = ref<CreateEquipmentFailure>({ failure_type: 'manual_report', description: '' })

async function handleCreate() {
  if (!newForm.value.description.trim()) return
  isSaving.value = true
  error.value = null
  try {
    await createFailure({
      ...newForm.value,
      description: newForm.value.description.trim(),
      affected_device: newForm.value.affected_device?.trim() || undefined,
    })
    newForm.value = { failure_type: 'manual_report', description: '' }
    showForm.value = false
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '作成エラー'
  } finally {
    isSaving.value = false
  }
}

// 解決操作
const resolvingId = ref<string | null>(null)
const resolveNotes = ref('')

async function handleResolve(id: string) {
  error.value = null
  try {
    await resolveFailure(id, { resolution_notes: resolveNotes.value.trim() || undefined })
    resolvingId.value = null
    resolveNotes.value = ''
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '解決記録エラー'
  }
}

// CSV出力
async function handleCsvDownload() {
  isDownloading.value = true
  error.value = null
  try {
    await downloadFailuresCsv(buildFilter(), 'tenko-monitor')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'CSVダウンロードエラー'
  } finally {
    isDownloading.value = false
  }
}

function formatDate(iso: string | null) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

onMounted(() => fetchData())
</script>

<template>
  <div>
    <!-- フィルタ -->
    <div class="bg-white rounded-xl p-4 shadow-sm mb-4">
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <select v-model="filterType" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">全種別</option>
          <option v-for="ft in failureTypes" :key="ft.value" :value="ft.value">{{ ft.label }}</option>
        </select>
        <select v-model="filterResolved" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">全状態</option>
          <option value="false">未解決</option>
          <option value="true">解決済</option>
        </select>
        <input v-model="filterDateFrom" type="date" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        <input v-model="filterDateTo" type="date" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      </div>
      <div class="flex gap-2 mt-3">
        <button class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors" @click="applyFilter">検索</button>
        <button class="px-3 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition-colors" @click="showForm = !showForm">
          {{ showForm ? '閉じる' : '+ 故障報告' }}
        </button>
        <button
          :disabled="isDownloading"
          class="px-4 py-2 bg-gray-600 text-white rounded-lg text-sm hover:bg-gray-700 transition-colors disabled:opacity-50"
          @click="handleCsvDownload"
        >{{ isDownloading ? 'ダウンロード中...' : 'CSV出力' }}</button>
      </div>
    </div>

    <!-- 新規作成フォーム -->
    <div v-if="showForm" class="bg-white rounded-xl p-4 shadow-sm mb-4">
      <h3 class="text-sm font-medium text-gray-700 mb-3">故障報告</h3>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label class="block text-xs text-gray-500 mb-1">故障種別</label>
          <select v-model="newForm.failure_type" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option v-for="ft in failureTypes" :key="ft.value" :value="ft.value">{{ ft.label }}</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">対象機器 (任意)</label>
          <input v-model="newForm.affected_device" type="text" placeholder="例: キオスク端末A" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div class="sm:col-span-2">
          <label class="block text-xs text-gray-500 mb-1">説明</label>
          <textarea v-model="newForm.description" rows="2" placeholder="故障の詳細を記入" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
      </div>
      <button
        :disabled="!newForm.description.trim() || isSaving"
        class="mt-3 px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition-colors disabled:opacity-50"
        @click="handleCreate"
      >{{ isSaving ? '報告中...' : '報告' }}</button>
    </div>

    <!-- エラー -->
    <div v-if="error" class="bg-red-50 text-red-700 p-3 rounded-lg mb-4 text-sm">{{ error }}</div>

    <!-- ローディング -->
    <div v-if="isLoading" class="text-center py-8 text-gray-500">読み込み中...</div>

    <!-- テーブル -->
    <div v-else-if="failures.length > 0" class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-gray-600">
            <tr>
              <th class="px-4 py-3 text-left font-medium">検出日時</th>
              <th class="px-4 py-3 text-left font-medium">種別</th>
              <th class="px-4 py-3 text-left font-medium">説明</th>
              <th class="px-4 py-3 text-left font-medium">対象機器</th>
              <th class="px-4 py-3 text-center font-medium">状態</th>
              <th class="px-4 py-3 text-center font-medium">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="f in failures" :key="f.id" class="hover:bg-gray-50">
              <td class="px-4 py-3 text-gray-700">{{ formatDate(f.detected_at) }}</td>
              <td class="px-4 py-3 text-gray-700">{{ failureTypeLabel(f.failure_type) }}</td>
              <td class="px-4 py-3 text-gray-700 max-w-[300px] truncate">{{ f.description }}</td>
              <td class="px-4 py-3 text-gray-500">{{ f.affected_device || '-' }}</td>
              <td class="px-4 py-3 text-center">
                <span class="inline-block px-2 py-1 rounded-full text-xs font-medium"
                  :class="f.resolved_at ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'">
                  {{ f.resolved_at ? '解決済' : '未解決' }}
                </span>
              </td>
              <td class="px-4 py-3 text-center">
                <template v-if="!f.resolved_at">
                  <div v-if="resolvingId === f.id" class="flex items-center gap-1">
                    <input v-model="resolveNotes" type="text" placeholder="解決メモ" class="px-2 py-1 border border-gray-300 rounded text-xs w-32">
                    <button class="px-2 py-1 bg-green-600 text-white rounded text-xs" @click="handleResolve(f.id)">解決</button>
                    <button class="px-2 py-1 bg-gray-200 text-gray-700 rounded text-xs" @click="resolvingId = null">取消</button>
                  </div>
                  <button v-else class="px-2 py-1 text-green-600 hover:bg-green-50 rounded text-xs" @click="resolvingId = f.id; resolveNotes = ''">解決記録</button>
                </template>
                <div v-else class="text-xs text-gray-500">
                  <p>{{ formatDate(f.resolved_at) }}</p>
                  <p v-if="f.resolution_notes" class="text-gray-400 truncate max-w-[150px]">{{ f.resolution_notes }}</p>
                </div>
              </td>
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
    <div v-else class="text-center py-8 text-gray-500">故障記録がありません</div>
  </div>
</template>
