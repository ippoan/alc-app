<script setup lang="ts">
/**
 * 運行管理者の点呼 OK/NG 判定 (Refs ippoan/alc-app#315)。
 * `safety_judgment` (サーバが自動計算する安全判定) とは別物。NG でも点呼は完了扱いのまま、
 * 判定だけをこの口で記録する。
 *
 * **押し直し (再判定) を許可する** — 押し間違いは実運用で起きるため、サーバ側も
 * 上書きを許す作り。判定済みでも現在の判定を表示したまま OK/NG ボタンは出し続け、
 * 確認ダイアログは挟まない (親の判断、Refs ippoan/alc-app#315)。
 */
import type { TenkoSession, SubmitManagerJudgment } from '~/types'
import { submitManagerJudgment } from '~/utils/api'

const props = defineProps<{
  session: TenkoSession
  managerId: string | null
}>()

const emit = defineEmits<{
  judged: [TenkoSession]
}>()

const ngMode = ref(false)
const reason = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)

// NG 理由の入力中と送信中は、リロードで入力や送信結果が消えるので新版への載せ替えを止める
// (Refs #345)。待機中の TenkoRemoteAdminView が出している「安全」の申告より拒否が優先される。
useKioskScreen().declareReloadBlocked(() => ngMode.value || submitting.value)

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
  error.value = null
}

async function submit(judgment: 'ok' | 'ng') {
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
    const updated = await submitManagerJudgment(props.session.id, body)
    emit('judged', updated)
    ngMode.value = false
    reason.value = ''
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
    </div>

    <div v-if="error" class="mb-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
      {{ error }}
    </div>

    <!-- OK/NG ボタン (判定済みでも押し直せる) -->
    <div class="flex gap-2">
      <button
        class="px-4 py-1.5 text-sm rounded-lg bg-green-100 hover:bg-green-200 text-green-800 font-medium transition-colors disabled:opacity-50"
        :disabled="submitting"
        @click="submit('ok')"
      >
        OK
      </button>
      <button
        v-if="!ngMode"
        class="px-4 py-1.5 text-sm rounded-lg bg-red-100 hover:bg-red-200 text-red-800 font-medium transition-colors disabled:opacity-50"
        :disabled="submitting"
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
