<script setup lang="ts">
import type { ApiVeinPendingModule } from '~/utils/api'
import { apiErrorCode, approveVeinByEmployee, getPendingVeinModuleTemplates } from '~/utils/api'
import { loadVeinModuleEntries } from '~/utils/vein-db'
import { failureStatus } from '~/utils/employee-lookup-messages'
import { syncVeinModule } from '~/utils/vein-module'
import { veinDeviceLabel } from '~/utils/vein-device-label'

/**
 * 未承認の指静脈を、運行管理者が端末で承認する (Refs ippoan/alc-app#436)。
 *
 * 一覧から 1 人を選ぶ → 運行管理者が指を置く → この端末のモジュールで照合 (1:N) して承認者を決める →
 * サーバーへ承認を頼む。承認者が運行管理者か・自分の記録が承認済みか・自分自身でないかはサーバーが確かめる。
 * 承認者は**この端末のモジュールに承認済みで入っている人**だけ (照合が承認待ちの ID に当たったら断る)
 */

const emit = defineEmits<{ close: [] }>()

const veinSerial = useVeinSerial()
/** 登録した端末の名前 (機体の鍵のラベル)。引けなければ短い表記 */
const { keyLabelOf } = useDeviceNames()
const pending = ref<ApiVeinPendingModule[]>([])
const loading = ref(true)
const listError = ref<string | null>(null)
const selected = ref<ApiVeinPendingModule | null>(null)
const busy = ref(false)
const again = ref(false)
const message = ref<string | null>(null)
const error = ref<string | null>(null)

/** サーバーのエラーの code → 画面の文言 */
const APPROVE_ERRORS: Record<string, string> = {
  approver_not_manager: '指を置いた人は運行管理者ではありません。運行管理者が指を置いてください',
  approver_not_enrolled: '運行管理者の指静脈が承認されていません',
  self_approval: '自分の登録は自分で承認できません。別の運行管理者が指を置いてください',
}

async function load() {
  loading.value = true
  listError.value = null
  try {
    pending.value = await getPendingVeinModuleTemplates()
  }
  catch (e) {
    listError.value = `未承認の一覧を取得できませんでした (${e instanceof Error ? e.message : String(e)})`
  }
  loading.value = false
}

onMounted(load)

function select(p: ApiVeinPendingModule) {
  selected.value = p
  message.value = null
  error.value = null
}

/** 運行管理者が指を置いて照合し、承認者が決まったら承認を頼む */
async function approve() {
  const target = selected.value
  if (!target || busy.value) return
  busy.value = true
  again.value = false
  error.value = null
  message.value = null
  try {
    await veinSerial.say('PLACE')
    const moduleId = await veinSerial.identify(() => { again.value = true })
    const approver = moduleId === null
      ? undefined
      : (await loadVeinModuleEntries()).find(e => e.moduleId === moduleId)
    if (!approver) {
      error.value = '指静脈が一致しませんでした。運行管理者がもう一度置いてください'
      await veinSerial.say('FAILED').catch(() => {})
      return
    }
    if (!approver.approved) {
      error.value = '指を置いた人の指静脈が未承認です。承認済みの運行管理者が置いてください'
      await veinSerial.say('FAILED').catch(() => {})
      return
    }
    await approveVeinByEmployee(target.employee_id, approver.employeeId, target.updated_at)
    message.value = `${target.name}さんの指静脈を承認しました`
    selected.value = null
    // 承認した人をこの端末の対応表でも承認済みにする (次の照合から本人確認に使える)
    void syncVeinModule(veinSerial)
    await load()
  }
  catch (e) {
    const code = apiErrorCode(e)
    error.value = (code ? APPROVE_ERRORS[code] : undefined)
      ?? (failureStatus(e) === 409
        ? 'その間に登録し直されました。一覧を読み直してください'
        : `承認できませんでした (${e instanceof Error ? e.message : String(e)})`)
    await veinSerial.say('FAILED').catch(() => {})
  }
  finally {
    busy.value = false
  }
}

function versionOf(p: ApiVeinPendingModule): string {
  const d = new Date(p.updated_at)
  return Number.isNaN(d.getTime()) ? p.updated_at : d.toLocaleString('ja-JP')
}
</script>

<template>
  <div class="bg-white rounded-2xl p-4 shadow-sm">
    <h2 class="text-lg font-semibold text-gray-700 mb-3">未承認の指静脈</h2>
    <p v-if="loading" class="text-sm text-gray-500">読み込み中...</p>
    <p v-else-if="listError" data-testid="vein-pending-list-error" class="text-sm text-red-600">{{ listError }}</p>
    <template v-else>
      <p v-if="!pending.length" data-testid="vein-pending-empty" class="text-sm text-gray-500">未承認の登録はありません</p>
      <ul v-else class="divide-y border rounded-xl">
        <li v-for="p in pending" :key="p.employee_id">
          <button
            data-testid="vein-pending-row"
            class="w-full text-left px-3 py-2 text-sm"
            :class="selected?.employee_id === p.employee_id ? 'bg-blue-50' : 'hover:bg-gray-50'"
            @click="select(p)"
          >
            <span class="font-medium">{{ p.name }}</span>
            <span class="ml-2 text-gray-500">{{ versionOf(p) }} 登録 / {{ veinDeviceLabel(p.registered_device_id, keyLabelOf(p.registered_device_id)) }}</span>
          </button>
        </li>
      </ul>
      <div v-if="selected" class="mt-4">
        <p class="text-sm text-gray-700 mb-2">{{ selected.name }}さんを承認します。運行管理者が指を置いてください</p>
        <button
          data-testid="vein-pending-approve"
          :disabled="busy || !veinSerial.isConnected.value"
          class="w-full px-4 py-4 bg-emerald-600 text-white rounded-2xl text-lg font-bold disabled:opacity-50"
          @click="approve"
        >
          {{ busy ? (again ? 'もう一度置いてください…' : '指を置いてください…') : '運行管理者の指で承認' }}
        </button>
      </div>
    </template>
    <p v-if="message" data-testid="vein-pending-message" class="mt-3 text-sm text-blue-700">{{ message }}</p>
    <p v-if="error" data-testid="vein-pending-error" class="mt-3 text-sm text-red-600">{{ error }}</p>
    <div class="mt-4 grid grid-cols-2 gap-3">
      <button class="px-4 py-3 rounded-xl border border-gray-300 text-gray-700 font-medium" @click="load">読み直す</button>
      <button class="px-4 py-3 rounded-xl bg-blue-600 text-white font-medium" @click="emit('close')">閉じる</button>
    </div>
  </div>
</template>
