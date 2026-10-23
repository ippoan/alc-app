<script setup lang="ts">
import type { ApiBpNotifyEmployee, ApiBpNotifyLinkResult, ApiBpNotifyUpdate, ApiLineworksUser } from '~/utils/api'
import { getBpNotifySettings, getLineworksUsers, linkBpNotifyByName, updateBpNotifySetting } from '~/utils/api'
import { failureStatus } from '~/utils/employee-lookup-messages'

/**
 * 血圧の通知の管理 (Refs ippoan/alc-app#436)。測った本人への LINE WORKS の結び付けと
 * 本人への通知を、社員ごとに決める。毎朝 7:00 の日報メールの宛先はここではなく、通知の宛先の画面で選ぶ。
 * 変更はその場で保存する。
 */

const SKIP_REASONS: Record<string, string> = {
  no_lineworks_user: '同じ名前の LINE WORKS のユーザーがいません',
  multiple_lineworks_users: '同じ名前の LINE WORKS のユーザーが 2 人以上います',
  lineworks_user_taken: 'そのユーザーは別の社員に結び付いています',
}

const employees = ref<ApiBpNotifyEmployee[]>([])
const users = ref<ApiLineworksUser[]>([])
const listError = ref('')
const usersError = ref('')
const saveError = ref('')
const notice = ref('')
/** 保存中の社員 */
const busy = ref<Set<string>>(new Set())

const link = ref<ApiBpNotifyLinkResult | null>(null)
const linkBusy = ref(false)
const linkError = ref('')

/** 失敗の文言。サーバーが返す理由の記号は画面に出せる文にする */
function reasonOf(e: unknown, fallback: string): string {
  const message = e instanceof Error && e.message ? e.message : fallback
  if (message.includes('lineworks_user_taken')) return 'その LINE WORKS のユーザーは別の社員に結び付いています'
  if (message.includes('lineworks_unavailable')) return 'LINE WORKS のユーザーの一覧を取得できませんでした (LINE WORKS に接続できません)'
  return message
}

async function loadEmployees() {
  try {
    employees.value = (await getBpNotifySettings()).employees
    listError.value = ''
  }
  catch (e) {
    listError.value = reasonOf(e, '設定を取得できませんでした')
  }
}

async function loadUsers() {
  try {
    users.value = (await getLineworksUsers()).users
    usersError.value = ''
  }
  catch (e) {
    users.value = []
    usersError.value = reasonOf(e, 'LINE WORKS のユーザーの一覧を取得できませんでした')
  }
}

onMounted(() => Promise.all([loadEmployees(), loadUsers()]))

/**
 * LINE WORKS のユーザー → 結び付いている社員。表全体で 1 回だけ数える (行ごとに数え直すと、
 * 400 行 × 400 人で描き直しのたびに重くなる)
 */
const takenBy = computed(() => {
  const m = new Map<string, string>()
  for (const o of employees.value) if (o.lineworks_user_id) m.set(o.lineworks_user_id, o.employee_id)
  return m
})

/** 他の社員に結び付いている LINE WORKS のユーザーを除いた選択肢 (自分の結び付きは残す) */
function optionsFor(e: ApiBpNotifyEmployee): ApiLineworksUser[] {
  return users.value.filter((u) => {
    const owner = takenBy.value.get(u.user_id)
    return !owner || owner === e.employee_id
  })
}

/**
 * LINE WORKS のユーザーを選び直している社員 (1 人だけ)。**選択肢はこの行にだけ出す** —
 * 全行 (400) に全ユーザー (約 200) の選択肢を置くと 8 万個近い要素になり、確認の欄を出すなどの
 * 描き直しのたびにブラウザが固まっていた (Refs ippoan/alc-app#436)
 */
const editingId = ref<string | null>(null)

/** 表示用: 結び付いている LINE WORKS のユーザーの名前 */
function linkedName(e: ApiBpNotifyEmployee): string {
  if (!e.lineworks_user_id) return '(未設定)'
  return users.value.find(u => u.user_id === e.lineworks_user_id)?.name ?? e.lineworks_name ?? e.lineworks_user_id
}

