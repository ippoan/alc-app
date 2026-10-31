<script setup lang="ts">
/**
 * IT点呼 の受け画面で、この席の運行管理者を指静脈で登録する入口。
 *
 * **開発用の運行管理者席 (`isDevDevice('manager-device')`) だけ** `TenkoItAdminView` が出す。
 * 本番の席ではこの部品ごと描画しない — 照合データの同期 (`useVeinEmployeeIdentify` の onMounted) も
 * 指の合図での自動照合も、部品を作らなければ走らない。
 *
 * 照合の手順は `RoleAuthGate` と共通の `useVeinEmployeeIdentify` (運行管理者席の鍵)。
 * 特定した人の権限の確認と登録は親の `onEmployee` が行い、失敗の理由はここに出す。
 * 親が同時に 2 つ (上部の枠とモーダル) 出すことがあるので、指の合図で自動照合するのは
 * `idle` が true の 1 つだけ。
 */
import type { ApiEmployee } from '~/types'

const props = defineProps<{
  /** 特定できた人を登録する。登録できなかった理由を返す (`null` なら登録できた) */
  onEmployee: (employee: ApiEmployee) => Promise<string | null>
  /** 指が置かれた合図で照合を始めてよいか */
  idle: boolean
}>()

const vein = useVeinEmployeeIdentify({
  scope: 'manager-device',
  missMessage: '指静脈が一致する人が見つかりません。もう一度置くか、社員番号で登録してください',
  pendingMessage: name => `${name ?? 'この人'}さんの指静脈は未承認です。血圧測定の画面の「未承認の指静脈」から承認してください`,
  onEmployee: emp => props.onEmployee(emp),
  isIdle: () => props.idle && !vein.busy.value,
})
</script>

<template>
  <div v-if="vein.ready.value" class="mt-3" data-testid="it-vein-register">
    <button
      data-testid="it-vein-register-button"
      :disabled="vein.busy.value"
      class="w-full px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg font-medium disabled:opacity-50 hover:bg-emerald-700 transition-colors"
      @click="vein.identify()"
    >
      {{ vein.busy.value ? (vein.again.value ? 'もう一度置いてください…' : '指を置いてください…') : '指静脈で登録' }}
    </button>
    <p v-if="vein.error.value" data-testid="it-vein-register-error" class="mt-2 text-sm text-red-600">{{ vein.error.value }}</p>
  </div>
</template>
