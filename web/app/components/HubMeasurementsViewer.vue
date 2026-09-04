<script setup lang="ts">
// CoreS3 統合ハブ (alc-app-s3) の測定値ビューア (Refs ippoan/rust-alc-api#592)。
// AdminDashboard の「ハブ測定値」タブの中身。
//
// 経路: CoreS3 →(WSS + device JWT)→ cf-alc-recorder →(service binding)→
//       auth-worker /alc-internal-proxy → rust-alc-api `POST /api/hub/measurements`
// で溜まった行を、同じ API の read 側 `GET /api/hub/measurements` から読む。
// admin browser JWT があれば api.ts の request() が same-origin proxy
// (/api/proxy → auth-worker /alc-proxy) 経由にするので、ここは素直に呼ぶだけでよい。
//
// 並びは backend 固定で `created_at DESC`。総件数は返らない (ingest テーブルが
// 伸び続けるため) ので、ページャは has_more と offset だけで組む。
import { getEmployees, listHubMeasurements } from '~/utils/api'
import { HUB_MEASUREMENT_KINDS, type ApiEmployee, type HubMeasurement } from '~/types'

const PAGE_SIZE = 50

const deviceId = ref('')
const kind = ref('')
const from = ref('')
const to = ref('')
const offset = ref(0)

const items = ref<HubMeasurement[]>([])
const hasMore = ref(false)
const isLoading = ref(false)
const error = ref<string | null>(null)
/** payload を展開している行のキー。JSONB は 1 行が長いので既定は畳んでおく。 */
const expanded = ref<Set<string>>(new Set())
/** nfc_id → 乗務員。免許証の測定を「誰の点呼か」に読み替えるためだけに使う。
 * 引けなくても一覧は出す (名前が出ないだけ)。 */
const employeeByNfc = ref<Map<string, ApiEmployee>>(new Map())

/** 1 回の点呼 (同じ session_id) を 1 行に畳んだもの。 */
interface SessionRow {
  key: string
  /** 束ねた測定 (受信が新しい順)。 */
  items: HubMeasurement[]
  /** 行に出す受信日時 / デバイス (束ねた中で一番新しい測定のもの)。
   * ★ template で `items[0]!` と書くと Vue のテンプレート式は TS ではないので
   * 壊れる。畳む側で決めておく。 */
  createdAt: string
  deviceId: string
  /** 免許証の測定。点呼を免許証から始めていなければ null。 */
  license: { nfcId: string, issue: string | null, expiry: string | null } | null
  /** アルコール測定 (吹込不良は result のみで value は信用しない)。 */
  alcohol: { value: number | null, result: string | null } | null
  /** 体温 (℃)。測っていなければ null。 */
  temperature: number | null
}

/** 免許証の payload から nfc_id / 交付 / 有効期限 を取り出す (形が違えば null)。 */
function readLicense(payload: unknown): SessionRow['license'] {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as { nfc_id?: unknown, issue?: unknown, expiry?: unknown }
  if (typeof p.nfc_id !== 'string' || p.nfc_id === '') return null
  return {
    nfcId: p.nfc_id,
    issue: typeof p.issue === 'string' ? p.issue : null,
    expiry: typeof p.expiry === 'string' ? p.expiry : null,
  }
}

/**
 * アルコールの payload から値と判定を取り出す (形が違えば null)。
 * CoreS3 は `{type:"alcohol",value:0.000,unit:"mg/L",result:"normal"|"over"|"error",use_count:N}`
 * を送る。`result:"error"` (吹込不良) のときの value は 0.000 固定で測定値ではない。
 */
function readAlcohol(payload: unknown): SessionRow['alcohol'] {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as { value?: unknown, result?: unknown }
  const value = typeof p.value === 'number' ? p.value : null
  const result = typeof p.result === 'string' ? p.result : null
  if (value === null && result === null) return null
  return { value, result }
}

/** 体温の payload から ℃ を取り出す (形が違えば null)。 */
function readTemperature(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as { value?: unknown }
  return typeof p.value === 'number' ? p.value : null
}

/** `YYYYMMDD` を `YYYY-MM-DD` にする (読めない形はそのまま返す)。 */
function formatLicenseDate(raw: string | null): string {
  if (!raw) return '—'
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})$/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : raw
}

/**
 * 同じ点呼を 1 行に畳む。
 *
 * **`session_id` が無い測定は 1 件で 1 行**にする (点呼外の単発計測と、
 * session_id を送っていなかった頃の行)。まとめてしまうと別々の測定が
 * 同じ点呼に見える。並び順は API の `created_at DESC` をそのまま保つ。
 */
const sessions = computed<SessionRow[]>(() => {
  const rows: SessionRow[] = []
  const byKey = new Map<string, SessionRow>()
  for (const item of items.value) {
    const key = item.session_id ? `s:${item.session_id}` : `i:${item.id}`
    let row = byKey.get(key)
    if (!row) {
      row = {
        key,
        items: [],
        createdAt: item.created_at,
        deviceId: item.device_id,
        license: null,
        alcohol: null,
        temperature: null,
      }
      byKey.set(key, row)
      rows.push(row)
    }
    row.items.push(item)
    // 同じ点呼で複数回測っていれば、一番新しいもの (= 先に来る行) を採る。
    if (item.kind === 'license' && !row.license) row.license = readLicense(item.payload)
    if (item.kind === 'alcohol' && !row.alcohol) row.alcohol = readAlcohol(item.payload)
    if (item.kind === 'temperature' && row.temperature === null) row.temperature = readTemperature(item.payload)
  }
  return rows
})

