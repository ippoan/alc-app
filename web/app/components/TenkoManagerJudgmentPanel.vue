<script setup lang="ts">
/**
 * 運行管理者の点呼 OK/NG 判定 (Refs ippoan/alc-app#315)。
 * `safety_judgment` (サーバが自動計算する安全判定) とは別物。NG でも点呼は完了扱いのまま、
 * 判定だけをこの口で記録する。
 *
 * **押し直し (再判定) を許可する** — 押し間違いは実運用で起きるため、サーバ側も
 * 上書きを許す作り。判定済みでも現在の判定を表示したまま OK/NG ボタンは出し続け、
 * 確認ダイアログは挟まない (親の判断、Refs ippoan/alc-app#315)。
 *
 * **`defaultMethod` を渡したときだけ** IT点呼 の「確認の方法」(通話で確認 / 対面で確認) を出し、
 * 送信に `method` を足す (Refs ippoan/alc-app#387)。渡さなければ画面も送信も今までと同一 —
 * 遠隔点呼モニターは渡さない (IT点呼 でない記録に `method` を送ると 400 になる)。
 *
 * 判定を送る口は prop `scope` (既定は遠隔点呼モニターの `'tenko-monitor'`)。IT点呼 の受け画面だけが
 * `'manager-device'` (運行管理者席の鍵) を渡す。
 */
import type { TenkoSession, SubmitManagerJudgment, InPersonScope } from '~/types'
import { getInPersonScope, submitManagerJudgment, type RequestTokenScope } from '~/utils/api'
import { isBpInPersonSession } from '~/utils/tenko-type'
import { MANAGER_JUDGMENT_METHOD, itTenkoRoomId, type ManagerJudgmentMethod } from '~/utils/it-tenko'

const props = withDefaults(defineProps<{
  session: TenkoSession
  managerId: string | null
  /** IT点呼 の受け画面だけが渡す。最初に選んでおく確認の方法 (既に確定していればそちらが先) */
  defaultMethod?: ManagerJudgmentMethod
  /** 判定を送る口。渡さなければ遠隔点呼モニターの口 (今までと同じ) */
  scope?: RequestTokenScope
  /**
   * 遠隔点呼の画面だけが渡す。乗務員が最後の確定 (指示確認・運行報告) を終えて判定待ちになるまで OK/NG を
   * 押させない。先に押すと判定だけが記録されて点呼が閉じず、通話を切ると乗務員も確定できなくなった
   * (2026-11-01 実機)
   */
  waitForDriver?: boolean
}>(), {
  scope: 'tenko-monitor',
  waitForDriver: false,
})

/** 乗務員の確定を待っているあいだ (判定を押させない) */
const waitingForDriver = computed(() =>
  props.waitForDriver && props.session.status !== 'judgment_pending' && props.session.status !== 'completed',
)

const emit = defineEmits<{
  judged: [TenkoSession]
}>()

const { markHandled } = useActiveRooms()

const ngMode = ref(false)
const reason = ref('')
const alternativeMeasure = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)

const METHOD_OPTIONS: { value: ManagerJudgmentMethod, label: string }[] = [
  { value: MANAGER_JUDGMENT_METHOD.IT, label: 'IT点呼 (通話で確認)' },
  { value: MANAGER_JUDGMENT_METHOD.IN_PERSON, label: '対面で確認' },
]
// `defaultMethod` が無ければ undefined のまま (欄を出さず、送信にも足さない)
const method = ref(props.defaultMethod && (props.session.manager_judgment_method ?? props.defaultMethod))

