<script setup lang="ts">
// CoreS3 統合ハブ (alc-app-s3) の測定値ビューア (Refs ippoan/rust-alc-api#592)。
//
// 経路: CoreS3 →(WSS + device JWT)→ cf-alc-recorder →(service binding)→
//       auth-worker /alc-internal-proxy → rust-alc-api `POST /api/hub/measurements`
// で溜まった行を、同じ API の read 側 `GET /api/hub/measurements` から読む。
// admin browser JWT があれば api.ts の request() が same-origin proxy
// (/api/proxy → auth-worker /alc-proxy) 経由にするので、ここは素直に呼ぶだけでよい。
//
// 並びは backend 固定で `created_at DESC`。総件数は返らない (ingest テーブルが
// 伸び続けるため) ので、ページャは has_more と offset だけで組む。
import { listHubMeasurements } from '~/utils/api'
import { HUB_MEASUREMENT_KINDS, type HubMeasurement } from '~/types'

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
/** payload を展開している行の id。JSONB は 1 行が長いので既定は畳んでおく。 */
const expanded = ref<Set<string>>(new Set())

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
  return 'bg-blue-100 text-blue-800'
}

const pageLabel = computed(() => `${offset.value + 1}〜${offset.value + items.value.length} 件目`)

onMounted(load)
</script>

<template>
  <div class="flex flex-col items-center min-h-screen p-4">
    <header class="w-full max-w-5xl text-center py-6">
      <h1 class="text-2xl font-bold text-gray-800">ハブ測定値</h1>
      <p class="text-sm text-gray-500 mt-1">CoreS3 統合ハブから届いた測定データ (新しい順)</p>
    </header>

    <main class="w-full max-w-5xl flex flex-col gap-4">
      <!-- 絞り込み -->
      <div class="bg-white rounded-2xl p-6 shadow-sm">
        <h2 class="text-lg font-semibold text-gray-700 mb-3">絞り込み</h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-sm text-gray-500">デバイスID</span>
            <input
              v-model="deviceId"
              type="text"
              placeholder="すべて"
              class="px-3 py-2 border border-gray-200 rounded-lg text-sm"
              @keyup.enter="search"
            >
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-gray-500">種別</span>
            <select v-model="kind" class="px-3 py-2 border border-gray-200 rounded-lg text-sm">
              <option value="">すべて</option>
              <option v-for="k in HUB_MEASUREMENT_KINDS" :key="k" :value="k">{{ k }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-gray-500">受信日時 (から)</span>
            <input v-model="from" type="datetime-local" class="px-3 py-2 border border-gray-200 rounded-lg text-sm">
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-gray-500">受信日時 (まで)</span>
            <input v-model="to" type="datetime-local" class="px-3 py-2 border border-gray-200 rounded-lg text-sm">
          </label>
        </div>
        <div class="flex gap-2 mt-4">
          <button
            class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
            :disabled="isLoading"
            @click="search"
          >
            検索
          </button>
          <button
            class="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-300 transition-colors disabled:opacity-50"
            :disabled="isLoading"
            @click="reset"
          >
            条件クリア
          </button>
        </div>
      </div>

      <!-- 一覧 -->
      <div class="bg-white rounded-2xl p-6 shadow-sm">
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
                <th class="px-2 py-2 text-left text-gray-500">端末計時</th>
                <th class="px-2 py-2 text-left text-gray-500">デバイスID</th>
                <th class="px-2 py-2 text-left text-gray-500">種別</th>
                <th class="px-2 py-2 text-right text-gray-500">seq</th>
                <th class="px-2 py-2 text-left text-gray-500">内容</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="item in items" :key="item.id">
                <tr class="border-t border-gray-100">
                  <td class="px-2 py-2 text-gray-700 whitespace-nowrap">{{ formatDateTime(item.created_at) }}</td>
                  <td class="px-2 py-2 text-gray-500 whitespace-nowrap">{{ formatDateTime(item.recorded_at) }}</td>
                  <td class="px-2 py-2 font-mono text-gray-700">{{ item.device_id }}</td>
                  <td class="px-2 py-2">
                    <span class="px-2 py-0.5 rounded text-xs font-medium" :class="kindClass(item.kind)">{{ item.kind }}</span>
                  </td>
                  <td class="px-2 py-2 text-right text-gray-500">{{ item.seq }}</td>
                  <td class="px-2 py-2">
                    <button class="text-blue-600 hover:underline text-xs" @click="toggle(item.id)">
                      {{ expanded.has(item.id) ? '閉じる' : 'JSON を表示' }}
                    </button>
                  </td>
                </tr>
                <tr v-if="expanded.has(item.id)" class="bg-gray-50">
                  <td colspan="6" class="px-2 py-2">
                    <pre class="text-xs text-gray-700 overflow-x-auto">{{ formatPayload(item.payload) }}</pre>
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
    </main>

    <footer class="w-full max-w-5xl py-4">
      <div class="flex justify-center gap-4">
        <NuxtLink to="/" class="text-blue-600 hover:underline text-sm">測定画面</NuxtLink>
        <NuxtLink to="/?role=admin" class="text-blue-600 hover:underline text-sm">管理画面</NuxtLink>
      </div>
    </footer>
  </div>
</template>
