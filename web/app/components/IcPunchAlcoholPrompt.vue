<script setup lang="ts">
/**
 * IC カードの打刻から アルコールチェックへ進む導線 (Refs ippoan/rust-alc-api#644)。
 *
 * **免許証と IC カードでは経路が違う。** 免許証はタブレットの NFC が読むので
 * `NormalMeasurement` の `onNfcRead` が走り、そのまま「操作を選んでください」の段
 * (choice) へ入れる。IC カードはハブ端末 (CoreS3) にかざされ、**サーバ側で打刻が
 * 記録される** — タブレットは `useTimecardWatch` の合図で一覧を引き直して初めて
 * 「誰がかざしたか」を知る。そのままではアルコールチェックへ進む口が無いので、
 * **最新の打刻が IC カードなら、その人ぶんのボタンを 1 つだけ出す**。
 *
 * **`NormalMeasurement` の状態機械の中には置かない。** 中に入れると
 * `onNfcRead` の「測定中のタップで段が巻き戻らない」ガード
 * (Refs ippoan/alc-app-s3#135) と隣り合わせになる。ここは表示の判定だけを持ち、
 * 測定の開始は `@start` を受けた呼び出し元が `NormalMeasurement` に頼む。
 *
 * **`active` を emit する。** ボタンを出しているかどうかを呼び出し元 (`NfcStatus`) へ
 * 伝え、出している間は NFC タッチ枠のアイコン/案内文をこのボタンに差し替えてもらう
 * (見ている場所にボタンを出す。Refs ippoan/rust-alc-api#644)。
 *
 * # 出さない条件 (どれも「別人の名前で測定に入る」事故を防ぐため)
 *
 * - **免許証 (`'license'`) と種別不明 (`'unknown'`)** — 免許証は従来どおり
 *   タッチで choice へ入る。`'unknown'` はブラウザ打刻や古い行で、誰の操作か
 *   確証が無い
 * - **社員が解決できていない行** (未登録カード) — 測定を始めようがない
 * - **打刻から 60 秒より古い** — 立ち去った人のボタンを次の人が押してしまう
 * - **通常点呼が待機中でない** (測定中) — 途中の段に別人のボタンを出さない
 * - **押した後** / **次の打刻が来た後** — 同じボタンを 2 度使わせない。次の打刻が
 *   来ればその人のボタンに置き換わる (免許証の打刻なら何も出なくなる)
 */
import type { LatestPunch } from '~/types'

/** ボタンを出しておく時間。これを過ぎたら黙って消える */
const FRESH_WINDOW_MS = 60_000

const props = defineProps<{
  /** 打刻一覧の最新行。引き直すたびに差し替わる (null = まだ 1 件も無い) */
  punch: LatestPunch | null
  /** 通常点呼が待機中 (`step === 'nfc'`) か。測定中は出さない */
  idle: boolean
}>()

const emit = defineEmits<{ start: [LatestPunch]; active: [boolean] }>()

/** 鮮度切れ。**打刻ごとに測り直す** (一覧の引き直しでは測り直さない) */
const expired = ref(false)
/** 測定を始めたぶんの打刻 ID。同じ行でもう一度出さない */
const startedId = ref<string | null>(null)
let expireTimer: ReturnType<typeof setTimeout> | null = null

function clearExpireTimer() {
  if (expireTimer === null) return
  clearTimeout(expireTimer)
  expireTimer = null
}

// **最新行の ID が変わったときだけ測り直す。** 一覧は WS の合図とポーリングで
// 何度も引き直されるので、引き直しのたびに測り直すと 60 秒が伸び続ける
watch(() => props.punch?.id ?? null, () => {
  clearExpireTimer()
  expired.value = false
  if (!props.punch) return
  const remain = FRESH_WINDOW_MS - (Date.now() - new Date(props.punch.punchedAt).getTime())
  // `remain > 0` で書くのは NaN (時刻が読めない行) もここで落とすため
  if (!(remain > 0)) {
    expired.value = true
    return
  }
  expireTimer = setTimeout(() => { expired.value = true }, remain)
}, { immediate: true })

onUnmounted(clearExpireTimer)

/** ボタンを出す相手 (null = 出さない) */
const target = computed<LatestPunch | null>(() => {
  const p = props.punch
  if (!p || !props.idle || expired.value) return null
  if (p.id === startedId.value) return null
  if (p.cardKind !== 'other' || !p.employeeId) return null
  return p
})

// ボタンを出しているかどうかを親へ伝える。判定は上の `target` だけを見る (2本目を作らない)
watch(target, (t) => { emit('active', t !== null) }, { immediate: true })

function start() {
  const p = target.value
  if (!p) return
  startedId.value = p.id
  emit('start', p)
}
</script>

<template>
  <div v-if="target">
    <button
      data-testid="ic-punch-alcohol"
      class="w-full px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
      @click="start"
    >
      {{ target.name }}さんのアルコールチェックへ
    </button>
  </div>
</template>
