<script setup lang="ts">
import type { ApiEmployee, TimePunchWithDevice } from '~/types'
import { punchTimecard, listTimePunches, getEmployees } from '~/utils/api'
import { jstTodayStartIso } from '~/utils/jst'
import { deviceUnregisteredMessage } from '~/utils/employee-lookup-messages'

const props = defineProps<{
  landscape?: boolean
}>()

const nfc = useNfcWebSocket()
const coreS3 = useCoreS3Serial()
const { accessToken } = useAuth()
const { deviceModel } = useFingerprint()
const KYOCERA_MODELS = ['KC-T305CN', 'KC-305CN', 'KYT35', 'A404KC', 'KC-T306']
const isKyoceraTablet = computed(() => {
  if (!deviceModel.value) return false
  return KYOCERA_MODELS.some(m => deviceModel.value!.includes(m))
})
const showNfcGuide = ref(false)

// CoreS3 の WebSerial 初回許可 (ユーザー操作が要る)。NfcStatus.vue の同名処理を踏襲する
const isRequestingCoreS3Port = ref(false)
async function requestCoreS3Port() {
  isRequestingCoreS3Port.value = true
  try {
    await coreS3.requestPort()
  }
  finally {
    isRequestingCoreS3Port.value = false
  }
}
const employees = ref<ApiEmployee[]>([])
const employeeMap = computed(() => {
  const map: Record<string, string> = {}
  for (const e of employees.value) map[e.id] = e.name
  return map
})

const processing = ref(false)
const errorMsg = ref('')
let errorTimer: ReturnType<typeof setTimeout> | null = null

/** 本日の打刻 (新しい順)。**サーバから引き直したものだけ**を出す。 */
const recentPunches = ref<{ key: string; name: string; time: string }[]>([])
/** 直近に自分で打った行 (数秒だけ強調する)。 */
const highlightedKey = ref<string | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | null = null

const { getDeviceJwt, hasDeviceJwt } = useDeviceToken()

/**
 * CoreS3 経由の自動端末登録 (#213) の失敗理由。成功 / 未実行なら null。
 * 登録の実行自体は app.vue が常時アクティブにしている (ここでは呼ぶ理由が useHubClaim.ts
 * の listener 二重登録ガードに書いてあるとおり、lastError を読むためだけに呼ぶ)。
 */
const { lastError: hubClaimError } = useHubClaim()

/**
 * 打刻更新の購読 (Refs ippoan/alc-app-s3#134)。**管理画面と同じ composable。**
 * 他の端末 (NFC タイムカード端末や別のキオスク) で打たれた打刻も、この画面の
 * 「本日の打刻履歴」に出したいので購読する。トークンはキオスクの device JWT、
 * 管理者がこの画面を開いている場合は browser JWT。**どちらも無ければ**
 * (未ペアリング) WS は張らずポーリングに落ちる — 画面は壊さない。
 */
const watch$ = useTimecardWatch({
  getToken: () => accessToken.value ?? getDeviceJwt(),
  onChange: () => { void loadTodayPunches() },
})

/**
 * NFC 待機表示の 3 状態 (Refs ippoan/alc-app#216)。
 * CoreS3 が USB 直結されていれば最優先 (打刻は CoreS3 firmware 自身が行う)、
 * 次に PC の NFC ブリッジ、どちらも無ければ未接続。
 */
const nfcState = computed(() => coreS3.isConnected.value ? 'core' : nfc.isConnected.value ? 'bridge' : 'none')

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
 * **打刻の応答からは作らない。** 打刻はキオスクも端末も同じ ingest 経路に乗り、
 * 社員の解決 (凍結) はサーバがやるので、画面に出す行はサーバから引いた 1 本に
 * 揃える (Refs ippoan/alc-app-s3#134)。他の端末で打たれた打刻も同じ経路で出る。
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
  }
  catch (e) { console.error('[TimePunchKiosk] Failed to load today punches:', e) }
}

