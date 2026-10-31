<script setup lang="ts">
import type { DtakoDriver, DtakoDailyWorkHours } from '~/types'
import { getDtakoDrivers, getDtakoDailyHours } from '~/utils/api'

const drivers = ref<DtakoDriver[]>([])
const items = ref<DtakoDailyWorkHours[]>([])
const loading = ref(false)
const total = ref(0)
const page = ref(1)
const perPage = 31

const selectedDriverId = ref('')
const now = new Date()
const selectedMonth = ref(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)

// ドライバー名マップ
const driverNameMap = computed(() => {
  const map: Record<string, string> = {}
  for (const d of drivers.value) {
    map[d.id] = d.driver_name
  }
  return map
})

async function loadDrivers() {
  try {
    drivers.value = await getDtakoDrivers('tenko-monitor')
    if (drivers.value.length > 0 && !selectedDriverId.value) {
      selectedDriverId.value = drivers.value[0]!.id
    }
  } catch (e) {
    console.error('ドライバー取得エラー:', e)
  }
}

async function loadHours() {
  loading.value = true
  try {
    const [year, month] = selectedMonth.value.split('-').map(Number) as [number, number]
    const dateFrom = `${year}-${String(month).padStart(2, '0')}-01`
    const lastDay = new Date(year, month, 0).getDate()
    const dateTo = `${year}-${String(month).padStart(2, '0')}-${lastDay}`

    const res = await getDtakoDailyHours({
      driver_id: selectedDriverId.value || undefined,
      date_from: dateFrom,
      date_to: dateTo,
      page: page.value,
      per_page: perPage,
    }, 'tenko-monitor')
    items.value = res.items
    total.value = res.total
  } catch (e) {
    console.error('労働時間取得エラー:', e)
    items.value = []
  } finally {
    loading.value = false
  }
}

watch([() => selectedDriverId.value, () => selectedMonth], () => {
  page.value = 1
  loadHours()
})

onMounted(async () => {
  await loadDrivers()
  await loadHours()
})

function minutesToHM(m: number | null | undefined): string {
  if (m == null) return '-'
  const h = Math.floor(m / 60)
  const min = m % 60
  return `${h}:${String(min).padStart(2, '0')}`
}

function formatDate(d: string): string {
  const date = new Date(d)
  return `${date.getMonth() + 1}/${date.getDate()}`
}
</script>

<template>
  <div class="space-y-4">
    <h3 class="text-lg font-bold">労働時間</h3>

    <!-- フィルタ -->
    <div class="flex items-center gap-3 flex-wrap">
      <div>
        <label class="text-xs text-gray-500 block mb-1">ドライバー</label>
        <select v-model="selectedDriverId" class="border rounded px-2 py-1.5 text-sm min-w-[180px]">
          <option value="">全員</option>
          <option v-for="d in drivers" :key="d.id" :value="d.id">
            {{ d.driver_name }} ({{ d.driver_cd }})
          </option>
        </select>
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">月</label>
        <input v-model="selectedMonth" type="month" class="border rounded px-2 py-1.5 text-sm" />
      </div>
      <div class="pt-5">
        <span class="text-sm text-gray-500">{{ total }}件</span>
      </div>
    </div>

    <!-- テーブル -->
    <div v-if="loading" class="text-center py-8 text-gray-400">読み込み中...</div>
    <div v-else-if="items.length === 0" class="text-center py-8 text-gray-400">データなし</div>
    <div v-else class="overflow-x-auto">
      <table class="w-full text-sm border-collapse">
        <thead>
          <tr class="bg-gray-100 text-gray-600">
            <th class="px-2 py-1.5 text-left border">日付</th>
            <th v-if="!selectedDriverId" class="px-2 py-1.5 text-left border">ドライバー</th>
            <th class="px-2 py-1.5 text-right border">始業</th>
            <th class="px-2 py-1.5 text-right border">拘束</th>
            <th class="px-2 py-1.5 text-right border">運転</th>
            <th class="px-2 py-1.5 text-right border">荷役</th>
            <th class="px-2 py-1.5 text-right border">休息</th>
            <th class="px-2 py-1.5 text-right border">深夜</th>
            <th class="px-2 py-1.5 text-right border">距離(km)</th>
            <th class="px-2 py-1.5 text-right border">運行数</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id" class="hover:bg-gray-50">
            <td class="px-2 py-1 border">{{ formatDate(item.work_date) }}</td>
            <td v-if="!selectedDriverId" class="px-2 py-1 border text-xs">{{ driverNameMap[item.driver_id] || '-' }}</td>
            <td class="px-2 py-1 border text-right font-mono">{{ item.start_time?.slice(0, 5) || '-' }}</td>
            <td class="px-2 py-1 border text-right font-mono">{{ minutesToHM(item.total_work_minutes) }}</td>
            <td class="px-2 py-1 border text-right font-mono">{{ minutesToHM(item.drive_minutes) }}</td>
            <td class="px-2 py-1 border text-right font-mono">{{ minutesToHM(item.cargo_minutes) }}</td>
            <td class="px-2 py-1 border text-right font-mono">{{ minutesToHM(item.total_rest_minutes) }}</td>
            <td class="px-2 py-1 border text-right font-mono" :class="item.late_night_minutes > 0 ? 'text-purple-600' : ''">
              {{ minutesToHM(item.late_night_minutes) }}
            </td>
            <td class="px-2 py-1 border text-right font-mono">{{ item.total_distance?.toFixed(1) ?? '-' }}</td>
            <td class="px-2 py-1 border text-right">{{ item.operation_count }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
