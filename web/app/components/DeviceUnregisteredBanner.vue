<script setup lang="ts">
/**
 * 運行者タブの入口に出す「端末未登録」の案内 (Refs #206 → #234 → #238 → ippoan/alc-app-s3#135)。
 *
 * 端末登録 (device JWT) も管理者ログイン (access token) も無いと、`api.ts` の request() は
 * テナント無しの直 fetch に落ちる。すると by-nfc は 404 になり打刻一覧は空になるが、画面には
 * 「乗務員に登録されていません」「本日の打刻はまだありません」としか出ず原因が分からない。
 * 原因をここで 1 か所だけ出す (fallback 自体と各 catch の文言は触らない)。
 *
 * 起動直後の CoreS3 探索中 (`isCheckingKioskAccess`) は出さない — 最大 3 秒で解決するのに
 * 「未登録」を出してしまうと、運行管理者の PC (ログイン無し共用 PC) で毎回この帯が一瞬
 * 出ては消えることになる (#238)。管理者ログイン (/login) へは誘導しない — 運行者を
 * /login に誘導しない決定 (#238) のため。
 *
 * #135: 帯が消えないとき、3 条件のどれが欠けているか・署名がどの段で落ちたかが現地で読めなかった。
 * 現地の人がそのまま読み上げられる 1 行を足す (トークン・device_id は出さない)。詳細はコンソールへ。
 *
 * #135 続報: 案内が常に同じ (「USB でつなげ」中心) で、実際の対処 (鍵の登録) が末尾の 1 文に
 * 埋もれていた (実測 2026-09-16: USB も NFC も生きていたのに、原因は端末の鍵の未登録だった)。
 * 段 (lastFailureStage) と理由の語 (lastFailureDetail) の組み合わせで「いま何をすればよいか」を
 * `actionGuidance` に 1 つだけ出す。対応表は `guidanceForStage()` に寄せる。待ちの最中
 * (backoff) は直前の原因の案内を消さず「あと N 秒で再試行します」を添えるだけ。
 */
import { deviceUnregisteredMessage } from '~/utils/employee-lookup-messages'
import type { DeviceTokenFailureStage } from '~/composables/useDeviceToken'

const { hasKioskAccess, isCheckingKioskAccess, reasons } = useKioskAccess()
const { lastFailureStage, lastFailureStatus, lastFailureDetail, coreS3BackoffUntil } = useDeviceToken()

/** 段の日本語 (電話で読み上げる想定なので短くする) */
const STAGE_LABELS: Record<DeviceTokenFailureStage, string> = {
  'no-core-s3': 'CoreS3 未接続',
  'nonce': '準備',
  'coreS3-sign': 'CoreS3 の署名',
  'token-exchange': '交換',
}

const signStatusText = computed(() => {
  const stage = lastFailureStage.value
  if (!stage) return 'まだ'
  const status = lastFailureStatus.value
  return status === null ? `失敗 (${STAGE_LABELS[stage]})` : `失敗 (${STAGE_LABELS[stage]} ${status})`
})

/** 例:「ログイン: なし / 端末の有効化: なし / 端末の署名: 失敗 (交換 401)」 */
const diagnosticLine = computed(() =>
  `ログイン: ${reasons.value.isAuthenticated ? 'あり' : 'なし'}`
  + ` / 端末の有効化: ${reasons.value.isDeviceActivated ? 'あり' : 'なし'}`
  + ` / 端末の署名: ${signStatusText.value}`,
)

/** firmware が `ERR AUTH: no key` を返したときの lastFailureDetail (useDeviceToken 側で抽出済み) */
const NO_KEY_DETAIL = 'no key'

/**
 * 段 + 理由の語 → 「いま何をすればよいか」の 1〜2 文 (Refs ippoan/alc-app-s3#135 続報)。
 * 文言の対応表はここ 1 箇所にまとめる。専門語 (nonce・トークン・署名) はできるだけ避ける。
 */
function guidanceForStage(stage: DeviceTokenFailureStage | null, detail: string | null): string {
  switch (stage) {
    case 'coreS3-sign':
      return detail === NO_KEY_DETAIL
        ? 'この端末には鍵が登録されていません。管理者が登録画面で鍵を登録してください'
        : '端末が署名に応じません。USB を挿し直すか、端末を再起動してください'
    case 'nonce':
      return 'サーバに繋がりません。ネットワークを確認してください'
    case 'token-exchange':
      return '登録された鍵がサーバ側で確認できません。鍵を登録し直してください'
    case 'no-core-s3':
    default:
      // 段がまだ無い (未試行) 場合も、CoreS3 未接続と同じ案内を出す (最初に確かめてほしいことなので)
      return 'CoreS3 を USB でつないでください。Chrome が許可していなければ「CoreS3 を USB で許可」を押してください'
  }
}

// 抑止中の「あと N 秒」をその場で更新するための現在時刻 (1 秒ごと)。
// 抑止していないとき (通常時) は何も動かさない ― 帯が出ている間だけ意味を持つ。
const nowMs = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  tickTimer = setInterval(() => { nowMs.value = Date.now() }, 1000)
})
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})

/** 「いま何をすればよいか」。待ちの最中は直前の原因の案内を残したまま残り秒を添える */
const actionGuidance = computed(() => {
  const base = guidanceForStage(lastFailureStage.value, lastFailureDetail.value)
  if (!lastFailureStage.value) return base
  const remainMs = coreS3BackoffUntil.value - nowMs.value
  if (remainMs <= 0) return base
  return `${base} あと ${Math.ceil(remainMs / 1000)} 秒で再試行します`
})
</script>

<template>
  <div
    v-if="!hasKioskAccess && !isCheckingKioskAccess"
    data-testid="device-unregistered-banner"
    class="w-full max-w-lg mx-auto px-4 mt-2"
  >
    <div class="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
      {{ deviceUnregisteredMessage }}。<span data-testid="device-unregistered-guidance">{{ actionGuidance }}</span>
      <div data-testid="device-unregistered-diagnostics" class="mt-2 text-xs">
        {{ diagnosticLine }}
      </div>
      <div class="mt-1 text-xs">
        詳しくはブラウザのコンソール (F12 → Console) を見てください
      </div>
    </div>
  </div>
</template>