/** `datetime-local` の値 (ローカル時刻、TZ 無し) を API に渡す ISO 文字列にする。 */
function toIso(local: string): string | undefined {
  if (!local) return undefined
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

async function load() {
  isLoading.value = true
  error.value = null
  try {
    const res = await listHubMeasurements({
      device_id: deviceId.value || undefined,
      kind: kind.value || undefined,
      from: toIso(from.value),
      to: toIso(to.value),
      limit: PAGE_SIZE,
      offset: offset.value,
    })
    items.value = res.items
    hasMore.value = res.has_more
    expanded.value = new Set()
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : '測定値の取得に失敗しました'
    items.value = []
    hasMore.value = false
  }
  finally {
    isLoading.value = false
  }
}

/** 絞り込みを変えたら 1 ページ目から引き直す (offset を残すと空ページが出る)。 */
async function search() {
  offset.value = 0
  await load()
}

async function nextPage() {
  offset.value += PAGE_SIZE
  await load()
}

async function prevPage() {
  offset.value = Math.max(0, offset.value - PAGE_SIZE)
  await load()
}

async function reset() {
  deviceId.value = ''
  kind.value = ''
  from.value = ''
  to.value = ''
  await search()
}

function toggle(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ja-JP')
}

function formatPayload(payload: unknown): string {
  return JSON.stringify(payload, null, 2)
}

/** kind の色分け。alcohol だけ目立たせる (点呼で見る値のため)。 */
function kindClass(k: string): string {
  if (k === 'alcohol') return 'bg-amber-100 text-amber-800'
  if (k === 'fc1200_raw') return 'bg-gray-100 text-gray-600'
  if (k === 'license') return 'bg-green-100 text-green-800'
  return 'bg-blue-100 text-blue-800'
}

/** アルコール判定 (FC-1200 の result) の表示名。未知の値はそのまま出す。 */
function alcoholResultLabel(result: string): string {
  if (result === 'normal') return '正常'
  if (result === 'over') return '超過'
  if (result === 'error') return '測定エラー'
  return result
}

/** アルコール判定の色。正常だけ緑、それ以外 (超過・吹込不良) は赤で目立たせる。 */
function alcoholResultClass(result: string): string {
  return result === 'normal' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
}

/** 免許証の nfc_id で引ける乗務員。引けなければ null (= alc に未登録)。 */
function employeeOf(row: SessionRow): ApiEmployee | null {
  return row.license ? (employeeByNfc.value.get(row.license.nfcId) ?? null) : null
}

// ★ 畳むのは**このページに載っている測定だけ**。点呼がページ境界をまたぐと
// 前後のページに分かれて出る (API は測定単位で offset を切るため)。件数表示に
// 測定と点呼の両方を出して、行数と件数が合わないのを迷わせない。
const pageLabel = computed(
  () => `${offset.value + 1}〜${offset.value + items.value.length} 件目 (${sessions.value.length} 点呼)`,
)

/** 乗務員は一覧を 1 回だけ引いて nfc_id で索く。**失敗しても一覧は出す** —
 * 名前が出ないことと測定が読めないことは別なので、ここでエラーにしない。 */
async function loadEmployees() {
  try {
    const list = await getEmployees()
    const map = new Map<string, ApiEmployee>()
    for (const e of list) {
      if (e.nfc_id) map.set(e.nfc_id, e)
    }
    employeeByNfc.value = map
  }
  catch {
    employeeByNfc.value = new Map()
  }
}

onMounted(() => {
  void loadEmployees()
  void load()
})
</script>

<template>
  <div class="space-y-4">
    <!-- 絞り込み -->
    <div class="bg-white rounded-xl p-4 shadow-sm">
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label class="flex flex-col gap-1">
          <span class="text-sm text-gray-500">デバイスID</span>
          <input
            v-model="deviceId"
            type="text"
            placeholder="すべて"
            class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            @keyup.enter="search"
          >
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-gray-500">種別</span>
          <select
            v-model="kind"
            class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">すべて</option>
            <option v-for="k in HUB_MEASUREMENT_KINDS" :key="k" :value="k">{{ k }}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-gray-500">受信日時 (から)</span>
          <input
            v-model="from"
            type="datetime-local"
            class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-gray-500">受信日時 (まで)</span>
          <input
            v-model="to"
            type="datetime-local"
            class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
        </label>
      </div>
      <div class="flex gap-2 mt-4">
        <button
          class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors disabled:opacity-50"
          :disabled="isLoading"
          @click="search"
        >
          検索
        </button>
        <button
          class="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300 transition-colors disabled:opacity-50"
          :disabled="isLoading"
          @click="reset"
        >
          条件クリア
        </button>
      </div>
    </div>

    <!-- 一覧 -->
    <div class="bg-white rounded-xl p-4 shadow-sm">
      <div v-if="error" class="text-sm text-red-600 mb-3">{{ error }}</div>

      <div v-if="isLoading" class="text-sm text-gray-500 py-8 text-center">読み込み中...</div>

      <div v-else-if="items.length === 0" class="text-sm text-gray-500 py-8 text-center">
        該当する測定値がありません
      </div>

      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-2 py-2 text-left text-gray-500">受信日時</th>
              <th class="px-2 py-2 text-left text-gray-500">デバイスID</th>
              <th class="px-2 py-2 text-left text-gray-500">乗務員</th>
              <th class="px-2 py-2 text-left text-gray-500">免許 有効期限</th>
              <th class="px-2 py-2 text-left text-gray-500">アルコール</th>
              <th class="px-2 py-2 text-left text-gray-500">体温</th>
              <th class="px-2 py-2 text-left text-gray-500">種別</th>
              <th class="px-2 py-2 text-left text-gray-500">内容</th>
            </tr>
          </thead>
          <tbody>
            <!-- 1 行 = 1 点呼 (同じ session_id)。session_id が無い測定は 1 件で 1 行。 -->
            <template v-for="row in sessions" :key="row.key">
              <tr class="border-t border-gray-100">
                <td class="px-2 py-2 text-gray-700 whitespace-nowrap">{{ formatDateTime(row.createdAt) }}</td>
                <td class="px-2 py-2 font-mono text-gray-700">{{ row.deviceId }}</td>
                <td class="px-2 py-2 whitespace-nowrap">
                  <span v-if="!row.license" class="text-gray-400">—</span>
                  <span v-else-if="employeeOf(row)" class="text-gray-700">
                    {{ employeeOf(row)?.name }}
                    <span class="text-gray-400 text-xs">({{ employeeOf(row)?.code || '社員番号なし' }})</span>
                  </span>
                  <span v-else class="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">未登録</span>
                </td>
                <td class="px-2 py-2 whitespace-nowrap text-gray-700">
                  <template v-if="row.license">
                    {{ formatLicenseDate(row.license.expiry) }}
                    <span class="text-gray-400 text-xs">交付 {{ formatLicenseDate(row.license.issue) }}</span>
                  </template>
                  <span v-else class="text-gray-400">—</span>
                </td>
                <td class="px-2 py-2 whitespace-nowrap">
                  <template v-if="row.alcohol">
                    <!-- 吹込不良 (result="error") の value は 0.000 固定なので測定値として出さない -->
                    <span v-if="row.alcohol.value != null && row.alcohol.result !== 'error'" class="text-gray-700">
                      {{ row.alcohol.value.toFixed(3) }} mg/L
                    </span>
                    <span
                      v-if="row.alcohol.result"
                      class="ml-1 px-2 py-0.5 rounded text-xs font-medium"
                      :class="alcoholResultClass(row.alcohol.result)"
                    >{{ alcoholResultLabel(row.alcohol.result) }}</span>
                  </template>
                  <span v-else class="text-gray-400">—</span>
                </td>
                <td class="px-2 py-2 whitespace-nowrap text-gray-700">
                  <template v-if="row.temperature !== null">{{ row.temperature.toFixed(1) }} &#8451;</template>
                  <span v-else class="text-gray-400">—</span>
                </td>
                <td class="px-2 py-2">
                  <span
                    v-for="item in row.items"
                    :key="item.id"
                    class="px-2 py-0.5 mr-1 rounded text-xs font-medium"
                    :class="kindClass(item.kind)"
                  >{{ item.kind }}</span>
                </td>
                <td class="px-2 py-2">
                  <button class="text-blue-600 hover:underline text-xs" @click="toggle(row.key)">
                    {{ expanded.has(row.key) ? '閉じる' : `JSON を表示 (${row.items.length})` }}
                  </button>
                </td>
              </tr>
              <tr v-if="expanded.has(row.key)" class="bg-gray-50">
                <td colspan="8" class="px-2 py-2">
                  <div v-for="item in row.items" :key="item.id" class="mb-2 last:mb-0">
                    <div class="text-xs text-gray-500">
                      {{ item.kind }} / seq {{ item.seq }} / 端末計時 {{ formatDateTime(item.recorded_at) }}
                    </div>
                    <pre class="text-xs text-gray-700 overflow-x-auto">{{ formatPayload(item.payload) }}</pre>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <!-- ページャ: 総件数は API が返さないので has_more と offset だけで組む -->
      <div v-if="items.length > 0" class="flex items-center justify-between mt-4">
        <span class="text-sm text-gray-500">{{ pageLabel }}</span>
        <div class="flex gap-2">
          <button
            class="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300 disabled:opacity-50"
            :disabled="offset === 0 || isLoading"
            @click="prevPage"
          >
            前へ
          </button>
          <button
            class="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300 disabled:opacity-50"
            :disabled="!hasMore || isLoading"
            @click="nextPage"
          >
            次へ
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
