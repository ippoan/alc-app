<script setup lang="ts">
import { getEmployees } from '~/utils/api'
import { getVideo, type VideoRecord } from '~/utils/video-store'
import { alcoholResultClass, alcoholResultLabel } from '~/utils/alcohol'

const props = defineProps<{
  sidebar?: boolean
}>()

const {
  allItems,
  pending,
  isSyncing,
  isOnline,
  syncQueue,
  refreshQueue,
  getRetentionDays,
  setRetentionDays,
} = useOfflineSync()

// 展開状態
const expanded = ref(false)

// 従業員名ルックアップ
const employeeMap = ref<Record<string, string>>({})
async function loadEmployees() {
  try {
    const employees = await getEmployees()
    employeeMap.value = Object.fromEntries(employees.map(e => [e.id, e.name]))
  } catch {}
}
function employeeName(id: string) {
  return employeeMap.value[id] || id.slice(0, 8)
}

// フィルタ
type StatusFilter = 'all' | 'pending' | 'synced' | 'failed'
const statusFilter = ref<StatusFilter>('all')

const filteredItems = computed(() => {
  const sorted = [...allItems.value].sort((a, b) =>
    b.result.measuredAt.localeCompare(a.result.measuredAt),
  )
  switch (statusFilter.value) {
    case 'pending':
      return sorted.filter(item => !item.syncedAt && item.retryCount < 5)
    case 'synced':
      return sorted.filter(item => !!item.syncedAt)
    case 'failed':
      return sorted.filter(item => !item.syncedAt && item.retryCount >= 5)
    default:
      return sorted
  }
})

const syncedCount = computed(() => allItems.value.filter(i => !!i.syncedAt).length)
const failedCount = computed(() => allItems.value.filter(i => !i.syncedAt && i.retryCount >= 5).length)

// 保存期間設定
const showSettings = ref(false)
const retentionInput = ref(getRetentionDays())

function saveRetention() {
  setRetentionDays(retentionInput.value)
  showSettings.value = false
}

// ステータス判定
function syncStatus(item: { syncedAt?: string; retryCount: number }) {
  if (item.syncedAt) return 'synced'
  if (item.retryCount >= 5) return 'failed'
  return 'pending'
}

function statusLabel(status: string) {
  switch (status) {
    case 'synced': return '送信済'
    case 'pending': return '未送信'
    case 'failed': return '送信失敗'
    default: return status
  }
}

