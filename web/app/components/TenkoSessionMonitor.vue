<script setup lang="ts">
import type { TenkoSession, TenkoSessionFilter, TenkoRecordFilter, TenkoType, ApiEmployee } from '~/types'
import { listTenkoSessions, interruptTenkoSession, resumeTenkoSession, cancelTenkoSession, getEmployees, downloadTenkoRecordsCsv } from '~/utils/api'
import { tenkoTypeLabel } from '~/utils/tenko-type'

const emit = defineEmits<{ changed: [] }>()

const sessions = ref<TenkoSession[]>([])
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
const filterStatus = ref('')
const filterTenkoType = ref<'' | TenkoType>('')
const filterDateFrom = ref('')
const filterDateTo = ref('')

async function fetchData() {
  isLoading.value = true
  error.value = null
  try {
    const filter: TenkoSessionFilter = { page: page.value, per_page: perPage }
    if (filterEmployeeId.value) filter.employee_id = filterEmployeeId.value
    if (filterStatus.value) filter.status = filterStatus.value
    if (filterTenkoType.value) filter.tenko_type = filterTenkoType.value
    if (filterDateFrom.value) filter.date_from = filterDateFrom.value
    if (filterDateTo.value) filter.date_to = filterDateTo.value
    const res = await listTenkoSessions(filter)
    sessions.value = res.sessions
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

// CSV 出力 (今の絞り込みの値をそのまま渡す。TenkoSessionFilter と TenkoRecordFilter は同じフィールド)
const isDownloading = ref(false)

async function handleCsvDownload() {
  isDownloading.value = true
  error.value = null
  try {
    const filter: TenkoRecordFilter = {}
    if (filterEmployeeId.value) filter.employee_id = filterEmployeeId.value
    if (filterStatus.value) filter.status = filterStatus.value
    if (filterTenkoType.value) filter.tenko_type = filterTenkoType.value
    if (filterDateFrom.value) filter.date_from = filterDateFrom.value
    if (filterDateTo.value) filter.date_to = filterDateTo.value
    await downloadTenkoRecordsCsv(filter)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'CSVダウンロードエラー'
  } finally {
    isDownloading.value = false
  }
}

// 中断操作
const interruptingId = ref<string | null>(null)
const interruptReason = ref('')

async function handleInterrupt(id: string) {
  error.value = null
  try {
    await interruptTenkoSession(id, { reason: interruptReason.value || undefined })
    interruptingId.value = null
    interruptReason.value = ''
    await fetchData()
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '中断エラー'
  }
}

// 再開操作
const resumingId = ref<string | null>(null)
const resumeReason = ref('')

async function handleResume(id: string) {
  if (!resumeReason.value.trim()) return
  error.value = null
  try {
    await resumeTenkoSession(id, { reason: resumeReason.value.trim() })
    resumingId.value = null
    resumeReason.value = ''
    await fetchData()
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '再開エラー'
  }
}

// キャンセル操作
const cancellingId = ref<string | null>(null)
const cancelReason = ref('')

async function handleCancel(id: string) {
  error.value = null
  try {
    await cancelTenkoSession(id, { reason: cancelReason.value || '' })
    cancellingId.value = null
    cancelReason.value = ''
    await fetchData()
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'キャンセルエラー'
  }
}

// 一括キャンセル
const selectedIds = ref<Set<string>>(new Set())
const isBulkCancelling = ref(false)

const cancellableSessions = computed(() => sessions.value.filter(s => !['completed', 'cancelled'].includes(s.status)))
const allCancellableSelected = computed(
  () => cancellableSessions.value.length > 0 && cancellableSessions.value.every(s => selectedIds.value.has(s.id))
)

function toggleSelectAll() {
  if (allCancellableSelected.value) {
    cancellableSessions.value.forEach(s => selectedIds.value.delete(s.id))
  } else {
    cancellableSessions.value.forEach(s => selectedIds.value.add(s.id))
  }
  selectedIds.value = new Set(selectedIds.value)
}

function toggleSelect(id: string) {
  if (selectedIds.value.has(id)) {
    selectedIds.value.delete(id)
  } else {
    selectedIds.value.add(id)
  }
  selectedIds.value = new Set(selectedIds.value)
}

async function handleBulkCancel() {
  if (selectedIds.value.size === 0) return
  isBulkCancelling.value = true
  error.value = null
  try {
    await Promise.all([...selectedIds.value].map(id => cancelTenkoSession(id, { reason: '' })))
    selectedIds.value = new Set()
    await fetchData()
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '一括キャンセルエラー'
  } finally {
    isBulkCancelling.value = false
  }
}

// 詳細モーダル
const selectedSession = ref<TenkoSession | null>(null)

function formatDate(iso: string | null) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function statusLabel(s: string) {
  const map: Record<string, string> = {
    identity_verified: '本人確認済',
    alcohol_testing: 'アルコール検査中',
    medical_pending: '医療測定待ち',
    self_declaration_pending: '自己申告待ち',
    safety_judgment_pending: '安全判定中',
    daily_inspection_pending: '日常点検待ち',
    instruction_pending: '指示確認待ち',
    report_pending: '報告待ち',
    interrupted: '中断',
    completed: '完了',
    cancelled: 'キャンセル',
  }
  return map[s] || s
}

function statusColor(s: string) {
  if (s === 'completed') return 'bg-green-100 text-green-800'
  if (s === 'cancelled') return 'bg-red-100 text-red-800'
  if (s === 'interrupted') return 'bg-orange-100 text-orange-800'
  return 'bg-yellow-100 text-yellow-800'
}

function isActive(s: TenkoSession) {
  return !['completed', 'cancelled', 'interrupted'].includes(s.status)
}

function alcoholLabel(r: string | null) {
  if (!r) return '-'
  const map: Record<string, string> = { pass: '正常', fail: '検出', normal: '正常', over: '基準超', error: 'エラー' }
  return map[r] || r
}

function selfDeclarationLabel(key: string) {
  const map: Record<string, string> = { illness: '疾病', fatigue: '疲労', sleep_deprivation: '睡眠不足' }
  return map[key] || key
}

function inspectionLabel(key: string) {
  const map: Record<string, string> = {
    brakes: 'ブレーキ', tires: 'タイヤ', lights: 'ライト', steering: 'ステアリング',
    wipers: 'ワイパー', mirrors: 'ミラー', horn: 'ホーン', seatbelts: 'シートベルト',
  }
  return map[key] || key
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
        <select v-model="filterStatus" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">全ステータス</option>
          <option value="identity_verified">本人確認済</option>
          <option value="alcohol_testing">アルコール検査中</option>
          <option value="medical_pending">医療測定待ち</option>
          <option value="self_declaration_pending">自己申告待ち</option>
          <option value="daily_inspection_pending">日常点検待ち</option>
          <option value="instruction_pending">指示確認待ち</option>
          <option value="report_pending">報告待ち</option>
          <option value="interrupted">中断</option>
          <option value="completed">完了</option>
          <option value="cancelled">キャンセル</option>
        </select>
        <select v-model="filterTenkoType" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">全種別</option>
          <option value="pre_operation">{{ tenkoTypeLabel('pre_operation') }}</option>
          <option value="post_operation">{{ tenkoTypeLabel('post_operation') }}</option>
        </select>
        <input v-model="filterDateFrom" type="date" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        <input v-model="filterDateTo" type="date" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      </div>
      <div class="flex gap-2 mt-3">
        <button class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors" @click="applyFilter">検索</button>
        <button
          :disabled="isDownloading"
          class="px-4 py-2 bg-gray-600 text-white rounded-lg text-sm hover:bg-gray-700 transition-colors disabled:opacity-50"
          @click="handleCsvDownload"
        >{{ isDownloading ? 'ダウンロード中...' : 'CSV出力' }}</button>
      </div>
    </div>

    <!-- エラー -->
    <div v-if="error" class="bg-red-50 text-red-700 p-3 rounded-lg mb-4 text-sm">{{ error }}</div>

    <!-- ローディング -->
    <div v-if="isLoading" class="text-center py-8 text-gray-500">読み込み中...</div>

    <!-- 一括キャンセルバー -->
    <div v-if="selectedIds.size > 0" class="bg-red-50 border border-red-200 rounded-xl p-3 mb-2 flex items-center justify-between">
      <span class="text-sm text-red-700">{{ selectedIds.size }} 件選択中</span>
      <button
        :disabled="isBulkCancelling"
        class="px-3 py-1.5 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 disabled:opacity-50 transition-colors"
        @click="handleBulkCancel"
      >
        {{ isBulkCancelling ? 'キャンセル中...' : '一括キャンセル' }}
      </button>
    </div>

    <!-- テーブル -->
    <div v-if="!isLoading && sessions.length > 0" class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-gray-600">
            <tr>
              <th class="px-3 py-3 text-center font-medium w-8">
                <input
                  v-if="cancellableSessions.length > 0"
                  type="checkbox"
                  :checked="allCancellableSelected"
                  class="cursor-pointer"
                  @change="toggleSelectAll"
                >
              </th>
              <th class="px-4 py-3 text-left font-medium">開始日時</th>
              <th class="px-4 py-3 text-left font-medium">乗務員</th>
              <th class="px-4 py-3 text-center font-medium">種別</th>
              <th class="px-4 py-3 text-center font-medium">ステータス</th>
              <th class="px-4 py-3 text-center font-medium">アルコール</th>
              <th class="px-4 py-3 text-left font-medium">管理者</th>
              <th class="px-4 py-3 text-center font-medium">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="s in sessions" :key="s.id" class="hover:bg-gray-50 cursor-pointer" @click="selectedSession = s">
              <td class="px-3 py-3 text-center" @click.stop>
                <input
                  v-if="!['completed', 'cancelled'].includes(s.status)"
                  type="checkbox"
                  :checked="selectedIds.has(s.id)"
                  class="cursor-pointer"
                  @change="toggleSelect(s.id)"
                >
              </td>
              <td class="px-4 py-3 text-gray-700">{{ formatDate(s.started_at || s.created_at) }}</td>
              <td class="px-4 py-3 text-gray-700">{{ employeeName(s.employee_id) }}</td>
              <td class="px-4 py-3 text-center">
                <span class="inline-block px-2 py-1 rounded-full text-xs font-medium"
                  :class="s.tenko_type === 'pre_operation' ? 'bg-blue-100 text-blue-800' : s.tenko_type === 'post_operation' ? 'bg-purple-100 text-purple-800' : 'bg-gray-100 text-gray-700'">
                  {{ tenkoTypeLabel(s.tenko_type) }}
                </span>
              </td>
              <td class="px-4 py-3 text-center">
                <span class="inline-block px-2 py-1 rounded-full text-xs font-medium" :class="statusColor(s.status)">
                  {{ statusLabel(s.status) }}
                </span>
              </td>
              <td class="px-4 py-3 text-center">
                <span v-if="s.alcohol_result"
                  class="inline-block px-2 py-1 rounded-full text-xs font-medium"
                  :class="s.alcohol_result === 'pass' || s.alcohol_result === 'normal' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'">
                  {{ alcoholLabel(s.alcohol_result) }}
                </span>
                <span v-else class="text-gray-400 text-xs">-</span>
              </td>
              <td class="px-4 py-3 text-gray-700">{{ s.responsible_manager_name }}</td>
              <td class="px-4 py-3 text-center" @click.stop>
                <!-- 中断/キャンセルボタン (進行中セッションのみ) -->
                <template v-if="isActive(s)">
                  <div v-if="interruptingId === s.id" class="flex items-center gap-1">
                    <input v-model="interruptReason" type="text" placeholder="理由 (任意)" class="px-2 py-1 border border-gray-300 rounded text-xs w-24">
                    <button class="px-2 py-1 bg-orange-600 text-white rounded text-xs" @click="handleInterrupt(s.id)">中断</button>
                    <button class="px-2 py-1 bg-gray-200 text-gray-700 rounded text-xs" @click="interruptingId = null">取消</button>
                  </div>
                  <div v-else-if="cancellingId === s.id" class="flex items-center gap-1">
                    <input v-model="cancelReason" type="text" placeholder="理由 (任意)" class="px-2 py-1 border border-gray-300 rounded text-xs w-24">
                    <button class="px-2 py-1 bg-red-600 text-white rounded text-xs" @click="handleCancel(s.id)">確定</button>
                    <button class="px-2 py-1 bg-gray-200 text-gray-700 rounded text-xs" @click="cancellingId = null">取消</button>
                  </div>
                  <div v-else class="flex items-center gap-1">
                    <button class="px-2 py-1 text-orange-600 hover:bg-orange-50 rounded text-xs" @click="interruptingId = s.id">中断</button>
                    <button class="px-2 py-1 text-red-600 hover:bg-red-50 rounded text-xs" @click="cancellingId = s.id; cancelReason = ''">キャンセル</button>
                  </div>
                </template>

                <!-- 再開/キャンセルボタン (中断セッションのみ) -->
                <template v-else-if="s.status === 'interrupted'">
                  <div v-if="resumingId === s.id" class="flex items-center gap-1">
                    <input v-model="resumeReason" type="text" placeholder="再開理由" class="px-2 py-1 border border-gray-300 rounded text-xs w-24">
                    <button :disabled="!resumeReason.trim()" class="px-2 py-1 bg-green-600 text-white rounded text-xs disabled:opacity-50" @click="handleResume(s.id)">再開</button>
                    <button class="px-2 py-1 bg-gray-200 text-gray-700 rounded text-xs" @click="resumingId = null">取消</button>
                  </div>
                  <div v-else-if="cancellingId === s.id" class="flex items-center gap-1">
                    <input v-model="cancelReason" type="text" placeholder="理由 (任意)" class="px-2 py-1 border border-gray-300 rounded text-xs w-24">
                    <button class="px-2 py-1 bg-red-600 text-white rounded text-xs" @click="handleCancel(s.id)">確定</button>
                    <button class="px-2 py-1 bg-gray-200 text-gray-700 rounded text-xs" @click="cancellingId = null">取消</button>
                  </div>
                  <div v-else class="flex items-center gap-1">
                    <button class="px-2 py-1 text-green-600 hover:bg-green-50 rounded text-xs" @click="resumingId = s.id">再開</button>
                    <button class="px-2 py-1 text-red-600 hover:bg-red-50 rounded text-xs" @click="cancellingId = s.id; cancelReason = ''">キャンセル</button>
                  </div>
                </template>

                <span v-else class="text-gray-400 text-xs">-</span>
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
    <div v-if="!isLoading && sessions.length === 0" class="text-center py-8 text-gray-500">セッションがありません</div>

    <!-- 詳細モーダル -->
    <div
      v-if="selectedSession"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="selectedSession = null"
    >
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-2xl mx-4 p-6 max-h-[80vh] overflow-y-auto">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold text-gray-800">セッション詳細</h3>
          <button class="text-gray-400 hover:text-gray-600 text-xl leading-none" @click="selectedSession = null">&times;</button>
        </div>

        <div class="space-y-4 text-sm">
          <!-- 基本情報 -->
          <div class="grid grid-cols-2 gap-2">
            <div><span class="text-gray-500">乗務員:</span> {{ employeeName(selectedSession.employee_id) }}</div>
            <div><span class="text-gray-500">種別:</span> {{ tenkoTypeLabel(selectedSession.tenko_type) }}</div>
            <div><span class="text-gray-500">ステータス:</span>
              <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium" :class="statusColor(selectedSession.status)">{{ statusLabel(selectedSession.status) }}</span>
            </div>
            <div><span class="text-gray-500">管理者:</span> {{ selectedSession.responsible_manager_name }}</div>
            <div><span class="text-gray-500">開始:</span> {{ formatDate(selectedSession.started_at) }}</div>
            <div><span class="text-gray-500">完了:</span> {{ formatDate(selectedSession.completed_at) }}</div>
          </div>

          <!-- アルコール -->
          <div v-if="selectedSession.alcohol_result" class="bg-gray-50 rounded-lg p-3">
            <h4 class="font-medium text-gray-700 mb-1">アルコール検査</h4>
            <div class="grid grid-cols-2 gap-2">
              <div><span class="text-gray-500">結果:</span> {{ alcoholLabel(selectedSession.alcohol_result) }}</div>
              <div><span class="text-gray-500">値:</span> {{ selectedSession.alcohol_value != null ? selectedSession.alcohol_value.toFixed(3) + ' mg/L' : '-' }}</div>
              <div><span class="text-gray-500">検査日時:</span> {{ formatDate(selectedSession.alcohol_tested_at) }}</div>
            </div>
          </div>

          <!-- 医療データ -->
          <div v-if="selectedSession.temperature != null || selectedSession.systolic != null" class="bg-gray-50 rounded-lg p-3">
            <h4 class="font-medium text-gray-700 mb-1">医療データ</h4>
            <div class="grid grid-cols-2 gap-2">
              <div v-if="selectedSession.temperature != null"><span class="text-gray-500">体温:</span> {{ selectedSession.temperature.toFixed(1) }} &#8451;</div>
              <div v-if="selectedSession.systolic != null"><span class="text-gray-500">血圧:</span> {{ selectedSession.systolic }}/{{ selectedSession.diastolic }} mmHg</div>
              <div v-if="selectedSession.pulse != null"><span class="text-gray-500">脈拍:</span> {{ selectedSession.pulse }} bpm</div>
            </div>
          </div>

          <!-- 自己申告 -->
          <div v-if="selectedSession.self_declaration" class="bg-gray-50 rounded-lg p-3">
            <h4 class="font-medium text-gray-700 mb-1">自己申告</h4>
            <div class="flex gap-3">
              <span v-for="(val, key) in { illness: selectedSession.self_declaration.illness, fatigue: selectedSession.self_declaration.fatigue, sleep_deprivation: selectedSession.self_declaration.sleep_deprivation }" :key="key"
                class="inline-block px-2 py-1 rounded-full text-xs font-medium"
                :class="val ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'">
                {{ selfDeclarationLabel(key as string) }}: {{ val ? 'あり' : 'なし' }}
              </span>
            </div>
          </div>

          <!-- 安全判定 -->
          <div v-if="selectedSession.safety_judgment" class="bg-gray-50 rounded-lg p-3">
            <h4 class="font-medium text-gray-700 mb-1">安全判定</h4>
            <div>
              <span class="inline-block px-2 py-1 rounded-full text-xs font-medium"
                :class="selectedSession.safety_judgment.status === 'pass' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'">
                {{ selectedSession.safety_judgment.status === 'pass' ? '合格' : '不合格' }}
              </span>
              <span v-if="selectedSession.safety_judgment.failed_items.length > 0" class="ml-2 text-red-700">
                不合格項目: {{ selectedSession.safety_judgment.failed_items.map(selfDeclarationLabel).join(', ') }}
              </span>
            </div>
          </div>

          <!-- 日常点検 -->
          <div v-if="selectedSession.daily_inspection" class="bg-gray-50 rounded-lg p-3">
            <h4 class="font-medium text-gray-700 mb-1">日常点検</h4>
            <div class="flex flex-wrap gap-2">
              <span v-for="key in ['brakes', 'tires', 'lights', 'steering', 'wipers', 'mirrors', 'horn', 'seatbelts']" :key="key"
                class="inline-block px-2 py-1 rounded-full text-xs font-medium"
                :class="(selectedSession.daily_inspection as any)[key] === 'ok' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'">
                {{ inspectionLabel(key) }}: {{ (selectedSession.daily_inspection as any)[key] === 'ok' ? 'OK' : 'NG' }}
              </span>
            </div>
          </div>

          <!-- 運行報告 -->
          <div v-if="selectedSession.report_submitted_at" class="bg-gray-50 rounded-lg p-3">
            <h4 class="font-medium text-gray-700 mb-1">運行報告</h4>
            <div v-if="selectedSession.report_no_report" class="text-gray-500">特記事項なし</div>
            <div v-else class="space-y-1">
              <div v-if="selectedSession.report_vehicle_road_status"><span class="text-gray-500">車両/道路:</span> {{ selectedSession.report_vehicle_road_status }}</div>
              <div v-if="selectedSession.report_driver_alternation"><span class="text-gray-500">交替運転:</span> {{ selectedSession.report_driver_alternation }}</div>
            </div>
          </div>

          <!-- 中断/再開情報 -->
          <div v-if="selectedSession.interrupted_at" class="bg-orange-50 rounded-lg p-3">
            <h4 class="font-medium text-orange-700 mb-1">中断情報</h4>
            <div><span class="text-gray-500">中断日時:</span> {{ formatDate(selectedSession.interrupted_at) }}</div>
            <div v-if="selectedSession.cancel_reason"><span class="text-gray-500">理由:</span> {{ selectedSession.cancel_reason }}</div>
            <div v-if="selectedSession.resumed_at"><span class="text-gray-500">再開日時:</span> {{ formatDate(selectedSession.resumed_at) }}</div>
            <div v-if="selectedSession.resume_reason"><span class="text-gray-500">再開理由:</span> {{ selectedSession.resume_reason }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
