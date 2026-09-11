<script setup lang="ts">
import { punchTimecard } from '~/utils/api'
import { deviceUnregisteredMessage } from '~/utils/employee-lookup-messages'
import TodayPunchHistory from './TodayPunchHistory.vue'

const props = defineProps<{
  landscape?: boolean
}>()

const nfc = useNfcWebSocket()
const coreS3 = useCoreS3Serial()
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

const processing = ref(false)
const errorMsg = ref('')
let errorTimer: ReturnType<typeof setTimeout> | null = null

/** 「本日の打刻履歴」部品への参照。打刻直後に reload() で引き直す (Refs ippoan/alc-app#238)。 */
const punchHistory = ref<InstanceType<typeof TodayPunchHistory> | null>(null)

/**
 * CoreS3 経由の自動端末登録 (#213) の失敗理由。成功 / 未実行なら null。
 * 登録の実行自体は app.vue が常時アクティブにしている (ここでは呼ぶ理由が useHubClaim.ts
 * の listener 二重登録ガードに書いてあるとおり、lastError を読むためだけに呼ぶ)。
 */
const { lastError: hubClaimError } = useHubClaim()

/**
 * NFC 待機表示の 3 状態 (Refs ippoan/alc-app#216)。
 * CoreS3 が USB 直結されていれば最優先 (打刻は CoreS3 firmware 自身が行う)、
 * 次に PC の NFC ブリッジ、どちらも無ければ未接続。
 */
const nfcState = computed(() => coreS3.isConnected.value ? 'core' : nfc.isConnected.value ? 'bridge' : 'none')

onMounted(async () => {
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
      await punchHistory.value?.reload()
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
  if (errorTimer) clearTimeout(errorTimer)
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
    <TodayPunchHistory
      ref="punchHistory"
      :class="landscape ? 'flex-1 min-w-0' : 'w-full max-w-md mt-4'"
    />
  </div>
</template>
