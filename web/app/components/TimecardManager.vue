<script setup lang="ts">
import type { ApiEmployee, TimecardCard, TimePunchWithDevice } from '~/types'
import {
  getEmployees, listTimecardCards, createTimecardCard, deleteTimecardCard,
  listTimePunches, downloadTimePunchesCsv,
} from '~/utils/api'
import { jstTodayDate } from '~/utils/jst'

type SubTab = 'cards' | 'punches'

/**
 * **既定は打刻履歴。** カード登録は最初の 1 回しか使わないのに対し、打刻履歴は
 * 毎日見るため (ユーザー要望)。`?sub=cards` で登録側を直接開ける。
 *
 * 内側のタブがローカル ref だと **URL では到達できず、ログイン済みブラウザで
 * クリックできる人しか確認できない**。管理タブを `?tab=` で開けるようにしたのと
 * 同じ理由 (Refs ippoan/alc-app#156)。書き戻しはしない — 外側の `?tab=timecard`
 * は index.vue が持っており、URL の組み立てを 2 か所に散らしたくないため。
 */
const route = useRoute()
const subTab = ref<SubTab>(route.query.sub === 'cards' ? 'cards' : 'punches')

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
  // 既定が打刻履歴なので、初回は watch が発火しない (値が変わらないため)
  if (subTab.value === 'punches') loadPunches()
  void punchWatch.connect()
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
const punches = ref<TimePunchWithDevice[]>([])
const punchTotal = ref(0)
const punchPage = ref(1)
const punchPerPage = 50
const isLoadingPunches = ref(false)
// **既定は JST の今日。** `toISOString().slice(0, 10)` は UTC の日付なので、
// JST 00:00〜09:00 のあいだ「昨日」を開いてしまう (範囲は `+09:00` で正しく
// 作っているのに、その範囲を間違った日に当てることになる)
const filterDate = ref(jstTodayDate())
const filterEmployeeId = ref('')

/** 打刻履歴の 1 行。打刻と点呼を同じ形に均して並べる。 */
interface HistoryRow {
  key: string
  /** 並び替えと表示に使う時刻 (ISO) */
  at: string
  employeeName: string
  deviceName: string
  /** `punch` = 打刻、`tenko` = 点呼 */
  origin: 'punch' | 'tenko'
}

/**
 * 打刻 + 点呼を新しい順に並べたもの。
 *
 * **ソースは `GET /api/timecard/punches` の 1 本だけ。** かつては
 * `time_punches` (中継が作った打刻) と `hub_measurements` (端末が送った記録) を
 * 画面で union し、秒 + 乗務員名で重複を落としていたが、サーバ側が
 * `hub_measurements` から直接導出するようになったので**重複の元が無くなった**
 * (Refs ippoan/alc-app-s3#134)。乗務員の解決もサーバがやる (カードの付け替えに
 * 引きずられないよう、打刻時点の解決結果が凍結されている)。
 *
 * 打刻と点呼の区別は **`kind` 列**でしかできない — 同じ表に並ぶので
 * (始業点呼 = 始業打刻)。
 */
const historyRows = computed<HistoryRow[]>(() =>
  punches.value
    .map(p => ({
      key: `p:${p.id}`,
      at: p.punched_at,
      employeeName: displayName(p),
      deviceName: p.device_name ?? '-',
      origin: p.kind === 'license' ? ('tenko' as const) : ('punch' as const),
    }))
    // 表示は日付で絞ってあるので、同日内の新しい順に並べれば足りる
    .sort((a, b) => b.at.localeCompare(a.at)),
)

/**
 * 表示名。**未解決のタップは行ごと落とさず、どのカードかを出す** — 落とすと
 * 「かざしたのに履歴に出ない」になり、カードの登録漏れに気付けない。
 */
function displayName(p: TimePunchWithDevice): string {
  if (p.employee_name) return p.employee_name
  if (!p.card_id) return '不明'
  return p.kind === 'license' ? `未登録の免許証 ${p.card_id}` : `未登録カード ${p.card_id}`
}

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
}

watch(subTab, (tab) => {
  if (tab === 'punches') loadPunches()
})

/**
 * 打刻更新の購読 (Refs ippoan/alc-app-s3#134)。**キオスクと同じ composable。**
 * 端末・キオスク・この画面のどこで打たれても、合図を受けて引き直す。
 *
 * 引き直すのは打刻履歴タブを開いているときだけ (カード登録タブでは無駄)。
 * **絞り込みが今日以外でも引き直す** — 条件付きにすると「今日を見ているときだけ
 * 更新される」という説明の要る挙動になり、引き直しは安い。
 */
const { accessToken } = useAuth()
const punchWatch = useTimecardWatch({
  getToken: () => accessToken.value,
  onChange: () => { if (subTab.value === 'punches') void loadPunches() },
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
        v-for="t in ([{ key: 'punches' as const, label: '打刻履歴' }, { key: 'cards' as const, label: 'カード登録' }])"
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
