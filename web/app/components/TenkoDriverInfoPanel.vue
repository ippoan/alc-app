<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import type { DriverInfo } from '~/types'
import { getDriverInfo } from '~/utils/api'
import { tenkoTypeLabel } from '~/utils/tenko-type'

const props = defineProps<{
  employeeId: string
  sessionId?: string
}>()

const emit = defineEmits<{
  close: []
}>()

const info = ref<DriverInfo | null>(null)
const loading = ref(false)
const activeTab = ref<string>('health')

const tabs = [
  { key: 'health', label: 'イ 健康状態' },
  { key: 'hours', label: 'ロ 労働時間' },
  { key: 'guidance', label: 'ハ 指導監督' },
  { key: 'items', label: 'ニ 携行品' },
  { key: 'registry', label: 'ホ 乗務員台帳' },
  { key: 'records', label: 'ヘ 点呼記録' },
  { key: 'vehicle', label: 'ト 車両整備' },
]

async function load() {
  loading.value = true
  try {
    info.value = await getDriverInfo(props.employeeId)
  } catch (e) {
    console.error('運転者情報取得エラー:', e)
  } finally {
    loading.value = false
  }
}

watch(() => props.employeeId, load)
onMounted(load)

function formatDate(d: string | null) {
  if (!d) return '-'
  return new Date(d).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function formatDateOnly(d: string | null) {
  if (!d) return '-'
  return new Date(d).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })
}
function minutesToHM(m: number | null) {
  if (m == null) return '-'
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}
</script>