function statusColor(status: string) {
  switch (status) {
    case 'synced': return 'bg-green-100 text-green-800'
    case 'pending': return 'bg-yellow-100 text-yellow-800'
    case 'failed': return 'bg-red-100 text-red-800'
    default: return 'bg-gray-100 text-gray-800'
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatTemp(v?: number) {
  return v != null ? `${v.toFixed(1)}` : '-'
}

function formatBp(sys?: number, dia?: number) {
  if (sys == null && dia == null) return '-'
  return `${sys ?? '-'}/${dia ?? '-'}`
}

// 録画状態ルックアップ
const videoStatusMap = ref<Record<string, 'uploaded' | 'pending' | 'none'>>({})

async function loadVideoStatuses() {
  const map: Record<string, 'uploaded' | 'pending' | 'none'> = {}
  for (const item of allItems.value) {
    const vid = item.result.videoStoreId
    if (!vid) { map[String(item.id)] = 'none'; continue }
    try {
      const record = await getVideo(vid)
      if (!record) map[String(item.id)] = 'none'
      else if (record.uploadedAt) map[String(item.id)] = 'uploaded'
      else map[String(item.id)] = 'pending'
    } catch {
      map[String(item.id)] = 'none'
    }
  }
  videoStatusMap.value = map
}

function videoLabel(itemId: number) {
  const s = videoStatusMap.value[String(itemId)]
  if (s === 'uploaded') return '済'
  if (s === 'pending') return '未'
  return '-'
}

function videoColor(itemId: number) {
  const s = videoStatusMap.value[String(itemId)]
  if (s === 'uploaded') return 'bg-green-100 text-green-800'
  if (s === 'pending') return 'bg-yellow-100 text-yellow-800'
  return 'text-gray-400'
}

watch(allItems, () => loadVideoStatuses(), { immediate: false })

onMounted(() => {
  loadEmployees()
  refreshQueue().then(() => loadVideoStatuses())
})
</script>

<template>
  <ClientOnly>
    <!-- サイドバーモード: インライン表示 -->
    <template v-if="sidebar">
      <div class="w-full">
        <button
          class="w-full px-2 py-1.5 rounded-md text-xs font-medium transition-colors text-left flex items-center gap-1"
          :class="pending > 0
            ? 'bg-yellow-100 text-yellow-800'
            : 'text-gray-500 hover:bg-gray-100'"
          @click="expanded = !expanded"
        >
          <span v-if="pending > 0">未送信 {{ pending }}件</span>
          <span v-else>未送信なし</span>
          <svg
            class="w-3 h-3 ml-auto transition-transform"
            :class="{ 'rotate-180': expanded }"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        </button>
      </div>
      <!-- サイドバー時の展開パネル: 固定オーバーレイ -->
      <Teleport to="body">
        <Transition
          enter-active-class="transition-opacity duration-200"
          leave-active-class="transition-opacity duration-150"
          enter-from-class="opacity-0"
          leave-to-class="opacity-0"
        >
          <div
            v-if="expanded"
            class="fixed inset-0 z-50 flex items-end justify-center"
            @click.self="expanded = false"
          >
            <div
              class="bg-white border border-gray-200 rounded-t-xl shadow-2xl w-full max-w-4xl"
              style="max-height: 60vh; overflow-y: auto;"
            >
              <div class="p-3 space-y-3">
                <div class="flex items-center justify-between">
                  <div class="flex gap-2">
                    <button
                      v-if="pending > 0 && isOnline && !isSyncing"
                      class="px-3 py-1 bg-blue-600 text-white rounded-lg text-xs hover:bg-blue-700 transition-colors"
                      @click="syncQueue"
                    >
                      同期
                    </button>
                    <span v-if="isSyncing" class="text-xs text-blue-600">同期中...</span>
                  </div>
                  <button
                    class="px-2 py-1 text-gray-400 hover:text-gray-600 text-xs"
                    @click="expanded = false"
                  >
                    閉じる
                  </button>
                </div>
                <div v-if="filteredItems.length > 0" class="overflow-x-auto">
                  <table class="w-full text-xs">
                    <thead class="bg-gray-50 text-gray-600">
                      <tr>
                        <th class="px-2 py-2 text-left font-medium">日時</th>
                        <th class="px-2 py-2 text-left font-medium">乗務員</th>
                        <th class="px-2 py-2 text-right font-medium">ALC</th>
                        <th class="px-2 py-2 text-center font-medium">結果</th>
                        <th class="px-2 py-2 text-center font-medium">録画</th>
                        <th class="px-2 py-2 text-center font-medium">状態</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100">
                      <tr v-for="item in filteredItems" :key="item.id" class="hover:bg-gray-50">
                        <td class="px-2 py-1.5 text-gray-700 whitespace-nowrap">{{ formatDate(item.result.measuredAt) }}</td>
                        <td class="px-2 py-1.5 text-gray-700">{{ employeeName(item.result.employeeId) }}</td>
                        <td class="px-2 py-1.5 text-right text-gray-700 tabular-nums">{{ item.result.alcoholValue.toFixed(3) }}</td>
                        <td class="px-2 py-1.5 text-center">
                          <span class="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium" :class="alcoholResultClass(item.result.resultType)">
                            {{ alcoholResultLabel(item.result.resultType) }}
                          </span>
                        </td>
                        <td class="px-2 py-1.5 text-center">
                          <span class="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium" :class="videoColor(item.id)">
                            {{ videoLabel(item.id) }}
                          </span>
                        </td>
                        <td class="px-2 py-1.5 text-center">
                          <span class="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium" :class="statusColor(syncStatus(item))">
                            {{ statusLabel(syncStatus(item)) }}
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div v-else class="text-center py-4 text-gray-400 text-xs">
                  測定ログはありません
                </div>
              </div>
            </div>
          </div>
        </Transition>
      </Teleport>
    </template>

    <!-- 通常モード: 固定フッター -->
    <div v-if="!sidebar" class="fixed bottom-0 left-0 right-0 z-40">
      <!-- 展開パネル -->
      <Transition
        enter-active-class="transition-transform duration-300 ease-out"
        leave-active-class="transition-transform duration-200 ease-in"
        enter-from-class="translate-y-full"
        leave-to-class="translate-y-full"
      >
        <div
          v-if="expanded"
          class="bg-white border-t border-gray-200 shadow-2xl"
          style="max-height: 50vh; overflow-y: auto;"
        >
          <div class="p-3 space-y-3 max-w-4xl mx-auto">
            <!-- ヘッダー -->
            <div class="flex items-center justify-between">
              <div class="flex gap-2">
                <button
                  v-if="pending > 0 && isOnline && !isSyncing"
                  class="px-3 py-1 bg-blue-600 text-white rounded-lg text-xs hover:bg-blue-700 transition-colors"
                  @click="syncQueue"
                >
                  未送信を同期 ({{ pending }}件)
                </button>
                <span v-if="isSyncing" class="text-xs text-blue-600">同期中...</span>
                <button
                  class="px-3 py-1 border border-gray-300 text-gray-500 rounded-lg text-xs hover:bg-gray-50 transition-colors"
                  @click="showSettings = !showSettings"
                >
                  設定
                </button>
              </div>
            </div>

            <!-- 設定パネル -->
            <div v-if="showSettings" class="bg-gray-50 rounded-lg p-3">
              <div class="flex items-center gap-2">
                <label class="text-xs text-gray-600">保存期間:</label>
                <input
                  v-model.number="retentionInput"
                  type="number"
                  min="1"
                  max="3650"
                  class="w-20 px-2 py-1 border border-gray-300 rounded text-xs"
                />
                <span class="text-xs text-gray-500">日</span>
                <button
                  class="px-2 py-1 bg-gray-700 text-white rounded text-xs hover:bg-gray-800 transition-colors"
                  @click="saveRetention"
                >
                  保存
                </button>
              </div>
            </div>

            <!-- フィルタ -->
            <div class="flex gap-1.5">
              <button
                v-for="opt in ([
                  { key: 'all' as const, label: 'すべて' },
                  { key: 'pending' as const, label: '未送信' },
                  { key: 'synced' as const, label: '送信済' },
                  { key: 'failed' as const, label: '失敗' },
                ])"
                :key="opt.key"
                class="px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
                :class="statusFilter === opt.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
                @click="statusFilter = opt.key"
              >
                {{ opt.label }}
              </button>
            </div>

            <!-- テーブル -->
            <div v-if="filteredItems.length > 0" class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead class="bg-gray-50 text-gray-600">
                  <tr>
                    <th class="px-2 py-2 text-left font-medium">日時</th>
                    <th class="px-2 py-2 text-left font-medium">乗務員</th>
                    <th class="px-2 py-2 text-right font-medium">ALC</th>
                    <th class="px-2 py-2 text-center font-medium">結果</th>
                    <th class="px-2 py-2 text-right font-medium">体温</th>
                    <th class="px-2 py-2 text-right font-medium">血圧</th>
                    <th class="px-2 py-2 text-center font-medium">録画</th>
                    <th class="px-2 py-2 text-center font-medium">状態</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100">
                  <tr v-for="item in filteredItems" :key="item.id" class="hover:bg-gray-50">
                    <td class="px-2 py-1.5 text-gray-700 whitespace-nowrap">
                      {{ formatDate(item.result.measuredAt) }}
                    </td>
                    <td class="px-2 py-1.5 text-gray-700">
                      {{ employeeName(item.result.employeeId) }}
                    </td>
                    <td class="px-2 py-1.5 text-right text-gray-700 tabular-nums">
                      {{ item.result.alcoholValue.toFixed(3) }}
                    </td>
                    <td class="px-2 py-1.5 text-center">
                      <span
                        class="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium"
                        :class="alcoholResultClass(item.result.resultType)"
                      >
                        {{ alcoholResultLabel(item.result.resultType) }}
                      </span>
                    </td>
                    <td class="px-2 py-1.5 text-right text-gray-700 tabular-nums">
                      {{ formatTemp(item.result.temperature) }}
                    </td>
                    <td class="px-2 py-1.5 text-right text-gray-700 tabular-nums">
                      {{ formatBp(item.result.systolic, item.result.diastolic) }}
                    </td>
                    <td class="px-2 py-1.5 text-center">
                      <span
                        class="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium"
                        :class="videoColor(item.id)"
                      >
                        {{ videoLabel(item.id) }}
                      </span>
                    </td>
                    <td class="px-2 py-1.5 text-center">
                      <span
                        class="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium"
                        :class="statusColor(syncStatus(item))"
                      >
                        {{ statusLabel(syncStatus(item)) }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else class="text-center py-4 text-gray-400 text-xs">
              測定ログはありません
            </div>
          </div>
        </div>
      </Transition>

      <!-- フッターバー (常時表示) -->
      <button
        class="w-full border-t px-4 py-2 flex items-center justify-between text-xs shadow-sm"
        :class="pending > 0
          ? 'bg-yellow-50 border-yellow-200 text-yellow-800'
          : 'bg-white border-gray-200 text-gray-600'"
        @click="expanded = !expanded"
      >
        <div class="flex items-center gap-3">
          <span v-if="pending > 0" class="font-bold">未送信 {{ pending }}件</span>
          <span v-else class="font-medium text-gray-500">未送信なし</span>
          <span v-if="failedCount > 0" class="text-red-600 font-medium">失敗 {{ failedCount }}</span>
          <span class="text-gray-400">全{{ allItems.length }}件</span>
        </div>
        <svg
          class="w-4 h-4 text-gray-400 transition-transform"
          :class="{ 'rotate-180': expanded }"
          fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
        </svg>
      </button>
    </div>
  </ClientOnly>
</template>
