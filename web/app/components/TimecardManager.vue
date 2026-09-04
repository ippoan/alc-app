<script setup lang="ts">
import type { ApiEmployee, TimecardCard, TimePunch } from '~/types'
import {
  getEmployees, listTimecardCards, createTimecardCard, deleteTimecardCard,
  listTimePunches, downloadTimePunchesCsv, listHubMeasurements,
} from '~/utils/api'

type SubTab = 'cards' | 'punches'
const subTab = ref<SubTab>('cards')

// --- カード登録 ---
const employees = ref<ApiEmployee[]>([])
const cards = ref<TimecardCard[]>([])
const selectedEmployeeId = ref('')
const cardLabel = ref('')
const isLoadingCards = ref(false)
const isRegistering = ref(false)
const cardError = ref('')
const nfcCardId = ref<string | null>(null)

const nfc = useNfcWebSocket()

const employeeMap = computed(() => {
  const map: Record<string, ApiEmployee> = {}
  for (const e of employees.value) map[e.id] = e
  return map
})

async function loadCards() {
  isLoadingCards.value = true
  try {
    const [emps, crds] = await Promise.all([getEmployees(), listTimecardCards()])
    employees.value = emps
    cards.value = crds
  }
  catch { /* ignore */ }
  finally { isLoadingCards.value = false }
}

onMounted(() => {
  nfc.connect()
  nfc.onRead((event) => {
    nfcCardId.value = event.employee_id
  })
  loadCards()
})

async function registerCard() {
  if (!selectedEmployeeId.value || !nfcCardId.value) return
  isRegistering.value = true
  cardError.value = ''
  try {
    await createTimecardCard({
      employee_id: selectedEmployeeId.value,
      card_id: nfcCardId.value,
      label: cardLabel.value || undefined,
    })
    nfcCardId.value = null
    cardLabel.value = ''
    await loadCards()
  }
  catch (e: any) {
    if (e?.message?.includes('409') || e?.status === 409) {
      cardError.value = 'このカードは既に登録されています'
    }
    else {
      cardError.value = 'カード登録に失敗しました'
    }
  }
  finally { isRegistering.value = false }
}

const deletingCardId = ref<string | null>(null)

async function removeCard(id: string) {
  deletingCardId.value = id
  try {
    await deleteTimecardCard(id)
    await loadCards()
  }
  catch { /* ignore */ }
  finally { deletingCardId.value = null }
}

// --- 打刻履歴 ---
const punches = ref<TimePunch[]>([])
const punchTotal = ref(0)
const punchPage = ref(1)
const punchPerPage = 50
const isLoadingPunches = ref(false)
const filterDate = ref(new Date().toISOString().slice(0, 10))
const filterEmployeeId = ref('')

/**
 * 点呼から拾った「打刻に相当する記録」(Refs ippoan/alc-app-s3#134)。
 *
 * **始業点呼 = 始業打刻**のように、点呼そのものが打刻を兼ねることがあるため、
 * カードをかざした打刻 (`time_punches`) と同じ表に並べて出す。
 *
 * **表示だけで `time_punches` に行は作らない。** 勤怠の一次データを画面の都合で
 * 書き足すと、あとから「これは実際に打刻されたのか」を区別できなくなる。
 * どちらから来た記録かは「区分」列で分かるようにしてある。
 */
const tenkoRows = ref<HistoryRow[]>([])

/** 打刻履歴の 1 行。カード打刻と点呼を同じ形に均して並べる。 */
interface HistoryRow {
  key: string
  /** 並び替えと表示に使う時刻 (ISO) */
  at: string
  employeeName: string
  deviceName: string
  /** どこから来た記録か。`punch` = カードをかざした打刻、`tenko` = 点呼 */
  origin: 'punch' | 'tenko'
}

/** nfc_id (免許証の交付日 8 桁 + 有効期限 8 桁) → 乗務員。点呼を人に結びつける。 */
const employeeByNfc = computed(() => {
  const map = new Map<string, ApiEmployee>()
  for (const e of employees.value) {
    if (e.nfc_id) map.set(e.nfc_id, e)
  }
  return map
})

/** 打刻 + 点呼をまとめて新しい順に並べたもの。 */
const historyRows = computed<HistoryRow[]>(() => {
  const rows: HistoryRow[] = punches.value.map(p => ({
    key: `p:${p.id}`,
    at: p.punched_at,
    employeeName: employeeName(p.employee_id),
    deviceName: p.device_name ?? '-',
    origin: 'punch' as const,
  }))
  rows.push(...tenkoRows.value)
  // 表示は日付で絞ってあるので、同日内の新しい順に並べれば足りる
  return rows.sort((a, b) => b.at.localeCompare(a.at))
})