<template>
  <div class="fixed right-0 top-0 h-full w-[420px] bg-white shadow-2xl z-50 flex flex-col overflow-hidden border-l">
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3 bg-gray-800 text-white">
      <span class="font-bold">運転者情報</span>
      <button class="text-gray-300 hover:text-white text-xl" @click="emit('close')">✕</button>
    </div>

    <!-- Tabs -->
    <div class="flex flex-wrap gap-1 px-2 py-2 bg-gray-100 border-b">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="px-2 py-1 text-xs rounded"
        :class="activeTab === tab.key ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-200'"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-4">
      <div v-if="loading" class="text-center py-8 text-gray-400">読み込み中...</div>
      <div v-else-if="!info" class="text-center py-8 text-gray-400">データなし</div>

      <!-- イ 健康状態 -->
      <div v-else-if="activeTab === 'health'" class="space-y-3">
        <h4 class="font-bold text-sm">健康基準値</h4>
        <div v-if="info.health_baseline" class="grid grid-cols-2 gap-2 text-sm">
          <div>収縮期血圧: {{ info.health_baseline.baseline_systolic ?? '-' }} ±{{ info.health_baseline.systolic_tolerance ?? '-' }}</div>
          <div>拡張期血圧: {{ info.health_baseline.baseline_diastolic ?? '-' }} ±{{ info.health_baseline.diastolic_tolerance ?? '-' }}</div>
          <div>体温: {{ info.health_baseline.baseline_temperature ?? '-' }} ±{{ info.health_baseline.temperature_tolerance ?? '-' }}</div>
        </div>
        <div v-else class="text-sm text-gray-400">基準値未設定</div>

        <h4 class="font-bold text-sm mt-4">直近の測定値</h4>
        <table class="w-full text-xs">
          <thead><tr class="bg-gray-50"><th>日時</th><th>体温</th><th>血圧</th><th>脈拍</th></tr></thead>
          <tbody>
            <tr v-for="m in info.recent_measurements" :key="m.id" class="border-t">
              <td>{{ formatDate(m.measured_at) }}</td>
              <td>{{ m.temperature ? `${m.temperature}°C` : '-' }}</td>
              <td>{{ m.systolic && m.diastolic ? `${m.systolic}/${m.diastolic}` : '-' }}</td>
              <td>{{ m.pulse ?? '-' }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="info.recent_measurements.length === 0" class="text-xs text-gray-400">測定履歴なし</div>
      </div>

      <!-- ロ 労働時間 -->
      <div v-else-if="activeTab === 'hours'" class="space-y-3">
        <h4 class="font-bold text-sm">直近7日の労働時間</h4>
        <table class="w-full text-xs">
          <thead><tr class="bg-gray-50"><th>日付</th><th>拘束</th><th>運転</th><th>深夜</th></tr></thead>
          <tbody>
            <tr v-for="wh in info.working_hours" :key="wh.id" class="border-t">
              <td>{{ formatDateOnly(wh.work_date) }}</td>
              <td>{{ minutesToHM(wh.total_work_minutes) }}</td>
              <td>{{ minutesToHM(wh.drive_minutes) }}</td>
              <td>{{ minutesToHM(wh.late_night_minutes) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="info.working_hours.length === 0" class="text-xs text-gray-400">労働時間データなし</div>
      </div>

      <!-- ハ 指導監督 -->
      <div v-else-if="activeTab === 'guidance'" class="space-y-3">
        <h4 class="font-bold text-sm">指導監督の記録 (直近10件)</h4>
        <div v-for="ins in info.past_instructions" :key="ins.session_id" class="border rounded p-2 text-sm">
          <div class="text-xs text-gray-400">{{ formatDate(ins.recorded_at) }}</div>
          <div>{{ ins.instruction }}</div>
          <div v-if="ins.instruction_confirmed_at" class="text-xs text-green-600">確認済 {{ formatDate(ins.instruction_confirmed_at) }}</div>
        </div>
        <div v-if="info.past_instructions.length === 0" class="text-xs text-gray-400">指導記録なし</div>
      </div>

      <!-- ニ 携行品 -->
      <div v-else-if="activeTab === 'items'" class="space-y-3">
        <h4 class="font-bold text-sm">携行品マスタ</h4>
        <div v-for="item in info.carrying_items" :key="item.id" class="flex items-center gap-2 text-sm border-b py-1">
          <span class="flex-1">{{ item.item_name }}</span>
          <span v-if="item.is_required" class="text-xs bg-red-100 text-red-700 px-1 rounded">必須</span>
        </div>
        <div v-if="info.carrying_items.length === 0" class="text-xs text-gray-400">携行品未登録</div>
      </div>

      <!-- ホ 乗務員台帳 -->
      <div v-else-if="activeTab === 'registry'" class="space-y-3">
        <h4 class="font-bold text-sm">乗務員情報</h4>
        <div class="grid grid-cols-2 gap-2 text-sm">
          <div>氏名: <strong>{{ info.employee.name }}</strong></div>
          <div>社員コード: {{ info.employee.code || '-' }}</div>
          <div>役割: {{ info.employee.role?.join(', ') || '-' }}</div>
          <div>免許有効期限: {{ info.employee.license_expiry_date || '-' }}</div>
          <div>免許交付日: {{ info.employee.license_issue_date || '-' }}</div>
        </div>
        <div v-if="info.employee.face_photo_url" class="mt-2">
          <img :src="info.employee.face_photo_url" class="w-24 h-24 rounded object-cover" />
        </div>
      </div>

      <!-- ヘ 点呼記録 -->
      <div v-else-if="activeTab === 'records'" class="space-y-3">
        <h4 class="font-bold text-sm">過去の点呼記録 (直近10件)</h4>
        <div v-for="rec in info.past_tenko_records" :key="rec.id" class="border rounded p-2 text-xs">
          <div class="flex justify-between">
            <span>{{ formatDate(rec.recorded_at) }}</span>
            <span :class="rec.status === 'completed' ? 'text-green-600' : 'text-red-600'">{{ rec.status }}</span>
          </div>
          <div>種別: {{ tenkoTypeLabel(rec.tenko_type) }}</div>
          <div v-if="rec.alcohol_result">アルコール: {{ rec.alcohol_result }} ({{ rec.alcohol_value }}mg/L)</div>
          <div v-if="rec.safety_judgment">安全判定: {{ (rec.safety_judgment as any)?.status === 'pass' ? '合格' : '不合格' }}</div>
        </div>
        <div v-if="info.past_tenko_records.length === 0" class="text-xs text-gray-400">点呼記録なし</div>
      </div>

      <!-- ト 車両整備 -->
      <div v-else-if="activeTab === 'vehicle'" class="space-y-3">
        <h4 class="font-bold text-sm">直近の日常点検</h4>
        <div v-for="insp in info.recent_daily_inspections" :key="insp.session_id" class="border rounded p-2 text-xs">
          <div class="text-gray-400">{{ formatDate(insp.recorded_at) }}</div>
          <div class="grid grid-cols-4 gap-1 mt-1">
            <span v-for="(val, key) in insp.daily_inspection" :key="String(key)"
              :class="val === 'ok' ? 'text-green-600' : 'text-red-600'">
              {{ key }}: {{ val }}
            </span>
          </div>
        </div>
        <div v-if="info.recent_daily_inspections.length === 0" class="text-xs text-gray-400">日常点検記録なし</div>

        <h4 class="font-bold text-sm mt-4">未解決の機器故障</h4>
        <div v-for="f in info.equipment_failures" :key="f.id" class="border rounded p-2 text-xs">
          <div>{{ f.failure_type }} - {{ f.description || '詳細なし' }}</div>
          <div class="text-gray-400">報告日: {{ formatDate(f.detected_at) }}</div>
        </div>
        <div v-if="info.equipment_failures.length === 0" class="text-xs text-green-600">未解決の故障なし</div>
      </div>
    </div>
  </div>
</template>
