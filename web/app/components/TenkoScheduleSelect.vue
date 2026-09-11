<script setup lang="ts">
import type { TenkoSchedule } from '~/types'
import { tenkoTypeLabel } from '~/utils/tenko-type'

defineProps<{
  schedules: TenkoSchedule[]
  employeeName: string
}>()

const emit = defineEmits<{
  select: [schedule: TenkoSchedule]
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
      未消費の点呼予定がありません
    </p>
  </div>
</template>
