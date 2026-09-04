<script setup lang="ts">
import type { ApiEmployee } from '~/types'
import { punchTimecard, listTimePunches, getEmployees } from '~/utils/api'
import { jstTodayStartIso } from '~/utils/jst'

const props = defineProps<{
  landscape?: boolean
}>()

const nfc = useNfcWebSocket()
const { deviceId } = useAuth()
const { deviceModel } = useFingerprint()
const KYOCERA_MODELS = ['KC-T305CN', 'KC-305CN', 'KYT35', 'A404KC', 'KC-T306']
const isKyoceraTablet = computed(() => {
  if (!deviceModel.value) return false
  return KYOCERA_MODELS.some(m => deviceModel.value!.includes(m))
})
const showNfcGuide = ref(false)
const employees = ref<ApiEmployee[]>([])
const employeeMap = computed(() => {
  const map: Record<string, string> = {}
  for (const e of employees.value) map[e.id] = e.name
  return map
})

const processing = ref(false)
const errorMsg = ref('')
let errorTimer: ReturnType<typeof setTimeout> | null = null

const recentPunches = ref<{ name: string; time: string; highlighted: boolean }[]>([])

const isLargeScreen = ref(false)
function updateScreenSize() {
  isLargeScreen.value = window.innerWidth >= 1024
}

const displayedPunches = computed(() => {
  const limit = isLargeScreen.value ? 20 : 10
  return recentPunches.value.slice(0, limit)
})

onMounted(async () => {
  updateScreenSize()
  window.addEventListener('resize', updateScreenSize)

  // Fetch employees + today's punches
  try {
    // **「今日」は JST で切る。** サーバ側も JST 固定 (`list_today_punches` の
    // Asia/Tokyo、CSV の +09:00) なので、ブラウザのローカル時刻で切ると
    // JST 以外に設定された端末でサーバと食い違う (Refs ippoan/alc-app-s3#134)
    const todayStart = jstTodayStartIso()
    const [emps, res] = await Promise.all([
      getEmployees(),
      listTimePunches({ date_from: todayStart, per_page: 200 }),
    ])
    employees.value = emps
    recentPunches.value = res.punches.map(p => ({
      // **未登録カードのタップは employee_id が null で来る** (サーバが行ごと
      // 落とさないため)。素で slice すると落ちるので、カードの値を出して
      // 「誰の登録が漏れているか」が分かるようにする
      name: (p.employee_id && employeeMap.value[p.employee_id])
        || p.employee_name
        || (p.card_id ? `未登録カード ${p.card_id}` : '不明'),
      time: formatTime(p.punched_at),
      highlighted: false,
    }))
  }
  catch (e) { console.error('[TimePunchKiosk] Failed to load today punches:', e) }

  nfc.connect()
  nfc.onRead(async (event) => {
    if (processing.value) return
    processing.value = true
    errorMsg.value = ''

    try {
      const cardId = event.employee_id
      const res = await punchTimecard(cardId, deviceId.value)
      const entry = { name: res.employee_name, time: formatTime(res.punch.punched_at), highlighted: true }
      recentPunches.value.unshift(entry)
      setTimeout(() => { entry.highlighted = false }, 3000)
    }
    catch (e: any) {
      if (e?.message?.includes('404') || e?.status === 404) {
        errorMsg.value = 'このカードは登録されていません'
      }
      else {
        errorMsg.value = '打刻に失敗しました'
      }
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
})

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
            :class="nfc.isConnected.value ? 'bg-green-500' : 'bg-red-500'"
          />
          <span class="text-gray-500">
            {{ nfc.isConnected.value ? 'NFC ブリッジ接続中' : 'NFC ブリッジ未接続' }}
          </span>
        </div>
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
                :key="i"
                class="border-b border-gray-100 transition-colors duration-1000"
                :class="p.highlighted
                  ? 'bg-green-100 text-green-800 font-medium'
                  : (i === 0 ? 'bg-blue-50 text-gray-800 font-medium' : 'text-gray-600')"
              >
                <td class="py-2 px-4">{{ p.name }}</td>
                <td
                  class="py-2 px-4 text-right tabular-nums transition-colors duration-1000"
                  :class="p.highlighted ? 'text-green-700' : (i === 0 ? 'text-blue-600' : 'text-gray-400')"
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