async function loadPunches() {
  isLoadingPunches.value = true
  try {
    const dateFrom = `${filterDate.value}T00:00:00+09:00`
    const dateTo = `${filterDate.value}T23:59:59+09:00`
    const res = await listTimePunches({
      date_from: dateFrom,
      date_to: dateTo,
      employee_id: filterEmployeeId.value || undefined,
      page: punchPage.value,
      per_page: punchPerPage,
    })
    punches.value = res.punches
    punchTotal.value = res.total
  }
  catch { /* ignore */ }
  finally { isLoadingPunches.value = false }
  await loadTenkoRows()
}

/**
 * 同じ日の点呼 (ハブ測定値の `kind=license`) を拾って打刻履歴に混ぜる。
 *
 * 失敗しても打刻履歴自体は出す (点呼が出ないだけ) — ハブ測定値の API は
 * 端末が繋がっていない環境では空でも正常なので、ここで表を落とさない。
 * 乗務員で絞っているときは、その人の点呼だけに絞る。
 */
async function loadTenkoRows() {
  try {
    const res = await listHubMeasurements({
      kind: 'license',
      from: new Date(`${filterDate.value}T00:00:00+09:00`).toISOString(),
      to: new Date(`${filterDate.value}T23:59:59+09:00`).toISOString(),
      limit: 200,
    })
    const rows: HistoryRow[] = []
    for (const item of res.items) {
      const payload = item.payload as { nfc_id?: unknown } | null
      const nfcId = payload && typeof payload.nfc_id === 'string' ? payload.nfc_id : null
      const emp = nfcId ? employeeByNfc.value.get(nfcId) : undefined
      // 乗務員で絞り込み中は、その人の点呼だけ残す (誰か分からない点呼も落とす)
      if (filterEmployeeId.value && emp?.id !== filterEmployeeId.value) continue
      rows.push({
        key: `t:${item.id}`,
        at: item.created_at,
        employeeName: emp?.name ?? (nfcId ? '未登録の免許証' : '不明'),
        deviceName: item.device_id,
        origin: 'tenko',
      })
    }
    tenkoRows.value = rows
  }
  catch {
    tenkoRows.value = []
  }
}

watch(subTab, (tab) => {
  if (tab === 'punches') loadPunches()
})

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function employeeName(employeeId: string): string {
  return employeeMap.value[employeeId]?.name ?? employeeId.slice(0, 8)
}

async function exportCsv() {
  const dateFrom = `${filterDate.value}T00:00:00+09:00`
  const dateTo = `${filterDate.value}T23:59:59+09:00`
  await downloadTimePunchesCsv({
    date_from: dateFrom,
    date_to: dateTo,
    employee_id: filterEmployeeId.value || undefined,
  })
}
</script>

