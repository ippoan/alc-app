<script setup lang="ts">
import type { TenkoSchedule } from '~/types'
import { tenkoTypeLabel } from '~/utils/tenko-type'
import { noPendingSchedule } from '~/utils/employee-lookup-messages'

defineProps<{
  schedules: TenkoSchedule[]
  employeeName: string
}>()

const emit = defineEmits<{
  select: [schedule: TenkoSchedule]
  /** 予定を選ばず業務後として進む (Refs ippoan/alc-app#322)。業務後は法令上「設定することが
   * できる」= 任意なので、予定が無い/この場に無い場合でも進められる。業務前のセッションには
   * ならない (呼び出し側が selectedTenkoType='post_operation' を立てるため) */
  'no-schedule': []
}>()

function formatScheduledAt(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

</script>

<template>
  <div class="flex flex-col gap-3">
    <p class="text-sm text-gray-500">{{ employeeName }} さんの未実施予定</p>

    <button
      v-for="schedule in schedules"
      :key="schedule.id"
      class="w-full text-left p-4 rounded-xl border border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition-colors"
      @click="emit('select', schedule)"
    >
      <div class="flex items-center justify-between">
        <span
          class="px-2 py-0.5 rounded text-xs font-bold"
          :class="schedule.tenko_type === 'pre_operation'
            ? 'bg-blue-100 text-blue-700'
            : 'bg-orange-100 text-orange-700'"
        >
          {{ tenkoTypeLabel(schedule.tenko_type) }}
        </span>
        <span class="text-sm text-gray-500">{{ formatScheduledAt(schedule.scheduled_at) }}</span>
      </div>
      <p class="mt-2 text-sm text-gray-700">
        運行管理者: {{ schedule.responsible_manager_name }}
      </p>
      <p v-if="schedule.instruction" class="mt-1 text-xs text-gray-400 truncate">
        指示: {{ schedule.instruction }}
      </p>
    </button>

    <p v-if="schedules.length === 0" class="text-center text-gray-400 py-4">
      {{ noPendingSchedule() }}
    </p>

    <!--
      このボタンは業務後専用の逃げ道 (Refs ippoan/alc-app#322)。押すと selectedTenkoType=
      'post_operation' が立つので、業務前のセッションには絶対にならない (業務前は
      useTenkoKiosk.ts の onFaceAuthComplete のガードで引き続き予定必須)。
      法令要件「十」が業務後の予定を「設定することができ」= 任意としているため、業務後だけは
      予定なしで実施できる必要がある。予定選択の時点では運転者が業務前/業務後どちらを
      やりたいかは分からない (種別は選んだ予定が決める) ので、このボタン自体を出す/出さないの
      分岐は無く常に描画する — 「業務前には出さない」のは業務前という選択肢がそもそも無いこと
      (=このボタンが業務後の経路そのもの) で担保される。
    -->
    <button
      data-testid="no-schedule-post-operation"
      class="w-full text-left p-4 rounded-xl border border-dashed border-gray-300 hover:border-orange-400 hover:bg-orange-50 transition-colors text-sm text-gray-600"
      @click="emit('no-schedule')"
    >
      予定なしで業務後として進む
    </button>
  </div>
</template>
