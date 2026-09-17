<script setup lang="ts">
import { getEmployees } from '~/utils/api'
import { estimateDbSize } from '~/utils/offline-queue'
import { alcoholResultClass, alcoholResultLabel } from '~/utils/alcohol'

const {
  queueItems,
  allItems,
  pending,
  isSyncing,
  isOnline,
  removeItem,
  clearQueue,
  syncQueue,
  refreshQueue,
  getRetentionDays,
} = useOfflineSync()

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

// IndexedDB サイズ
const dbSize = ref<{ totalBytes: number; recordCount: number } | null>(null)
async function loadDbSize() {
  try {
    dbSize.value = await estimateDbSize()
  } catch {}
}
function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const isDeleting = ref<number | null>(null)
const isClearing = ref(false)

async function handleRemove(id: number) {
  isDeleting.value = id
  try {
    await removeItem(id)
    await loadDbSize()
  } finally {
    isDeleting.value = null
  }
}

async function handleClearAll() {
  if (!confirm('送信キュー内の未送信データを削除しますか？この操作は元に戻せません。')) return
  isClearing.value = true
  try {
    await clearQueue()
    await loadDbSize()
  } finally {
    isClearing.value = false
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

onMounted(() => {
  loadEmployees()
  refreshQueue()
  loadDbSize()
})
</script>

<template>
  <div>
    <!-- アクションバー -->
    <div class="bg-white rounded-xl p-4 shadow-sm mb-4">
      <div class="flex items-center justify-between">
        <p class="text-sm text-gray-600">
          未送信: <span class="font-bold">{{ pending }}</span> 件
        </p>
        <div class="flex gap-2">
          <button
            :disabled="pending === 0 || isSyncing || !isOnline"
            class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors disabled:opacity-50"
            @click="syncQueue"
          >
            {{ isSyncing ? '送信中...' : '再送信' }}
          </button>
          <button
            :disabled="pending === 0 || isClearing"
            class="px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 transition-colors disabled:opacity-50"
            @click="handleClearAll"
          >
            {{ isClearing ? '削除中...' : '全件削除' }}
          </button>
        </div>
      </div>
      <!-- IndexedDB サイズ情報 -->
      <div v-if="dbSize" class="mt-2 pt-2 border-t border-gray-100 flex gap-4 text-xs text-gray-500">
        <span>IndexedDB: <span class="font-medium text-gray-700">{{ formatSize(dbSize.totalBytes) }}</span></span>
        <span>全レコード: <span class="font-medium text-gray-700">{{ dbSize.recordCount }}</span> 件</span>
        <span>送信済: <span class="font-medium text-gray-700">{{ allItems.filter(i => !!i.syncedAt).length }}</span> 件</span>
        <span>保存期間: <span class="font-medium text-gray-700">{{ getRetentionDays() }}</span> 日</span>
      </div>
    </div>

    <!-- テーブル -->
    <div v-if="queueItems.length > 0" class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-gray-600">
            <tr>
              <th class="px-4 py-3 text-left font-medium">キュー登録</th>
              <th class="px-4 py-3 text-left font-medium">測定日時</th>
              <th class="px-4 py-3 text-left font-medium">乗務員</th>
              <th class="px-4 py-3 text-right font-medium">アルコール値</th>
              <th class="px-4 py-3 text-center font-medium">結果</th>
              <th class="px-4 py-3 text-center font-medium">リトライ</th>
              <th class="px-4 py-3 text-center font-medium">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="item in queueItems" :key="item.id" class="hover:bg-gray-50">
              <td class="px-4 py-3 text-gray-700">{{ formatDate(item.createdAt) }}</td>
              <td class="px-4 py-3 text-gray-700">{{ formatDate(item.result.measuredAt) }}</td>
              <td class="px-4 py-3 text-gray-700">{{ employeeName(item.result.employeeId) }}</td>
              <td class="px-4 py-3 text-right text-gray-700">
                {{ item.result.alcoholValue.toFixed(3) }} mg/L
              </td>
              <td class="px-4 py-3 text-center">
                <span
                  class="inline-block px-2 py-1 rounded-full text-xs font-medium"
                  :class="alcoholResultClass(item.result.resultType)"
                >
                  {{ alcoholResultLabel(item.result.resultType) }}
                </span>
              </td>
              <td class="px-4 py-3 text-center">
                <span
                  class="text-xs"
                  :class="item.retryCount >= 5 ? 'text-red-600 font-bold' : 'text-gray-500'"
                >
                  {{ item.retryCount }} / 5
                </span>
              </td>
              <td class="px-4 py-3 text-center">
                <button
                  :disabled="isDeleting === item.id"
                  class="px-3 py-1 text-xs text-red-600 border border-red-300 rounded hover:bg-red-50 transition-colors disabled:opacity-50"
                  @click="handleRemove(item.id)"
                >
                  {{ isDeleting === item.id ? '...' : '削除' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 空状態 -->
    <div v-else class="text-center py-8 text-gray-500">
      送信キューは空です
    </div>
  </div>
</template>