<template>
  <div>
    <!-- サブタブ -->
    <div class="flex gap-1 bg-gray-100 rounded-lg p-1 mb-4 w-fit">
      <button
        v-for="t in ([{ key: 'cards' as const, label: 'カード登録' }, { key: 'punches' as const, label: '打刻履歴' }])"
        :key="t.key"
        class="px-4 py-2 rounded-md text-sm font-medium transition-colors"
        :class="subTab === t.key ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-600 hover:text-gray-800'"
        @click="subTab = t.key"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- カード登録タブ -->
    <template v-if="subTab === 'cards'">
      <!-- 登録フォーム -->
      <div class="bg-white border rounded-lg p-4 mb-4">
        <h3 class="text-sm font-medium text-gray-700 mb-3">カード登録</h3>
        <div class="flex flex-wrap gap-3 items-end">
          <div>
            <label class="block text-xs text-gray-500 mb-1">社員</label>
            <select v-model="selectedEmployeeId" class="border rounded px-3 py-2 text-sm">
              <option value="">選択してください</option>
              <option v-for="e in employees" :key="e.id" :value="e.id">
                {{ e.name }} {{ e.code ? `(${e.code})` : '' }}
              </option>
            </select>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">カードID</label>
            <input
              :value="nfcCardId ?? ''"
              readonly
              placeholder="カードをかざしてください"
              class="border rounded px-3 py-2 text-sm bg-gray-50 w-56"
            >
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">ラベル (任意)</label>
            <input
              v-model="cardLabel"
              placeholder="例: 社員証"
              class="border rounded px-3 py-2 text-sm w-32"
            >
          </div>
          <button
            :disabled="!selectedEmployeeId || !nfcCardId || isRegistering"
            class="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            @click="registerCard"
          >
            {{ isRegistering ? '登録中...' : '登録' }}
          </button>
        </div>
        <div class="mt-2 flex items-center gap-2 text-xs">
          <span
            class="w-2 h-2 rounded-full"
            :class="nfc.isConnected.value ? 'bg-green-500' : 'bg-red-500'"
          />
          <span class="text-gray-500">{{ nfc.isConnected.value ? 'NFC 接続中' : 'NFC 未接続' }}</span>
        </div>
        <p v-if="cardError" class="text-red-600 text-sm mt-2">{{ cardError }}</p>
      </div>

      <!-- カード一覧 -->
      <div class="bg-white border rounded-lg overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-50">
            <tr>
              <th class="text-left px-4 py-2 font-medium text-gray-600">社員名</th>
              <th class="text-left px-4 py-2 font-medium text-gray-600">カードID</th>
              <th class="text-left px-4 py-2 font-medium text-gray-600">ラベル</th>
              <th class="text-left px-4 py-2 font-medium text-gray-600">登録日</th>
              <th class="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="isLoadingCards">
              <td colspan="5" class="px-4 py-6 text-center text-gray-500">読み込み中...</td>
            </tr>
            <tr v-else-if="cards.length === 0">
              <td colspan="5" class="px-4 py-6 text-center text-gray-500">登録カードなし</td>
            </tr>
            <tr v-for="card in cards" :key="card.id" class="border-t">
              <td class="px-4 py-2">{{ employeeName(card.employee_id) }}</td>
              <td class="px-4 py-2 font-mono text-xs">{{ card.card_id }}</td>
              <td class="px-4 py-2">{{ card.label ?? '-' }}</td>
              <td class="px-4 py-2">{{ new Date(card.created_at).toLocaleDateString('ja-JP') }}</td>
              <td class="px-4 py-2 text-right">
                <button
                  class="text-red-600 hover:text-red-800 text-xs"
                  :disabled="deletingCardId === card.id"
                  @click="removeCard(card.id)"
                >
                  {{ deletingCardId === card.id ? '削除中...' : '削除' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- 打刻履歴タブ -->
    <template v-if="subTab === 'punches'">
      <div class="flex flex-wrap gap-3 items-end mb-4">
        <div>
          <label class="block text-xs text-gray-500 mb-1">日付</label>
          <input v-model="filterDate" type="date" class="border rounded px-3 py-2 text-sm">
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">社員</label>
          <select v-model="filterEmployeeId" class="border rounded px-3 py-2 text-sm">
            <option value="">全員</option>
            <option v-for="e in employees" :key="e.id" :value="e.id">{{ e.name }}</option>
          </select>
        </div>
        <button
          class="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
          @click="loadPunches"
        >
          検索
        </button>
        <button
          class="px-4 py-2 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300"
          @click="exportCsv"
        >
          CSV出力
        </button>
      </div>

      <div class="bg-white border rounded-lg overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-50">
            <tr>
              <th class="text-left px-4 py-2 font-medium text-gray-600">社員名</th>
              <th class="text-left px-4 py-2 font-medium text-gray-600">打刻日時</th>
              <th class="text-left px-4 py-2 font-medium text-gray-600">区分</th>
              <th class="text-left px-4 py-2 font-medium text-gray-600">デバイス</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="isLoadingPunches">
              <td colspan="4" class="px-4 py-6 text-center text-gray-500">読み込み中...</td>
            </tr>
            <tr v-else-if="historyRows.length === 0">
              <td colspan="4" class="px-4 py-6 text-center text-gray-500">打刻記録なし</td>
            </tr>
            <tr v-for="row in historyRows" :key="row.key" class="border-t">
              <td class="px-4 py-2">{{ row.employeeName }}</td>
              <td class="px-4 py-2">{{ formatTime(row.at) }}</td>
              <td class="px-4 py-2">
                <span
                  class="px-2 py-0.5 rounded text-xs font-medium"
                  :class="row.origin === 'tenko' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-700'"
                >{{ row.origin === 'tenko' ? '点呼' : '打刻' }}</span>
              </td>
              <td class="px-4 py-2 text-gray-500">{{ row.deviceName }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="punchTotal > punchPerPage" class="px-4 py-2 border-t text-sm text-gray-500 flex gap-2 items-center">
          <button :disabled="punchPage <= 1" class="px-2 py-1 border rounded disabled:opacity-50" @click="punchPage--; loadPunches()">前へ</button>
          <span>{{ punchPage }} / {{ Math.ceil(punchTotal / punchPerPage) }}</span>
          <button :disabled="punchPage * punchPerPage >= punchTotal" class="px-2 py-1 border rounded disabled:opacity-50" @click="punchPage++; loadPunches()">次へ</button>
        </div>
      </div>
    </template>
  </div>
</template>
