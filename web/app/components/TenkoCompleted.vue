<script setup lang="ts">
import type { TenkoSession } from '~/types'
import { tenkoTypeLabel } from '~/utils/tenko-type'

const props = defineProps<{
  session: TenkoSession
  employeeName: string
  /** 次の点呼へ自動で移るまでの残り秒数 (遠隔点呼が判定で閉じた後と、判定待ち)。数えていなければ null / 省略 */
  autoResetSeconds?: number | null
}>()

const emit = defineEmits<{
  reset: []
}>()

/**
 * 運行管理者が判定する理由。自動点呼から切り替えたときはその理由 (血圧計の故障・血圧の記録が足りない など)、
 * 最初から遠隔点呼で始めたときは「遠隔点呼で受けた点呼」
 */
const judgmentReason = computed(() => props.session.remote_escalation_reason?.trim() || '遠隔点呼で受けた点呼')

function formatTime(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="flex flex-col items-center gap-4">
    <!-- 完了アイコン -->
    <div class="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
      <svg class="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    </div>

    <h3 class="text-xl font-bold text-green-700">{{ session.status === 'judgment_pending' ? '入力完了' : '点呼完了' }}</h3>
    <p class="text-gray-500 text-sm">{{ employeeName }}</p>
    <!-- 遠隔点呼は乗務員の側が終わっても運行管理者の判定で閉じる (Refs ippoan/rust-alc-api#680) -->
    <p
      v-if="session.status === 'judgment_pending'"
      class="w-full rounded-xl bg-amber-50 text-amber-800 text-sm text-center px-4 py-2"
      data-testid="judgment-pending"
    >
      入力は終わりました。判定は運行管理者が行うので、このまま終わって大丈夫です
      <span class="block mt-1" data-testid="judgment-reason">運行管理者が判定する理由: {{ judgmentReason }}</span>
    </p>

    <!-- 遠隔点呼の運行管理者の判定 (判定で閉じた後) -->
    <p
      v-if="session.status === 'completed' && (session.manager_judgment === 'ok' || session.manager_judgment === 'ng')"
      data-testid="manager-judgment"
      class="w-full rounded-xl text-sm text-center px-4 py-2"
      :class="session.manager_judgment === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'"
    >
      運行管理者の判定: {{ session.manager_judgment === 'ok' ? 'OK' : 'NG' }}<template v-if="session.manager_judgment_reason"> ({{ session.manager_judgment_reason }})</template>
    </p>

    <!-- サマリ -->
    <div class="w-full rounded-xl border border-gray-200 divide-y divide-gray-100 text-sm">
      <div class="flex justify-between px-4 py-2">
        <span class="text-gray-500">点呼種別</span>
        <span class="font-medium">{{ tenkoTypeLabel(session.tenko_type) }}</span>
      </div>
      <div class="flex justify-between px-4 py-2">
        <span class="text-gray-500">運行管理者</span>
        <span class="font-medium">{{ session.responsible_manager_name }}</span>
      </div>
      <div class="flex justify-between px-4 py-2">
        <span class="text-gray-500">開始</span>
        <span class="font-medium">{{ formatTime(session.started_at) }}</span>
      </div>
      <div class="flex justify-between px-4 py-2">
        <span class="text-gray-500">完了</span>
        <span class="font-medium">{{ formatTime(session.completed_at) }}</span>
      </div>
      <div v-if="session.alcohol_value != null" class="flex justify-between px-4 py-2">
        <span class="text-gray-500">アルコール</span>
        <span class="font-medium">{{ session.alcohol_value.toFixed(3) }} mg/L</span>
      </div>
      <div v-if="session.temperature != null" class="flex justify-between px-4 py-2">
        <span class="text-gray-500">体温</span>
        <span class="font-medium">{{ session.temperature.toFixed(1) }} &#8451;</span>
      </div>
      <div v-if="session.systolic != null && session.diastolic != null" class="flex justify-between px-4 py-2">
        <span class="text-gray-500">血圧</span>
        <span class="font-medium">{{ session.systolic }}/{{ session.diastolic }} mmHg</span>
      </div>
    </div>

    <button
      class="w-full py-3 bg-gray-200 text-gray-700 rounded-xl font-medium hover:bg-gray-300 transition-colors"
      @click="emit('reset')"
    >
      次の点呼へ
    </button>
    <p v-if="autoResetSeconds != null" data-testid="auto-reset-countdown" class="text-sm text-gray-500 text-center">
      あと {{ autoResetSeconds }} 秒で次の点呼へ移ります
    </p>
  </div>
</template>
