<script setup lang="ts">
/**
 * 指静脈が FP の層でだけ当たったときの「この端末で撮り直す」の提案 (`useVeinRefreshSuggest`)。
 * 任意の提案で、出ていても画面の流れ (ログイン・登録・測定) は止めない。
 */
import type { useVeinRefreshSuggest } from '~/composables/useVeinRefreshSuggest'

defineProps<{
  suggest: ReturnType<typeof useVeinRefreshSuggest>
}>()
</script>

<template>
  <div
    v-if="suggest.target.value !== null"
    data-testid="vein-refresh-suggest"
    class="rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800"
  >
    <p>指静脈の記録がこの端末の置き方と合わなくなっています。この端末で指を撮り直すと安定します</p>
    <p v-if="suggest.added.value" data-testid="vein-refresh-suggest-done" class="mt-2 text-emerald-700">この端末で撮り直しました</p>
    <div v-else class="mt-2 flex gap-2">
      <button
        data-testid="vein-refresh-suggest-accept"
        :disabled="suggest.adding.value || !suggest.available.value"
        class="px-3 py-2 rounded-lg bg-emerald-600 text-white font-medium disabled:opacity-50 hover:bg-emerald-700 transition-colors"
        @click="suggest.accept()"
      >
        {{ suggest.adding.value ? (suggest.notice.value ?? '指を置いてください…') : 'この端末で撮り直す' }}
      </button>
      <button
        data-testid="vein-refresh-suggest-dismiss"
        :disabled="suggest.adding.value"
        class="px-3 py-2 rounded-lg text-amber-800 underline disabled:opacity-50"
        @click="suggest.dismiss()"
      >
        あとで
      </button>
    </div>
    <p v-if="suggest.error.value" data-testid="vein-refresh-suggest-error" class="mt-2 text-red-600">{{ suggest.error.value }}</p>
  </div>
</template>
