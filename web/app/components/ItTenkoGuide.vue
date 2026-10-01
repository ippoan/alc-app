<script setup lang="ts">
// IT点呼 の試験の手順書 (Refs ippoan/alc-app#387)。手順書そのものは `public/it-tenko-guide.html`
// (印刷用の CSS を持つ独立した HTML)。ここは「読む・印刷する」ための枠だけで、API は呼ばない。
// IT点呼 を通常の点呼へ統合するときは、このコンポーネントと HTML をタブごと消す。
const GUIDE_PATH = '/it-tenko-guide.html'

const frame = ref<HTMLIFrameElement | null>(null)

// 手順書だけを印刷する (この画面全体ではなく iframe の中身)。読み込み前などで
// contentWindow が取れないときは何もしない
function printGuide() {
  frame.value?.contentWindow?.print()
}
</script>

<template>
  <div class="space-y-3">
    <p class="text-sm text-gray-700">
      IT点呼 の試験の手順書です (A4 2 枚)。印刷して使ってください。試験用に切り替えた端末の記録は、本番の点呼記録簿には出ません。
    </p>
    <div class="flex items-center gap-4">
      <button
        type="button"
        class="px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
        @click="printGuide"
      >
        印刷する
      </button>
      <a
        :href="GUIDE_PATH"
        target="_blank"
        rel="noopener"
        class="text-sm text-blue-700 underline"
      >別のタブで開く</a>
    </div>
    <iframe
      ref="frame"
      :src="GUIDE_PATH"
      title="IT点呼 試験の手順"
      class="w-full h-[70vh] border border-gray-300 rounded-md bg-white"
    />
  </div>
</template>
