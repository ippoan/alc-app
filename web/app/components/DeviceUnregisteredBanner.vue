<script setup lang="ts">
/**
 * 運行者タブの入口に出す「端末未登録」の案内 (Refs #206 → #234 → #238)。
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
 */
import { deviceUnregisteredMessage } from '~/utils/employee-lookup-messages'

const { hasKioskAccess, isCheckingKioskAccess } = useKioskAccess()
</script>

<template>
  <div
    v-if="!hasKioskAccess && !isCheckingKioskAccess"
    data-testid="device-unregistered-banner"
    class="w-full max-w-lg mx-auto px-4 mt-2"
  >
    <div class="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
      {{ deviceUnregisteredMessage }}。CoreS3 を USB でつなぐと自動で使えるようになります。Chrome が CoreS3 をまだ許可していなければ「CoreS3 を USB で許可」を押してください。初めて使う CoreS3 は、管理者が登録画面で鍵を登録してください
    </div>
  </div>
</template>
