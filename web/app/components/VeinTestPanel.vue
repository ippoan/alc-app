<script setup lang="ts">
/**
 * 開発用の端末だけの「指静脈の確認」タブの画面 (Refs ippoan/alc-app#436)。
 *
 * 手順と判定は `useVeinTest` (ロジックは .ts)。ここは表示だけ。血圧測定・キオスクの自動照合は
 * このタブには置かないので、指を置いても画面が遷移しない。
 */
import { VEIN_TEST_ID, useVeinTest } from '~/composables/useVeinTest'

const veinSerial = useVeinSerial()
onMounted(() => veinSerial.connect())

const test = useVeinTest({ request: veinSerial.request })
onUnmounted(() => test.dispose())

const disabledReason = computed<string | null>(() => {
  if (!veinSerial.isSupported) return 'この端末は WebSerial に対応していません'
  if (!veinSerial.isConnected.value) return 'Vein Station (指静脈読み取り端末) が接続されていません'
  return null
})
const locked = computed(() => test.busy.value || disabledReason.value !== null)

const guideText = computed(() => {
  if (test.guide.value === 'place') return '指を置いてください'
  if (test.guide.value === 'release') return '指を離してください'
  return null
})

const BUTTON = 'px-4 py-3 rounded-md text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed'
</script>

<template>
  <div class="p-4 overflow-y-auto">
    <div class="max-w-xl mx-auto space-y-4">
      <p class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        開発用の端末だけの画面です。指静脈の照合を単独で確かめます (モジュールの ID {{ VEIN_TEST_ID }} を使います)
      </p>
      <p v-if="disabledReason" class="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800" data-testid="vein-test-disabled">
        {{ disabledReason }}
      </p>

      <div
        class="rounded-xl border bg-white flex items-center justify-center text-center min-h-32 px-4"
        :class="guideText ? 'border-blue-400' : 'border-gray-200'"
        data-testid="vein-test-guide"
      >
        <span v-if="guideText" class="text-3xl font-bold text-blue-700">{{ guideText }}</span>
        <span v-else-if="test.busy.value" class="text-lg text-gray-600">処理中…</span>
        <span v-else class="text-lg text-gray-400">待機中</span>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <button :class="[BUTTON, 'bg-blue-600 text-white']" :disabled="locked" data-testid="vein-test-enroll" @click="test.enroll()">登録</button>
        <button :class="[BUTTON, 'bg-blue-600 text-white']" :disabled="locked" data-testid="vein-test-verify" @click="test.verify()">照合</button>
        <button :class="[BUTTON, 'border border-gray-300 text-gray-700']" :disabled="locked" data-testid="vein-test-clear" @click="test.clearModule()">消す</button>
        <button :class="[BUTTON, 'border border-gray-300 text-gray-700']" :disabled="test.busy.value" data-testid="vein-test-clear-local" @click="test.clearLocalCopy()">端末の手元の写しを消す</button>
      </div>

      <section class="rounded-lg border bg-white p-4 space-y-2">
        <p class="text-sm text-gray-700" data-testid="vein-test-summary">{{ test.summary.value }}</p>
        <p v-if="test.result.value" class="text-base font-medium" data-testid="vein-test-result">{{ test.result.value.text }}</p>
        <p v-if="test.error.value" class="text-sm text-red-700" data-testid="vein-test-error">{{ test.error.value }}</p>
      </section>

      <section v-if="test.lines.value.length" class="rounded-lg border bg-white p-4">
        <ul class="text-xs font-mono text-gray-600 space-y-0.5" data-testid="vein-test-lines">
          <li v-for="(l, i) in test.lines.value" :key="i" class="break-all">{{ l }}</li>
        </ul>
      </section>
    </div>
  </div>
</template>
