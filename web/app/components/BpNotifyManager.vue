<script setup lang="ts">
import type { ApiBpNotifyEmployee, ApiBpNotifyLinkResult, ApiBpNotifyUpdate, ApiLineworksUser } from '~/utils/api'
import { getBpNotifySettings, getLineworksUsers, linkBpNotifyByName, updateBpNotifySetting } from '~/utils/api'
import { failureStatus } from '~/utils/employee-lookup-messages'

/**
 * 血圧の通知の管理 (Refs ippoan/alc-app#436)。測った本人への LINE WORKS と、毎朝 7:00 の管理者への
 * 日報メールの宛先を、社員ごとに決める。既存の通知 (宛先の画面) とは別。変更はその場で保存する。
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

function isManager(e: ApiBpNotifyEmployee): boolean {
  return e.role.includes('manager') || e.role.includes('admin')
}

/** 他の社員に結び付いている LINE WORKS のユーザーを除いた選択肢 (自分の結び付きは残す) */
function optionsFor(e: ApiBpNotifyEmployee): ApiLineworksUser[] {
  const taken = new Set(
    employees.value
      .filter(o => o.employee_id !== e.employee_id && o.lineworks_user_id)
      .map(o => o.lineworks_user_id),
  )
  return users.value.filter(u => !taken.has(u.user_id))
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
  const user = users.value.find(u => u.user_id === el.value)
  const body: ApiBpNotifyUpdate = user
    ? { lineworks_user_id: user.user_id, lineworks_name: user.name, email: user.email }
    : { lineworks_user_id: null, lineworks_name: null, email: null }
  return save(e, body, () => { el.value = e.lineworks_user_id ?? '' })
}

function onCheck(e: ApiBpNotifyEmployee, field: 'notify_self' | 'daily_report', ev: Event) {
  const el = ev.target as HTMLInputElement
  return save(e, { [field]: el.checked }, () => { el.checked = e[field] })
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
        血圧を測ると、結び付けた LINE WORKS へ本人に結果が届きます。毎朝 7:00 に前日の記録の一覧が、日報を受け取る管理者へメールで届きます
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
            <th class="py-1 pr-3">本人に通知</th>
            <th class="py-1">日報を受け取る</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in employees" :key="e.employee_id" class="border-t" data-testid="bp-notify-row">
            <td class="py-2 pr-3">
              {{ e.name }}
              <span v-if="isManager(e)" class="ml-1 text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800" data-testid="bp-notify-manager">管理者</span>
            </td>
            <td class="py-2 pr-3">{{ e.code }}</td>
            <td class="py-2 pr-3">
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
              <span v-if="e.lineworks_user_id && !e.email" class="ml-1 text-xs text-gray-500">メールなし</span>
            </td>
            <td class="py-2 pr-3">
              <input
                type="checkbox"
                data-testid="bp-notify-self"
                :checked="e.notify_self"
                :disabled="busy.has(e.employee_id)"
                @change="onCheck(e, 'notify_self', $event)"
              >
            </td>
            <td class="py-2">
              <span v-if="!isManager(e)" class="text-gray-400" data-testid="bp-notify-report-na">-</span>
              <template v-else>
                <input
                  type="checkbox"
                  data-testid="bp-notify-report"
                  :checked="e.daily_report"
                  :disabled="busy.has(e.employee_id) || !e.email"
                  @change="onCheck(e, 'daily_report', $event)"
                >
                <span v-if="!e.email" class="ml-1 text-xs text-gray-500" data-testid="bp-notify-report-reason">
                  メールが未設定のため選べません (メールのある LINE WORKS のユーザーを結び付けてください)
                </span>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