/** 一覧に無い (取得できない・消えた) ユーザーに結び付いているとき、選択肢に出す名前 */
function orphanName(e: ApiBpNotifyEmployee): string | null {
  if (!e.lineworks_user_id) return null
  if (users.value.some(u => u.user_id === e.lineworks_user_id)) return null
  return e.lineworks_name ?? e.lineworks_user_id
}

async function save(e: ApiBpNotifyEmployee, body: ApiBpNotifyUpdate, restore: () => void) {
  busy.value = new Set(busy.value).add(e.employee_id)
  notice.value = ''
  try {
    const updated = await updateBpNotifySetting(e.employee_id, body)
    employees.value = employees.value.map(o => o.employee_id === e.employee_id ? updated : o)
    saveError.value = ''
  }
  catch (err) {
    saveError.value = `${e.name} さんの設定を保存できませんでした: ${reasonOf(err, '保存に失敗しました')}`
    // 画面の部品を保存前の値に戻す (保存できなかった値のまま残さない)
    restore()
  }
  finally {
    const next = new Set(busy.value)
    next.delete(e.employee_id)
    busy.value = next
  }
}

function onSelect(e: ApiBpNotifyEmployee, ev: Event) {
  const el = ev.target as HTMLSelectElement
  editingId.value = null
  const user = users.value.find(u => u.user_id === el.value)
  const body: ApiBpNotifyUpdate = user
    ? { lineworks_user_id: user.user_id, lineworks_name: user.name, email: user.email }
    : { lineworks_user_id: null, lineworks_name: null, email: null }
  return save(e, body, () => { el.value = e.lineworks_user_id ?? '' })
}

function onCheckSelf(e: ApiBpNotifyEmployee, ev: Event) {
  const el = ev.target as HTMLInputElement
  return save(e, { notify_self: el.checked }, () => { el.checked = e.notify_self })
}

async function previewLink() {
  linkBusy.value = true
  try {
    link.value = await linkBpNotifyByName(true)
    linkError.value = ''
  }
  catch (e) {
    link.value = null
    saveError.value = reasonOf(e, '結び付けの候補を取得できませんでした')
  }
  finally {
    linkBusy.value = false
  }
}

async function confirmLink() {
  linkBusy.value = true
  try {
    const result = await linkBpNotifyByName(false)
    link.value = null
    linkError.value = ''
    notice.value = `${result.linked} 件を結び付けました`
    await Promise.all([loadEmployees(), loadUsers()])
  }
  catch (e) {
    if (failureStatus(e) === 409) {
      // 先に別の操作で結び付いた。候補が古いので見直す
      linkError.value = '候補の一部が先に結び付けられていました。候補を取り直しました。もう一度確認してください'
      await loadEmployees()
      try {
        link.value = await linkBpNotifyByName(true)
      }
      catch {
        link.value = null
      }
    }
    else {
      linkError.value = reasonOf(e, '結び付けに失敗しました')
    }
  }
  finally {
    linkBusy.value = false
  }
}

function cancelLink() {
  link.value = null
  linkError.value = ''
}
</script>

