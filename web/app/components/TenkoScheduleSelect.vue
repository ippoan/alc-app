<script setup lang="ts">
import type { TenkoSchedule, TenkoSession } from '~/types'
import { tenkoTypeLabel } from '~/utils/tenko-type'
import { tenkoStatusLabel } from '~/utils/tenko-status'
import { noPendingSchedule } from '~/utils/employee-lookup-messages'

const props = withDefaults(defineProps<{
  schedules: TenkoSchedule[]
  employeeName: string
  /**
   * 途中で止まったまま残っている、アルコール未測定のセッション (Refs ippoan/alc-app#343)。
   * **既定は空 = 今までどおり** — 再開の導線を出す側 (`TenkoKiosk.vue`) が明示的に渡す。
   */
  resumableSessions?: TenkoSession[]
}>(), {
  resumableSessions: () => [],
})

/**
 * 実際に「続きから再開」のボタンを出す行 (Refs ippoan/alc-app#351)。
 *
 * **1 度再開した点呼は導線ごと出さない** — 再開は 1 セッションにつき 1 回までで
 * (`resumed_at` は単数カラムなので 2 回目の時刻を持てない)、出しても押した先で必ず
 * 400 (`already_resumed`) になる。**押せるボタンを描いてから断らない。**
 *
 * 候補を作る側 (`useTenkoKiosk` の `_fetchResumableSessions`) でも同じ行を落としているが、
 * このコンポーネントは渡された配列をそのまま描くだけなので、**描く側でも確かめる**。
 */
const visibleResumableSessions = computed(
  () => props.resumableSessions.filter(s => s.resumed_at === null),
)

const emit = defineEmits<{
  select: [schedule: TenkoSchedule]
  /** 止まっているセッションを続きから再開する (Refs ippoan/alc-app#343) */
  resume: [session: TenkoSession]
  /** 予定を選ばず業務後として進む (Refs ippoan/alc-app#322)。業務後は法令上「設定することが
   * できる」= 任意なので、予定が無い/この場に無い場合でも進められる。業務前のセッションには
   * ならない (呼び出し側が selectedTenkoType='post_operation' を立てるため) */
  'no-schedule': []
}>()

/**
 * 「どこまで済んでいるか」を出す (Refs ippoan/alc-app#343)。
 * **「再開できます」だけで中身を見せない**のは、確認できていないことを確認済みのように
 * 見せるのと同じなので、種別・状態・開始時刻を必ず並べる。
 */
function resumeSummary(s: TenkoSession): string {
  return `${tenkoTypeLabel(s.tenko_type)} / ${tenkoStatusLabel(s.status)} / ${formatStartedAt(s.started_at)}`
}

/** 開始時刻。サーバが `started_at` を持たない行を「不明」と正直に出す */
function formatStartedAt(iso: string | null): string {
  if (!iso) return '開始時刻 不明'
  return `開始 ${formatScheduledAt(iso)}`
}

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
    <!--
      途中で止まった点呼の再開 (Refs ippoan/alc-app#343)。**予定より先に出す** —
      顔認証の直後にフロントがハングして作られたセッションが溜まっており (#340 / #341 で
      ハング自体は手当て済み)、拾い直す手段が現場に無かった。
      出すのはアルコール未測定で、**まだ 1 度も再開していない**ものだけ
      (呼び出し側が絞り、`visibleResumableSessions` でも確かめる。Refs #351)。
    -->
    <template v-if="visibleResumableSessions.length > 0">
      <p class="text-sm text-gray-500">{{ employeeName }} さんの途中で止まっている点呼</p>
      <button
        v-for="s in visibleResumableSessions"
        :key="s.id"
        data-testid="resume-session"
        class="w-full text-left p-4 rounded-xl border border-blue-300 bg-blue-50 hover:border-blue-500 hover:bg-blue-100 transition-colors"
        @click="emit('resume', s)"
      >
        <div class="flex items-center justify-between">
          <span class="px-2 py-0.5 rounded text-xs font-bold bg-blue-100 text-blue-700">
            続きから再開
          </span>
          <span class="text-sm text-gray-500">{{ resumeSummary(s) }}</span>
        </div>
        <p class="mt-2 text-xs text-gray-500">
          アルコールはまだ測っていません。ここから続きを実施します。
        </p>
      </button>
    </template>

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
