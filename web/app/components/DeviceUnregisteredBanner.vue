<script setup lang="ts">
/**
 * 運行者タブの入口に出す「端末未登録」の案内 (Refs #206)。
 *
 * 端末登録 (device JWT) も管理者ログイン (access token) も無いと、`api.ts` の request() は
 * テナント無しの直 fetch に落ちる。すると by-nfc は 404 になり打刻一覧は空になるが、画面には
 * 「乗務員に登録されていません」「本日の打刻はまだありません」としか出ず原因が分からない。
 * 原因をここで 1 か所だけ出す (fallback 自体と各 catch の文言は触らない)。
 */
import { deviceUnregisteredMessage } from '~/utils/employee-lookup-messages'

const { hasKioskAccess } = useKioskAccess()
</script>

<template>
  <div
    v-if="!hasKioskAccess"
    data-testid="device-unregistered-banner"
    class="w-full max-w-lg mx-auto px-4 mt-2"
  >
    <div class="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
      {{ deviceUnregisteredMessage }}。メニュー →「端末登録」で QR を読み取ってください。登録するまで免許証の照合と打刻一覧は動きません。CoreS3 が USB でつながっていれば、下 (または NFC 画面) の「CoreS3 を USB で許可」を押すだけでも動きます
    </div>
  </div>
</template>
