<script setup lang="ts">
/**
 * FC-1200 の進み (`Fc1200State`) を 1 行で見せる部品 (Refs ippoan/rust-alc-api#644)。
 *
 * # なぜ部品にしたか
 *
 * **同じ markup が `AlcMeasurement.vue` の中で 2 回複製されていた** — CoreS3 経由
 * (firmware の `EVT FC1200` 由来) と PC 直結 (`useFc1200Serial` 由来) で、
 * 状態の出どころが違うだけで見た目は同一だった。**3 か所目 (本人確認前の測定を
 * 知らせるモーダル) が要るので、複製を増やす前に 1 か所へ寄せる。**
 *
 * 出すのは **ドット + 文言**、そして `blow_waiting` のときだけ **吹きかけプロンプト**。
 * どちらも呼び出し側では隣り合わせに置かれていたので、この部品が両方を持つ。
 *
 * `state` が `null` のときは**何も出さない** (CoreS3 経由が `v-if="coreStateConfig"`
 * でやっていたのと同じ。PC 直結は常に値を持つので挙動は変わらない)。
 */
import type { Fc1200State } from '~/types'

const props = defineProps<{
  /** いまの進み。`null` は「まだ何も分かっていない」= 何も出さない */
  state: Fc1200State | null
}>()

/**
 * 状態 → 文言・文字色・ドットを animate するか。
 *
 * **`AlcMeasurement.vue` から移してきたもの。文言も色も 1 文字も変えていない** —
 * 切り出しで見た目が動いていないことは `AlcMeasurement.test.ts` の
 * 「状態インジケーターの見た目」が両経路ぶん固定している。
 */
function stateConfigFor(s: Fc1200State): { text: string; color: string; animate: boolean } {
  switch (s) {
    case 'idle':
      return { text: 'FC-1200 未接続', color: 'text-gray-500', animate: false }
    case 'waiting_connection':
      return { text: '接続待機中...', color: 'text-yellow-600', animate: true }
    case 'connected':
      return { text: 'デバイス接続済み', color: 'text-blue-600', animate: false }
    case 'warming_up':
      return { text: 'ウォームアップ中...', color: 'text-yellow-600', animate: true }
    case 'blow_waiting':
      return { text: '息を吹きかけてください', color: 'text-blue-700', animate: true }
    case 'measuring':
      return { text: '測定中...', color: 'text-blue-600', animate: true }
    case 'result_received':
      return { text: '測定完了', color: 'text-green-600', animate: false }
    default:
      return { text: '不明な状態', color: 'text-gray-500', animate: false }
  }
}

const config = computed(() => props.state ? stateConfigFor(props.state) : null)
</script>

<template>
  <!-- 状態インジケーター -->
  <div v-if="config" class="flex items-center gap-3">
    <span
      v-if="config.animate"
      class="w-3 h-3 rounded-full bg-blue-500 animate-pulse"
    />
    <span
      v-else
      class="w-3 h-3 rounded-full"
      :class="{
        'bg-green-500': state === 'result_received',
        'bg-gray-400': state === 'idle' || state === 'connected',
      }"
    />
    <span :class="['text-lg font-medium', config.color]">
      {{ config.text }}
    </span>
  </div>

  <!-- 吹きかけプロンプト -->
  <div
    v-if="state === 'blow_waiting'"
    class="bg-blue-50 border-2 border-blue-300 rounded-2xl p-8 text-center w-full"
  >
    <p class="text-blue-800 text-xl font-bold">息を吹きかけてください</p>
    <p class="text-blue-600 text-sm mt-2">FC-1200 のセンサー部に向かって約5秒間</p>
  </div>
</template>