// 血圧の記録不足で対面点呼にした点呼だけ、会った運行管理者の範囲を見せる。範囲は判定のときサーバが車両と運行管理者の
// 所属営業所で決める (同じ営業所 = 対面点呼 / 別の営業所・グループ企業 = 遠隔点呼とみなす)。ここは表示だけで、送らない
const isBpInPerson = computed(() => isBpInPersonSession(props.session))
const inPersonScope = ref<InPersonScope | null>(null)
const inPersonScopeError = ref(false)
watch(() => [isBpInPerson.value, props.session.id, props.managerId] as const, async ([show, id, judge]) => {
  inPersonScope.value = null
  inPersonScopeError.value = false
  if (!show || !judge) return
  try {
    inPersonScope.value = await getInPersonScope(id, judge, props.scope)
  }
  catch {
    inPersonScopeError.value = true
  }
}, { immediate: true })
const IN_PERSON_SCOPE_LABEL: Record<InPersonScope['scope'], string> = {
  same_office: '同じ営業所の運行管理者 (対面点呼として記録します)',
  other_office: '別の営業所・グループ企業の運行管理者 (遠隔点呼とみなして記録します)',
  unknown: '車両か運行管理者の所属営業所が未設定のため、同じ営業所 (対面点呼) として記録します。所属は管理画面の「点呼の営業所」で設定できます',
}
const VEHICLE_SOURCE_LABEL: Record<string, string> = { carins: ' (車検証から)', manual: ' (手で選んだ所属)' }
function officeNames(offices: InPersonScope['judge_offices']): string {
  return offices.length ? offices.map(o => o.company_name ? `${o.company_name} ${o.name}` : o.name).join('、') : '未設定'
}

// NG 理由の入力中と送信中は、リロードで入力や送信結果が消えるので新版への載せ替えを止める
// (Refs #345)。待機中の TenkoRemoteAdminView が出している「安全」の申告より拒否が優先される。
useKioskScreen().declareReloadBlocked(() => ngMode.value || submitting.value)
// 同じあいだ、席の警告デバイスの更新も始めさせない (Refs ippoan/alc-app#425)。リロードの申告とは別の集合
useKioskScreen().declareDeviceBusy(() => ngMode.value || submitting.value)

function judgmentLabel(j: string | null) {
  return j === 'ok' ? 'OK' : j === 'ng' ? 'NG' : '-'
}
function judgmentColor(j: string | null) {
  return j === 'ok' ? 'text-green-700' : j === 'ng' ? 'text-red-700 font-semibold' : ''
}

function clickNg() {
  error.value = null
  ngMode.value = true
}

function cancelNg() {
  ngMode.value = false
  reason.value = ''
  alternativeMeasure.value = ''
  error.value = null
}

