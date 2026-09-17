<script setup lang="ts">
/**
 * 本人確認の前 (待機画面 / 種別の選択画面) に届いたアルコール測定を知らせる
 * モーダル (Refs ippoan/rust-alc-api#644)。
 *
 * **測定を保存・紐付けはしない。** CoreS3 ハブ側が既に保存している
 * (`hub_measurements` に `session_id: null` で入る) ので、タブレットは
 * 「測りましたよ」と知らせるだけ。この記録は点呼ではないので、
 * 点呼の集計・一覧には一切混ざらない。
 *
 * # 出す条件
 *
 * 届いたその瞬間の段が `nfc` (待機画面) か `choice` (打刻直後・種別の選択画面)
 * のときだけ。`measuring` で届いた値は点呼の測定そのものであり `AlcMeasurement`
 * が扱う (= 前の運転者の残留値とも自動的に区別される)。
 *
 * # 消える条件 (3 つとも close() を通る)
 *
 * - 「閉じる」/ 背景のタップ
 * - 60 秒 (AUTO_CLOSE_MS。IcPunchAlcoholPrompt の FRESH_WINDOW_MS と同値)
 * - 段が動いた (nfc → choice、choice → medical 等)
 *
 * `NormalMeasurement` の状態機械 (段の代入) には一切触らない。
 */
import type { StrayAlcoholReading, NormalMeasurementStep } from '~/types'
import { alcoholResultLabel, alcoholResultClass } from '~/utils/alcohol'

/** 出しておく時間。これを過ぎたら黙って消える (IcPunchAlcoholPrompt と同値) */
const AUTO_CLOSE_MS = 60_000

const props = defineProps<{
  /** 直近に届いた本人確認前のアルコール測定 (null = まだ 1 件も無い) */
  reading: StrayAlcoholReading | null
  /** NormalMeasurement の今の段 */
  step: NormalMeasurementStep
}>()

const shown = ref(false)
let closeTimer: ReturnType<typeof setTimeout> | null = null

function clearCloseTimer() {
  if (closeTimer === null) return
  clearTimeout(closeTimer)
  closeTimer = null
}

function close() {
  clearCloseTimer()
  shown.value = false
}

// 新しい測定が届くたびに一度評価する。前の測定が表示中でも close() で必ず畳む
// (張る場所 1 か所・消す場所 1 か所・閉じる道 1 本)。
watch(() => props.reading?.seq, (seq) => {
  close()
  if (seq === undefined) return
  if (props.step !== 'nfc' && props.step !== 'choice') return
  shown.value = true
  closeTimer = setTimeout(close, AUTO_CLOSE_MS)
}, { immediate: true })

// 段が動いたら消す (nfc → choice、choice → medical 等)
watch(() => props.step, close)

onUnmounted(clearCloseTimer)

const measuredAtLabel = computed(() => {
  const d = props.reading?.measuredAt
  if (!d) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})
</script>

<template>
  <div
    v-if="shown && reading"
    data-testid="stray-alcohol-modal"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    @click.self="close"
  >
    <div class="bg-white rounded-2xl shadow-xl p-8 text-center max-w-sm">
      <h3 class="text-lg font-semibold text-gray-800 mb-1">
        アルコールチェッカーが測定しました
      </h3>
      <p class="text-sm text-gray-500 mb-4">本人確認なしの測定です</p>
      <div class="mb-2">
        <span
          v-if="reading.result !== 'error'"
          data-testid="stray-alcohol-modal-value"
          class="text-2xl font-bold text-gray-800"
        >{{ reading.value.toFixed(3) }} mg/L</span>
        <span
          data-testid="stray-alcohol-modal-result"
          class="ml-2 px-2 py-0.5 rounded text-xs font-medium"
          :class="alcoholResultClass(reading.result)"
        >{{ alcoholResultLabel(reading.result) }}</span>
      </div>
      <p class="text-xs text-gray-500 mb-4">
        {{ measuredAtLabel }} に記録しました — この記録は点呼には含まれません
      </p>
      <button
        data-testid="stray-alcohol-modal-close"
        class="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300"
        @click="close"
      >
        閉じる
      </button>
    </div>
  </div>
</template>
