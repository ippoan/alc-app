<script setup lang="ts">
/**
 * 「本日の打刻履歴」(名前と時刻の一覧)。
 *
 * **TimePunchKiosk.vue (タイムカード画面) から切り出した部品**
 * (Refs ippoan/alc-app#238)。通常点呼の画面 (index.vue, PC のときだけ) でも
 * 同じ表示を使うため、取得・購読・表示を 1 箇所にまとめる。
 * `useTimecardWatch` のコメントが 2 実装目を禁じているのと同じ理由で、
 * この一覧も 2 実装目を作らない。
 */
import type { ApiEmployee, TimePunchWithDevice } from '~/types'
import { listTimePunches, getEmployees } from '~/utils/api'
import { jstTodayStartIso } from '~/utils/jst'

const { accessToken } = useAuth()
const { getDeviceJwt, hasDeviceJwt } = useDeviceToken()

const employees = ref<ApiEmployee[]>([])
const employeeMap = computed(() => {
  const map: Record<string, string> = {}
  for (const e of employees.value) map[e.id] = e.name
  return map
})

/** 本日の打刻 (新しい順)。**サーバから引き直したものだけ**を出す。 */
const recentPunches = ref<{ key: string; name: string; time: string }[]>([])
/**
 * 取得が 1 度でも成功したか。**「本日の打刻はまだありません」は取得成功で
 * 0 件のときだけ**出す (Refs ippoan/alc-app#238)。端末 JWT がまだ無い/取得に
 * 失敗した間の空を「まだありません」と見せると、実際は打刻があるのに
 * 「無い」と誤解させる — その間は「読み込み中…」のままにする
 */
const hasLoadedOnce = ref(false)
/** 直近に自分で打った行 (数秒だけ強調する)。 */
const highlightedKey = ref<string | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | null = null

const isLargeScreen = ref(false)
function updateScreenSize() {
  isLargeScreen.value = window.innerWidth >= 1024
}

const displayedPunches = computed(() => {
  const limit = isLargeScreen.value ? 20 : 10
  return recentPunches.value.slice(0, limit)
})

/**
 * 表示名。**未解決のタップは行ごと落とさず、どのカードかを出す** — 落とすと
 * 「かざしたのに履歴に出ない」になり、カードの登録漏れに気付けない。
 */
function displayName(p: TimePunchWithDevice): string {
  return (p.employee_id && employeeMap.value[p.employee_id])
    || p.employee_name
    || (p.card_id ? `未登録カード ${p.card_id}` : '不明')
}

/**
 * 本日の打刻を引き直す。
 *
 * **打刻の応答からは作らない。** 打刻はどの画面 (タイムカード / 通常点呼) から
 * 打ってもサーバの同じ ingest 経路に乗り、社員の解決 (凍結) はサーバがやるので、
 * 画面に出す行はサーバから引いた 1 本に揃える (Refs ippoan/alc-app-s3#134)。
 * 他の端末で打たれた打刻も同じ経路で出る。
 *
 * **「今日」は JST で切る。** サーバ側も JST 固定 (`list_today_punches` の
 * Asia/Tokyo、CSV の +09:00) なので、ブラウザのローカル時刻で切ると
 * JST 以外に設定された端末でサーバと食い違う。
 */
async function loadTodayPunches() {
  try {
    const res = await listTimePunches({ date_from: jstTodayStartIso(), per_page: 200 })
    recentPunches.value = res.punches.map(p => ({
      key: p.id,
      name: displayName(p),
      time: formatTime(p.punched_at),
    }))
    hasLoadedOnce.value = true
  }
  catch (e) { console.error('[TodayPunchHistory] Failed to load today punches:', e) }
}

async function loadEmployees() {
  try {
    employees.value = await getEmployees()
  }
  catch (e) { console.error('[TodayPunchHistory] Failed to load employees:', e) }
}

