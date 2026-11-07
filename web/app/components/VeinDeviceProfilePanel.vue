<script setup lang="ts">
/**
 * 指静脈の個体値の計測 (Refs ippoan/alc-app-s3#352)。運行者のキオスク・血圧測定台・運行管理者の席から開く。
 *
 * この端末のモジュールに入っている乗務員を選び、同じ指を何度か置いてもらって、端末の癖 (置いた位置のずれ・点数・明るさ) を
 * 平均と散らばりで出す。手順は `useVeinDeviceProfile`、計算は `utils/vein-device-profile.ts`。ここは表示だけ。
 * 照合の結果で画面は進まず、登録の記録にも触らない。撮った回はサーバーの認証ログにも残る
 */
import type { ApiEmployee } from '~/types'
import { getEmployees, getPendingVeinModuleTemplates, type RequestTokenScope } from '~/utils/api'
import { loadVeinModuleEntries, type VeinModuleEntry } from '~/utils/vein-db'
import { formatVeinStat } from '~/utils/vein-device-profile'
import { VEIN_PROFILE_DEFAULT_COUNT, VEIN_PROFILE_NO_APPROVED, useVeinDeviceProfile } from '~/composables/useVeinDeviceProfile'

const props = withDefaults(defineProps<{
  /** 乗務員の一覧と認証ログを送る鍵 (運行管理者の席 = `manager-device`、測定台 = `bp-station`) */
  scope?: RequestTokenScope
  closeLabel?: string
}>(), { scope: 'default', closeLabel: '戻る' })
const emit = defineEmits<{ close: [] }>()

const veinSerial = useVeinSerial()
onMounted(() => veinSerial.connect())

const measure = useVeinDeviceProfile({ port: veinSerial, scope: props.scope })
onUnmounted(() => measure.stop())

const entries = ref<VeinModuleEntry[]>([])
const names = ref(new Map<string, string>())
/** モジュールに入っていない乗務員 (サーバーに記録があれば計れる。モジュールの判定は「別の人」か「不一致」になる) */
const others = ref<ApiEmployee[]>([])
const employeeId = ref('')
/** 承認待ちの乗務員 (サーバーに承認済みの記録が無く、サーバーでは比べられない) */
const pendingIds = ref(new Set<string>())
const count = ref(VEIN_PROFILE_DEFAULT_COUNT)

onMounted(async () => {
  // 承認待ちの人も出す (計測はサーバーの本人の記録と比べるだけで、承認は関係しない)
  entries.value = (await loadVeinModuleEntries()).sort((a, b) => a.moduleId - b.moduleId)
  try {
    const emps: ApiEmployee[] = await getEmployees(props.scope)
    names.value = new Map(emps.map(e => [e.id, e.name]))
    const inModule = new Set(entries.value.map(e => e.employeeId))
    others.value = emps.filter(e => !inModule.has(e.id)).sort((a, b) => a.name.localeCompare(b.name, 'ja'))
  }
  catch {
    // 名前が引けなくても ID で選べる
  }
  try {
    pendingIds.value = new Set((await getPendingVeinModuleTemplates(props.scope)).map(p => p.employee_id))
  }
  catch {
    // 承認待ちが引けなくても計れる (計った回に理由が出る)
  }
})

/** 選んだ人の記録が承認待ち、または計った回にサーバーが「承認済みの記録が無い」と返した */
const noApprovedWarning = computed(() =>
  (employeeId.value !== '' && pendingIds.value.has(employeeId.value))
  || measure.shots.value.some(s => s.error === VEIN_PROFILE_NO_APPROVED),
)

function nameOf(entry: VeinModuleEntry): string {
  const name = names.value.get(entry.employeeId) ?? `(名前不明 ${entry.employeeId.slice(0, 8)})`
  return entry.approved ? name : `${name} (承認待ち)`
}

const disabledReason = computed<string | null>(() => {
  if (!veinSerial.isSupported) return 'この端末は WebSerial に対応していません'
  if (!veinSerial.isConnected.value) return 'Vein Station (指静脈読み取り端末) が接続されていません'
  return null
})
const canStart = computed(() => !measure.busy.value && disabledReason.value === null && employeeId.value !== '' && count.value >= 1)

function start() {
  void measure.run(employeeId.value, Math.min(30, Math.max(1, Math.round(count.value))))
}

const guideText = computed(() => {
  if (measure.guide.value === 'place') return '指を置いてください'
  if (measure.guide.value === 'again') return 'もう一度置いてください'
  if (measure.guide.value === 'release') return '指を離して、もう一度置いてください'
  return null
})

const MODULE_LABEL = { self: '本人', other: '別の人', none: '不一致' } as const
const p = computed(() => measure.profile.value)
</script>

