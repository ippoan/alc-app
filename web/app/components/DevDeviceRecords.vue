<script setup lang="ts">
/**
 * dev端末 (開発用の鍵。本番環境でのテスト用) の記録を見る画面 (Refs ippoan/alc-app#387)。
 *
 * dev端末で行った点呼・測定・打刻は本番の記録と分けて持たれ、管理者ログインからは
 * 見えない。**見るのはこの端末の鍵で** — 取得は `api.ts` の規則 (`selectSendToken`) で
 * 端末のトークンに乗るので、返ってくるのは dev の記録だけ。
 *
 * 出すのは index.vue のハンバーガーで、**キオスクの鍵に dev の印がある端末だけ**。
 *
 * 一覧は管理画面と同じ `TenkoSessionMonitor` をそのまま置く (2 つ目の一覧を作らない)。
 * あの部品が叩く口のうち、キオスクの鍵に開いていないのは「再開」
 * (`POST /api/tenko/sessions/{id}/resume`) だけで、押すと 403 がそのまま画面に出る。
 * CSV 出力 (`GET /api/tenko/records/csv`) は dev のキオスクにだけ開いている口。
 */
import { clearDevDeviceMark } from '~/utils/token-selection'

const emit = defineEmits<{
  /** 開発用の印を外した。親はメニューの項目を消し、この画面を閉じる */
  cleared: []
}>()

function clearMark() {
  if (!confirm('この端末の開発用の印を外しますか？')) return
  clearDevDeviceMark('kiosk')
  emit('cleared')
}
</script>

<template>
  <div class="p-4 overflow-y-auto">
    <div class="max-w-6xl mx-auto space-y-4">
      <p class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        この端末は開発用の鍵です。ここで行った点呼・測定・打刻は本番の記録に出ません
      </p>

      <TenkoSessionMonitor />

      <section class="rounded-lg border bg-white p-4 space-y-2">
        <button
          class="px-4 py-2 rounded-md text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-100"
          data-testid="dev-records-clear"
          @click="clearMark"
        >
          この端末の開発用の印を外す
        </button>
        <p class="text-xs text-gray-500">
          開発用の鍵を抜いたあと、この PC を管理者として使い直すための操作です。開発用の鍵が挿さったままなら、次にトークンを取った時点でまた印が立ちます
        </p>
      </section>
    </div>
  </div>
</template>
