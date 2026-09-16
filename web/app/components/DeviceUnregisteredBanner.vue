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
 */
import { deviceUnregisteredMessage } from '~/utils/employee-lookup-messages'
import type { DeviceTokenFailureStage } from '~/composables/useDeviceToken'

const { hasKioskAccess, isCheckingKioskAccess, reasons } = useKioskAccess()
const { lastFailureStage, lastFailureStatus } = useDeviceToken()

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
</script>

<template>
  <div
    v-if="!hasKioskAccess && !isCheckingKioskAccess"
    data-testid="device-unregistered-banner"
    class="w-full max-w-lg mx-auto px-4 mt-2"
  >
    <div class="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
      {{ deviceUnregisteredMessage }}。CoreS3 を USB でつなぐと自動で使えるようになります。Chrome が CoreS3 をまだ許可していなければ「CoreS3 を USB で許可」を押してください。初めて使う CoreS3 は、管理者が登録画面で鍵を登録してください
      <div data-testid="device-unregistered-diagnostics" class="mt-2 text-xs">
        {{ diagnosticLine }}
      </div>
      <div class="mt-1 text-xs">
        詳しくはブラウザのコンソール (F12 → Console) を見てください
      </div>
    </div>
  </div>
</template>