/**
 * 端末 JWT が取れたら一覧を引き直す (Refs ippoan/alc-app#238)。起動時は CoreS3 を
 * 最大 3 秒待つが、初回の open で CoreS3 がリセットされると claim がそれを超えることがあり、
 * そのとき最初の一覧は JWT 無しで取りに行って空のまま残るため
 */
watch(hasDeviceJwt, (has) => {
  if (!has) return
  void loadEmployees()
  void loadTodayPunches()
})

/**
 * 打刻更新の購読 (Refs ippoan/alc-app-s3#134)。**管理画面と同じ composable。**
 * 他の端末 (NFC タイムカード端末や別のキオスク) で打たれた打刻も、この一覧に
 * 出したいので購読する。トークンは呼び出し元の device JWT、管理者がログイン
 * していれば browser JWT。**どちらも無ければ**(未ペアリング) WS は張らず
 * ポーリングに落ちる — 画面は壊さない。
 */
const watch$ = useTimecardWatch({
  getToken: () => accessToken.value ?? getDeviceJwt(),
  onChange: () => { void loadTodayPunches() },
})

onMounted(async () => {
  updateScreenSize()
  window.addEventListener('resize', updateScreenSize)

  await loadEmployees()
  // 購読が張れれば onopen で 1 回引き直すが、張れない場合もあるのでここでも引く
  await loadTodayPunches()
  void watch$.connect()
})

onUnmounted(() => {
  window.removeEventListener('resize', updateScreenSize)
  if (highlightTimer) clearTimeout(highlightTimer)
  // useTimecardWatch 自身も onUnmounted で stop() するが (べき等なのでここで呼んでも害は無い)、
  // 購読を明示的に止めたことがこの部品のテストからも見えるようにここでも呼ぶ
  watch$.stop()
})

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** 指定した key の行を数秒だけ強調する。`null` を渡すと即座に消す。 */
function highlight(key: string | null) {
  highlightedKey.value = key
  if (highlightTimer) clearTimeout(highlightTimer)
  if (key !== null) {
    highlightTimer = setTimeout(() => { highlightedKey.value = null }, 3000)
  }
}

/**
 * 打刻直後に呼び出し元 (TimePunchKiosk / 通常点呼) から呼ぶ。
 * 引き直してから先頭行 (今打ったはずの行) を数秒だけ強調する。
 */
async function reload() {
  await loadTodayPunches()
  highlight(recentPunches.value[0]?.key ?? null)
}

defineExpose({ reload, highlight })
</script>

<template>
  <div v-if="recentPunches.length" class="bg-white rounded-2xl shadow-sm border overflow-hidden">
    <div class="px-4 py-3 border-b bg-gray-50">
      <h2 class="text-sm font-medium text-gray-600">本日の打刻履歴</h2>
    </div>
    <div class="max-h-[calc(100vh-10rem)] overflow-y-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-gray-200 text-gray-400">
            <th class="text-left py-2 px-4 font-medium">名前</th>
            <th class="text-right py-2 px-4 font-medium">時刻</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(p, i) in displayedPunches"
            :key="p.key"
            class="border-b border-gray-100 transition-colors duration-1000"
            :class="p.key === highlightedKey
              ? 'bg-green-100 text-green-800 font-medium'
              : (i === 0 ? 'bg-blue-50 text-gray-800 font-medium' : 'text-gray-600')"
          >
            <td class="py-2 px-4">{{ p.name }}</td>
            <td
              class="py-2 px-4 text-right tabular-nums transition-colors duration-1000"
              :class="p.key === highlightedKey ? 'text-green-700' : (i === 0 ? 'text-blue-600' : 'text-gray-400')"
            >
              {{ p.time }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
  <div v-else-if="!hasLoadedOnce" class="bg-white rounded-2xl shadow-sm border p-8 text-center text-gray-400 text-sm">
    読み込み中…
  </div>
  <div v-else class="bg-white rounded-2xl shadow-sm border p-8 text-center text-gray-400 text-sm">
    本日の打刻はまだありません
  </div>
</template>