<template>
  <div class="space-y-4" data-testid="vein-profile">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-bold text-gray-800">指静脈の個体値の計測</h2>
      <button class="text-sm text-blue-700 hover:underline" data-testid="vein-profile-close" @click="emit('close')">{{ closeLabel }}</button>
    </div>
    <p class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      同じ人が、この端末で同じ指を何度か置きます。置いた位置のずれ・点数・明るさの平均から、この端末の癖を見ます。
      照合の結果で画面は進まず、登録の記録も変えません
    </p>
    <p v-if="disabledReason" class="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800" data-testid="vein-profile-disabled">
      {{ disabledReason }}
    </p>

    <div class="grid grid-cols-3 gap-3 items-end">
      <label class="col-span-2 text-sm text-gray-700">
        乗務員
        <select v-model="employeeId" class="mt-1 w-full rounded-md border border-gray-300 px-2 py-2" :disabled="measure.busy.value" data-testid="vein-profile-employee">
          <option value="" disabled>選んでください</option>
          <optgroup v-if="entries.length > 0" label="この端末のモジュールにいる人">
            <option v-for="e in entries" :key="e.employeeId" :value="e.employeeId">{{ e.moduleId }}: {{ nameOf(e) }}</option>
          </optgroup>
          <optgroup v-if="others.length > 0" label="モジュールにいない人">
            <option v-for="e in others" :key="e.id" :value="e.id">{{ e.name }}</option>
          </optgroup>
        </select>
      </label>
      <label class="text-sm text-gray-700">
        回数
        <input v-model.number="count" type="number" min="1" max="30" class="mt-1 w-full rounded-md border border-gray-300 px-2 py-2" :disabled="measure.busy.value" data-testid="vein-profile-count">
      </label>
    </div>
    <p v-if="noApprovedWarning" class="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800" data-testid="vein-profile-pending-warning">
      この人の指静脈の記録は承認待ちです (どこかの端末で登録し直した直後など)。サーバーに比べる相手が無いので、
      サーバーの判定・点数・位置のずれは出ません (モジュールの判定だけ出ます)。承認してから計ってください
    </p>
    <p v-if="entries.length === 0" class="text-sm text-gray-500" data-testid="vein-profile-empty">
      この端末のモジュールに乗務員がいません (モジュールにいない人も選べます。指静脈を登録した人ならサーバーで判定されます)
    </p>

    <div class="grid grid-cols-2 gap-3">
      <button class="px-4 py-3 rounded-md text-sm font-medium bg-blue-600 text-white disabled:opacity-40" :disabled="!canStart" data-testid="vein-profile-start" @click="start">計測を始める</button>
      <button class="px-4 py-3 rounded-md text-sm font-medium border border-gray-300 text-gray-700 disabled:opacity-40" :disabled="!measure.busy.value" data-testid="vein-profile-stop" @click="measure.stop()">この回で止める</button>
    </div>

    <div
      class="rounded-xl border bg-white flex items-center justify-center text-center min-h-24 px-4"
      :class="guideText ? 'border-blue-400' : 'border-gray-200'"
      data-testid="vein-profile-guide"
    >
      <span v-if="guideText" class="text-2xl font-bold text-blue-700">{{ guideText }}</span>
      <span v-else-if="measure.busy.value" class="text-lg text-gray-600">処理中…</span>
      <span v-else class="text-lg text-gray-400">待機中</span>
    </div>
    <p v-if="measure.error.value" class="text-sm text-red-700">{{ measure.error.value }}</p>

    <section v-if="p.shots > 0" class="rounded-lg border bg-white p-4 text-sm space-y-1" data-testid="vein-profile-summary">
      <h3 class="font-bold text-gray-800">この端末の個体値 ({{ p.shots }} 回)</h3>
      <p>モジュールが本人と判定: {{ p.moduleSelf }} / {{ p.shots }}　サーバーが本人と判定: {{ p.serverMatch }} / {{ p.shots }}</p>
      <p>位置のずれ dx: {{ formatVeinStat(p.dx) }}　dy: {{ formatVeinStat(p.dy) }}　重なり (‰): {{ formatVeinStat(p.overlap, 0) }}</p>
      <p>点数 s0: {{ formatVeinStat(p.s0) }}　s1: {{ formatVeinStat(p.s1) }}　s2: {{ formatVeinStat(p.s2) }}</p>
      <p>明るさ 記録用: {{ formatVeinStat(p.recordGray) }}　照合用: {{ formatVeinStat(p.matchGray) }}</p>
    </section>

    <div v-if="measure.shots.value.length > 0" class="overflow-x-auto">
      <table class="w-full text-xs text-left border-collapse" data-testid="vein-profile-table">
        <thead>
          <tr class="border-b text-gray-600">
            <th class="py-1 pr-2">回</th><th class="pr-2">モジュール</th><th class="pr-2">サーバー</th><th class="pr-2">点数</th>
            <th class="pr-2">規則</th><th class="pr-2">dx</th><th class="pr-2">dy</th><th class="pr-2">重なり</th><th class="pr-2">明るさ</th><th>メモ</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in measure.shots.value" :key="s.n" class="border-b">
            <td class="py-1 pr-2">{{ s.n }}</td>
            <td class="pr-2">{{ MODULE_LABEL[s.module] }}</td>
            <td class="pr-2">{{ s.server ?? '—' }}</td>
            <td class="pr-2">{{ s.scores ? s.scores.join('/') : '—' }}</td>
            <td class="pr-2">{{ s.rule ?? '—' }}</td>
            <td class="pr-2">{{ s.dx ?? '—' }}</td>
            <td class="pr-2">{{ s.dy ?? '—' }}</td>
            <td class="pr-2">{{ s.overlap ?? '—' }}</td>
            <td class="pr-2">{{ s.cap ? `${s.cap.recordGray ?? '—'}/${s.cap.matchGray ?? '—'}` : '—' }}</td>
            <td class="text-red-700">{{ s.error ?? (s.cap?.lineW ? '線の途切れ' : '') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