async function loadEmployees() {
  try {
    employees.value = await getEmployees()
  }
  catch (e) { console.error('[TimePunchKiosk] Failed to load employees:', e) }
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

onMounted(async () => {
  updateScreenSize()
  window.addEventListener('resize', updateScreenSize)

  await loadEmployees()
  // 購読が張れれば onopen で 1 回引き直すが、張れない場合もあるのでここでも引く
  await loadTodayPunches()
  void watch$.connect()

  // CoreS3 直結の読み取りは購読しない — 打刻は CoreS3 firmware 自身が `kind=timecard` で
  // 送る (alc-app-s3 hub-drivers/timecard.rs)。ここで useNfcReader() に切り替えると 1 タップが 2 行になる
  nfc.connect()
  nfc.onRead(async (event) => {
    if (processing.value) return
    processing.value = true
    errorMsg.value = ''

    try {
      await punchTimecard(event.employee_id)
      // **応答に打刻行は入らない** (端末の打刻と同じ ingest 経路)。引き直す
      await loadTodayPunches()
      highlightedKey.value = recentPunches.value[0]?.key ?? null
      if (highlightTimer) clearTimeout(highlightTimer)
      highlightTimer = setTimeout(() => { highlightedKey.value = null }, 3000)
    }
    catch (e: any) {
      // 未登録カードでも打刻自体は記録される (履歴に「未登録カード …」で出る)
      // ので、ここに来るのは通信・認証の失敗だけ。
      // **理由ごとに文言を変える** — 実機の前に立った人が次の一手を選べるように
      // (「打刻に失敗しました」だけだと、ペアリング漏れも通信障害も同じ顔になる)
      errorMsg.value = punchFailureMessage(e)
      if (errorTimer) clearTimeout(errorTimer)
      errorTimer = setTimeout(() => { errorMsg.value = '' }, 5000)
    }
    finally {
      processing.value = false
    }
  })
})

onUnmounted(() => {
  window.removeEventListener('resize', updateScreenSize)
  if (errorTimer) clearTimeout(errorTimer)
  if (highlightTimer) clearTimeout(highlightTimer)
})

/**
 * 失敗の文言。**status を握りつぶさない** — 未ペアリング (資格情報が無い) と
 * 通信障害を同じ文言にすると、現地で「ペアリングすれば直る」と分からない。
 */
function punchFailureMessage(e: unknown): string {
  const err = e as { punchFailure?: string, status?: number } | undefined
  if (err?.punchFailure === 'unpaired') return deviceUnregisteredMessage
  if (err?.punchFailure === 'forbidden') return 'この端末では打刻できません (ペアリングの種別を確認してください)'
  return err?.status ? `打刻に失敗しました (${err.status})` : '打刻に失敗しました'
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
</script>

<template>
  <div :class="[
    'w-full flex-1 overflow-y-auto p-4',
    landscape ? 'flex gap-4 max-w-4xl mx-auto' : 'flex flex-col items-center'
  ]">
    <!-- 左列 (横画面) / 上部 (縦画面): ヘッダー + NFC待機 -->
    <div :class="landscape ? 'w-2/5 flex flex-col shrink-0' : 'w-full flex flex-col items-center'">
      <header :class="['w-full text-center', landscape ? 'py-2' : 'max-w-md py-6']">
        <h1 :class="['font-bold text-gray-800', landscape ? 'text-lg' : 'text-2xl']">タイムカード</h1>
      </header>

      <!-- CoreS3 経由の自動端末登録 (#213) の失敗バナー -->
      <div
        v-if="hubClaimError"
        :class="['w-full mb-3 px-4 py-2 bg-red-50 text-red-600 text-sm font-medium rounded-lg text-center', landscape ? '' : 'max-w-md']"
      >
        {{ hubClaimError }}
      </div>

      <!-- NFC 待機カード -->
      <div :class="['w-full bg-white rounded-2xl shadow-sm border p-6 text-center', landscape ? '' : 'max-w-md']">
        <div :class="['mb-3', landscape ? 'text-4xl' : 'text-6xl']">
          <span v-if="processing" class="animate-spin inline-block">⏳</span>
          <span v-else>🪪</span>
        </div>
        <p :class="['text-gray-500', landscape ? 'text-sm' : 'text-base']">ICカードまたは免許証をかざしてください</p>
        <button
          v-if="isKyoceraTablet"
          class="mt-2 px-3 py-1.5 bg-blue-100 text-blue-700 text-xs font-medium rounded-lg hover:bg-blue-200 transition-colors"
          @click="showNfcGuide = true"
        >
          NFC 位置ガイド
        </button>
        <NfcPositionGuide v-model:visible="showNfcGuide" />
        <div class="mt-4 flex items-center justify-center gap-2 text-sm">
          <span
            class="w-2 h-2 rounded-full"
            :class="nfcState !== 'none' ? 'bg-green-500' : 'bg-red-500'"
          />
          <span class="text-gray-500">
            {{ nfcState === 'core' ? 'NFC 端末接続中 (端末が打刻します)'
              : nfcState === 'bridge' ? 'NFC ブリッジ接続中'
                : 'NFC リーダー未接続' }}
          </span>
        </div>
        <!-- CoreS3 未接続時の USB 許可ボタン (#234) -->
        <button
          v-if="coreS3.isSupported && !coreS3.isConnected.value"
          class="mt-3 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors disabled:bg-gray-300"
          :disabled="isRequestingCoreS3Port"
          @click="requestCoreS3Port"
        >
          CoreS3 を USB で許可
        </button>
        <!-- インラインエラー -->
        <div
          v-if="errorMsg"
          class="mt-3 px-4 py-2 bg-red-50 text-red-600 text-sm font-medium rounded-lg"
        >
          {{ errorMsg }}
        </div>
      </div>
    </div>

    <!-- 右列 (横画面) / 下部 (縦画面): 最近の打刻 -->
    <div :class="landscape ? 'flex-1 min-w-0' : 'w-full max-w-md mt-4'">
      <div v-if="recentPunches.length" class="bg-white rounded-2xl shadow-sm border overflow-hidden">
        <div class="px-4 py-3 border-b bg-gray-50">
          <h2 class="text-sm font-medium text-gray-600">本日の打刻履歴</h2>
        </div>
        <div :class="landscape ? 'max-h-[calc(100vh-10rem)] overflow-y-auto' : ''">
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
      <div v-else class="bg-white rounded-2xl shadow-sm border p-8 text-center text-gray-400 text-sm">
        本日の打刻はまだありません
      </div>
    </div>
  </div>
</template>