<template>
  <div class="space-y-4" data-testid="bp-notify">
    <div class="bg-white rounded-xl p-4 shadow-sm space-y-3">
      <p class="text-sm text-gray-600" data-testid="bp-notify-description">
        血圧を測ると、結び付けた LINE WORKS へ本人に結果が届きます。毎朝 7:00 の日報メールの宛先は、通知の宛先の画面の「血圧の日報」で選びます
      </p>

      <div class="flex items-center gap-3">
        <button
          class="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50"
          data-testid="bp-notify-link"
          :disabled="linkBusy || !!link"
          @click="previewLink"
        >
          氏名で LINE WORKS と結び付ける
        </button>
        <span v-if="notice" class="text-sm text-green-700" data-testid="bp-notify-notice">{{ notice }}</span>
      </div>

      <p v-if="usersError" class="text-sm text-red-600" data-testid="bp-notify-users-error">{{ usersError }}</p>
      <p v-if="saveError" class="text-sm text-red-600" data-testid="bp-notify-save-error">{{ saveError }}</p>
    </div>

    <div v-if="link" class="bg-white rounded-xl p-4 shadow-sm space-y-3" data-testid="bp-notify-link-panel">
      <h3 class="font-bold text-sm">氏名での結び付けの確認</h3>
      <p v-if="linkError" class="text-sm text-red-600" data-testid="bp-notify-link-error">{{ linkError }}</p>

      <div>
        <p class="text-sm font-semibold">結び付けられる社員 ({{ link.candidates.length }} 件)</p>
        <p v-if="link.candidates.length === 0" class="text-sm text-gray-500" data-testid="bp-notify-candidates-empty">
          結び付けられる社員はいません
        </p>
        <ul v-else class="text-sm divide-y">
          <li v-for="c in link.candidates" :key="c.employee_id" class="py-1" data-testid="bp-notify-candidate">
            {{ c.employee_name }} ↔ {{ c.lineworks_name }}
            <span class="text-gray-500">({{ c.email ?? 'メールなし' }})</span>
          </li>
        </ul>
      </div>

      <div v-if="link.skipped.length > 0">
        <p class="text-sm font-semibold">結べない社員 ({{ link.skipped.length }} 件)</p>
        <ul class="text-sm divide-y">
          <li v-for="s in link.skipped" :key="s.employee_id" class="py-1" data-testid="bp-notify-skipped">
            {{ s.employee_name }}: {{ SKIP_REASONS[s.reason] ?? s.reason }}
          </li>
        </ul>
      </div>

      <div class="flex gap-2">
        <button
          class="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50"
          data-testid="bp-notify-link-confirm"
          :disabled="linkBusy || link.candidates.length === 0"
          @click="confirmLink"
        >
          {{ link.candidates.length }} 件を結び付ける
        </button>
        <button
          class="px-3 py-1.5 rounded-lg bg-gray-200 text-sm"
          data-testid="bp-notify-link-cancel"
          :disabled="linkBusy"
          @click="cancelLink"
        >
          キャンセル
        </button>
      </div>
    </div>

    <div class="bg-white rounded-xl p-4 shadow-sm overflow-x-auto">
      <p v-if="listError" class="text-sm text-red-600" data-testid="bp-notify-list-error">{{ listError }}</p>
      <p v-else-if="employees.length === 0" class="text-sm text-gray-500" data-testid="bp-notify-empty">社員がいません</p>
      <table v-else class="w-full text-sm">
        <thead>
          <tr class="text-left text-gray-500">
            <th class="py-1 pr-3">氏名</th>
            <th class="py-1 pr-3">コード</th>
            <th class="py-1 pr-3">LINE WORKS のユーザー</th>
            <th class="py-1">本人に通知</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in employees" :key="e.employee_id" class="border-t" data-testid="bp-notify-row">
            <td class="py-2 pr-3">
              {{ e.name }}
            </td>
            <td class="py-2 pr-3">{{ e.code }}</td>
            <td class="py-2 pr-3">
              <template v-if="editingId === e.employee_id">
                <select
                  class="border rounded px-2 py-1"
                  data-testid="bp-notify-select"
                  :value="e.lineworks_user_id ?? ''"
                  :disabled="busy.has(e.employee_id)"
                  @change="onSelect(e, $event)"
                >
                  <option value="">(未設定)</option>
                  <option v-if="orphanName(e)" :value="e.lineworks_user_id ?? ''">{{ orphanName(e) }}</option>
                  <option v-for="u in optionsFor(e)" :key="u.user_id" :value="u.user_id">{{ u.name }}</option>
                </select>
                <button class="ml-1 text-xs text-gray-500 underline" data-testid="bp-notify-edit-cancel" @click="editingId = null">やめる</button>
              </template>
              <template v-else>
                <span data-testid="bp-notify-linked" :class="e.lineworks_user_id ? '' : 'text-gray-400'">{{ linkedName(e) }}</span>
                <button
                  class="ml-2 text-xs text-blue-700 underline disabled:opacity-50"
                  data-testid="bp-notify-edit"
                  :disabled="busy.has(e.employee_id)"
                  @click="editingId = e.employee_id"
                >
                  変更
                </button>
              </template>
              <span v-if="e.lineworks_user_id && !e.email" class="ml-1 text-xs text-gray-500">メールなし</span>
            </td>
            <td class="py-2">
              <input
                type="checkbox"
                data-testid="bp-notify-self"
                :checked="e.notify_self"
                :disabled="busy.has(e.employee_id)"
                @change="onCheckSelf(e, $event)"
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