async function submit(judgment: 'ok' | 'ng') {
  if (waitingForDriver.value) return
  if (submitting.value) return
  if (!props.managerId) {
    error.value = '運行管理者が特定できていません'
    return
  }
  submitting.value = true
  error.value = null
  try {
    const body: SubmitManagerJudgment = { judgment, judged_by_employee_id: props.managerId }
    const trimmed = reason.value.trim()
    if (judgment === 'ng' && trimmed) body.reason = trimmed
    const alt = alternativeMeasure.value.trim()
    if (judgment === 'ng' && alt) body.alternative_measure = alt
    if (method.value) body.method = method.value
    const updated = await submitManagerJudgment(props.session.id, body, props.scope)
    // 判定が付いた点呼の部屋は、相手が閉じて消えるまで着信として数えない (警告デバイスを
    // 鳴らさない)。部屋の id は遠隔点呼なら記録の id そのまま、IT点呼 なら `it-<id>` —
    // 一覧に在る方だけが印になる
    for (const roomId of [updated.id, itTenkoRoomId(updated.id)]) markHandled(roomId)
    emit('judged', updated)
    ngMode.value = false
    reason.value = ''
    alternativeMeasure.value = ''
  } catch {
    error.value = '判定の送信に失敗しました'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="text-sm">
    <div class="font-semibold text-gray-600 mb-1">運行管理者の判定</div>

    <!-- 現在の判定 (判定済みなら表示。押し直しは下のボタンで可能) -->
    <div v-if="session.manager_judgment" class="mb-2">
      <span class="font-bold" :class="judgmentColor(session.manager_judgment)">
        {{ judgmentLabel(session.manager_judgment) }}
      </span>
      <span v-if="session.manager_judgment_reason" class="ml-2 text-xs text-gray-600">
        理由: {{ session.manager_judgment_reason }}
      </span>
      <span v-if="session.alternative_measure" class="ml-2 text-xs text-gray-600" data-testid="judgment-alternative-shown">
        代替措置: {{ session.alternative_measure }}
      </span>
    </div>

    <div v-if="error" class="mb-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
      {{ error }}
    </div>

    <!-- 確認の方法 (IT点呼 の受け画面が `defaultMethod` を渡したときだけ) -->
    <div v-if="method" class="mb-2" data-testid="judgment-method">
      <div class="text-xs text-gray-500 mb-1">確認の方法</div>
      <div class="flex gap-3">
        <label v-for="opt in METHOD_OPTIONS" :key="opt.value" class="flex items-center gap-1 text-sm text-gray-800">
          <input v-model="method" type="radio" name="judgment-method" :value="opt.value" :disabled="submitting">
          {{ opt.label }}
        </label>
      </div>
    </div>

    <!-- 血圧の記録不足で対面点呼にした点呼: 会った運行管理者の範囲 (所属営業所で自動で決まる。表示だけ) -->
    <div v-if="isBpInPerson" class="mb-2" data-testid="judgment-in-person-scope">
      <div class="text-xs text-gray-500 mb-1">会った運行管理者</div>
      <template v-if="inPersonScope">
        <p
          data-testid="judgment-in-person-scope-result"
          :class="inPersonScope.scope === 'unknown' ? 'rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800' : 'text-sm text-gray-800'"
        >
          {{ IN_PERSON_SCOPE_LABEL[inPersonScope.scope] }}
        </p>
        <p class="mt-1 text-xs text-gray-500" data-testid="judgment-in-person-scope-offices">
          車両{{ inPersonScope.vehicle_number ? ` ${inPersonScope.vehicle_number}` : '' }}の営業所: {{ officeNames(inPersonScope.vehicle_offices) }}{{ VEHICLE_SOURCE_LABEL[inPersonScope.vehicle_source ?? ''] ?? '' }}
          / 運行管理者の所属: {{ officeNames(inPersonScope.judge_offices) }}
        </p>
      </template>
      <p v-else-if="inPersonScopeError" class="text-xs text-gray-600" data-testid="judgment-in-person-scope-error">
        所属営業所を確かめられませんでした。記録の方法は判定のときに所属営業所で決まります
      </p>
      <p v-else class="text-xs text-gray-500">所属営業所を確かめています</p>
    </div>

    <p v-if="waitingForDriver" data-testid="waiting-for-driver" class="mb-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
      乗務員が最後の確定 (指示確認・運行報告) をするまでお待ちください。確定すると判定できます
    </p>

    <!-- OK/NG ボタン (判定済みでも押し直せる) -->
    <div class="flex gap-2">
      <button
        class="px-4 py-1.5 text-sm rounded-lg bg-green-100 hover:bg-green-200 text-green-800 font-medium transition-colors disabled:opacity-50"
        :disabled="submitting || waitingForDriver"
        @click="submit('ok')"
      >
        OK
      </button>
      <button
        v-if="!ngMode"
        class="px-4 py-1.5 text-sm rounded-lg bg-red-100 hover:bg-red-200 text-red-800 font-medium transition-colors disabled:opacity-50"
        :disabled="submitting || waitingForDriver"
        @click="clickNg"
      >
        NG
      </button>
    </div>

    <div v-if="ngMode" class="mt-2">
      <textarea
        v-model="reason"
        rows="2"
        placeholder="理由 (任意)"
        class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-400"
      />
      <textarea
        v-model="alternativeMeasure"
        rows="2"
        placeholder="代替措置の内容 (任意)"
        data-testid="judgment-alternative"
        class="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-400"
      />
      <div class="mt-1 flex gap-2">
        <button
          class="px-4 py-1.5 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium transition-colors disabled:opacity-50"
          :disabled="submitting"
          @click="submit('ng')"
        >
          NG として記録する
        </button>
        <button
          class="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 underline"
          :disabled="submitting"
          @click="cancelNg"
        >
          キャンセル
        </button>
      </div>
    </div>
  </div>
</template>
