<script setup lang="ts">
import type { FirmwareDevice } from '~/utils/api'
import { listFirmwareDevices, renameDevice, updateFirmware } from '~/utils/api'
import { fetchAdminLatestFirmwareVersions, hasFirmwareUpdate } from '~/utils/firmware-updates'
import { shortDeviceId } from '~/utils/short-device-id'
import { veinDeviceLabel } from '~/utils/vein-device-label'

/** 一覧を引き直す間隔 */
const LIST_INTERVAL_MS = 10_000
/** 最新の版 (配布ページの manifest) を引き直す間隔 */
const LATEST_INTERVAL_MS = 5 * 60_000
/** この時間より古い報告の端末は「応答なし」 */
const STALE_MS = 10 * 60_000
/** 更新の結果の 1 行を消すまでの時間 */
const NOTICE_MS = 10_000

const devices = ref<FirmwareDevice[]>([])
const listError = ref('')
/** flavor → 最新の版。取れなかった flavor は key ごと無い */
const latest = ref<Record<string, string>>({})
const notice = ref('')
/** 「更新する」を呼んでいる最中の device_id */
const busy = ref<Set<string>>(new Set())
/** 画面の「現在時刻」。応答なしの判定用に、一覧を引くたびに進める */
const now = ref(Date.now())

let listTimer: ReturnType<typeof setInterval> | undefined
let latestTimer: ReturnType<typeof setInterval> | undefined
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let listing = false

async function loadList() {
  if (listing) return
  listing = true
  try {
    devices.value = (await listFirmwareDevices()).devices
    listError.value = ''
  } catch (e) {
    listError.value = e instanceof Error ? e.message : '一覧を取得できませんでした'
  } finally {
    now.value = Date.now()
    listing = false
  }
}

async function loadLatest() {
  latest.value = await fetchAdminLatestFirmwareVersions()
}

onMounted(() => {
  loadList()
  loadLatest()
  listTimer = setInterval(loadList, LIST_INTERVAL_MS)
  latestTimer = setInterval(loadLatest, LATEST_INTERVAL_MS)
})
onUnmounted(() => {
  if (listTimer) clearInterval(listTimer)
  if (latestTimer) clearInterval(latestTimer)
  if (noticeTimer) clearTimeout(noticeTimer)
})

function showNotice(text: string) {
  notice.value = text
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { notice.value = '' }, NOTICE_MS)
}

const { keyLabelOf } = useDeviceNames()

/** 名前を変えている行の device_id (一度に 1 行だけ)。無ければ null */
const editingId = ref<string | null>(null)
/** 入力中の新しい名前 */
const editLabel = ref('')
/** 保存を送っている最中か (二重送信しない) */
const renaming = ref(false)
/** 名前の変更に失敗した行とその文言 (行の下に出す) */
const renameError = ref<{ deviceId: string, text: string } | null>(null)

function startRename(d: FirmwareDevice) {
  if (renaming.value) return
  editingId.value = d.device_id
  // 今の名前を入れておく (鍵のラベルに付く「(失効)」は名前ではないので外す)
  editLabel.value = d.label ?? keyLabelOf(d.device_id)?.replace(/ \(失効\)$/, '') ?? ''
  renameError.value = null
}

function cancelRename() {
  if (renaming.value) return
  editingId.value = null
  renameError.value = null
}

function renameErrorText(e: unknown): string {
  const err = e as Error & { status?: number }
  if (err.status === 409 && err.message.includes('duplicate_label')) return '同じ名前の端末があります'
  if (err.status === 409 && err.message.includes('revoked')) return '失効した端末は変えられません'
  if (err.status === 403 && err.message.includes('dev_token_write_forbidden')) return '確認用のログインでは名前を変えられません'
  return '名前を変えられませんでした'
}

async function saveRename(d: FirmwareDevice) {
  const label = editLabel.value.trim()
  if (renaming.value || editingId.value !== d.device_id || !label) return
  renaming.value = true
  renameError.value = null
  try {
    await renameDevice(d.device_id, label)
    editingId.value = null
    // 鍵のラベルは名前の表、登録簿のラベルは一覧の label に載るので両方引き直す
    await Promise.all([loadDeviceNames(true), loadList()])
  } catch (e) {
    renameError.value = { deviceId: d.device_id, text: renameErrorText(e) }
  } finally {
    renaming.value = false
  }
}

/**
 * 登録簿のラベル。無ければ、指静脈端末など鍵の id (`alarm-<指紋>`) の行は機体の鍵のラベル
 * (失効は「(失効)」付き)、それも無ければ `Vein Station <指紋 8 字>`。どれでもなければ id
 * (`timecard` は全部、それ以外は先頭 8 字)。id 全体は行の title に出す (見分け用)
 */
function deviceName(d: FirmwareDevice): string {
  if (d.label) return d.label
  if (d.device_id.startsWith('alarm-')) return veinDeviceLabel(d.device_id, keyLabelOf(d.device_id))
  return d.kind === 'timecard' ? d.device_id : d.device_id.slice(0, 8)
}

function latestOf(d: FirmwareDevice): string | undefined {
  return d.flavor ? latest.value[d.flavor] : undefined
}

function isStale(d: FirmwareDevice): boolean {
  return now.value - d.reported_at_ms >= STALE_MS
}

function isUpdating(d: FirmwareDevice): boolean {
  return ['downloading', 'writing', 'rebooting', 'confirming'].includes(d.phase)
}

const SKIP_REASONS: Record<string, string> = {
  up_to_date: '最新です',
  busy: '使用中でした',
  unsupported: '対象外の機種です',
  reflash_needed: '配布ページからの書き直しが必要です',
  flavor_mismatch: '対象外の種類です',
}

function statusLabel(d: FirmwareDevice): string {
  if (isStale(d)) return '応答なし'
  switch (d.phase) {
    case 'idle': return '待機中'
    case 'done': return '更新しました'
    case 'failed': return d.reason ? `失敗 (${d.reason})` : '失敗'
    case 'skipped': return `更新しませんでした: ${(d.reason && SKIP_REASONS[d.reason]) ?? d.reason ?? '理由なし'}`
    default: return '更新中'
  }
}

function canUpdate(d: FirmwareDevice): boolean {
  return !isStale(d) && !isUpdating(d) && hasFirmwareUpdate(d, latest.value)
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

async function update(d: FirmwareDevice) {
  // disabled の属性だけに頼らない (属性を外して click されても送らない)
  if (!canUpdate(d) || busy.value.has(d.device_id)) return
  if (!confirm(`${deviceName(d)} を ${latestOf(d)} に更新します。よろしいですか?`)) return
  busy.value = new Set(busy.value).add(d.device_id)
  try {
    const { sent } = await updateFirmware(d.device_id)
    // `sent` は購読の接続の数でキオスクの台数ではないので、数は画面に出さない
    showNotice(sent === 0
      ? '開いているキオスクがありません。キオスクの画面を開いてから、もう一度押してください。'
      : '合図を送りました。キオスクが待機画面のときに更新が始まります。')
  } catch (e) {
    const err = e as Error & { status?: number }
    showNotice(err.status === 403 && err.message.includes('dev_token_write_forbidden')
      ? '確認用のログインでは更新できません。'
      : err.message)
  } finally {
    const next = new Set(busy.value)
    next.delete(d.device_id)
    busy.value = next
  }
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-lg font-bold text-gray-800">端末のファーム</h2>

    <p v-if="listError" class="text-sm text-red-600" data-testid="firmware-list-error">{{ listError }}</p>
    <p v-if="notice" class="text-sm text-blue-700" data-testid="firmware-notice">{{ notice }}</p>

    <p v-if="devices.length === 0" class="text-center py-8 text-gray-400" data-testid="firmware-empty">
      報告している端末がありません。キオスクに CoreS3 / 指静脈端末を USB で繋ぎ、キオスクの画面を開いたままにしてください。
    </p>

    <div v-else class="overflow-x-auto border rounded-lg">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-gray-100 text-gray-600 text-xs">
            <th class="px-3 py-2 text-left whitespace-nowrap">端末</th>
            <th class="px-3 py-2 text-left whitespace-nowrap">種類</th>
            <th class="px-3 py-2 text-left whitespace-nowrap">現在の版</th>
            <th class="px-3 py-2 text-left whitespace-nowrap">最新の版</th>
            <th class="px-3 py-2 text-left whitespace-nowrap">状態</th>
            <th class="px-3 py-2 text-left whitespace-nowrap">最終報告</th>
            <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in devices" :key="d.device_id" class="border-t" data-testid="firmware-row">
            <td class="px-3 py-2 whitespace-nowrap" data-col="name" :title="d.device_id">
              <form
                v-if="editingId === d.device_id"
                class="flex items-center gap-1"
                data-testid="firmware-rename-form"
                @submit.prevent="saveRename(d)"
              >
                <input
                  v-model="editLabel"
                  class="px-2 py-1 border rounded text-sm w-40"
                  data-testid="firmware-rename-input"
                  maxlength="64"
                  :disabled="renaming"
                >
                <button
                  type="submit"
                  class="px-2 py-1 text-xs bg-blue-600 text-white rounded disabled:opacity-50"
                  data-testid="firmware-rename-save"
                  :disabled="renaming || !editLabel.trim()"
                >
                  保存
                </button>
                <button
                  type="button"
                  class="px-2 py-1 text-xs border rounded disabled:opacity-50"
                  data-testid="firmware-rename-cancel"
                  :disabled="renaming"
                  @click="cancelRename"
                >
                  やめる
                </button>
              </form>
              <span v-else class="inline-flex items-center gap-2">
                <span data-testid="firmware-name">{{ deviceName(d) }}</span>
                <button
                  type="button"
                  class="px-2 py-0.5 text-xs text-blue-700 border border-blue-300 rounded hover:bg-blue-50 disabled:opacity-50"
                  data-testid="firmware-rename"
                  :disabled="renaming"
                  @click="startRename(d)"
                >
                  名前を変える
                </button>
              </span>
              <p class="text-xs text-gray-500 font-mono mt-0.5" data-testid="firmware-device-id" :title="d.device_id">
                {{ shortDeviceId(d.device_id) }}
              </p>
              <p v-if="renameError?.deviceId === d.device_id" class="text-xs text-red-600 mt-1" data-testid="firmware-rename-error">
                {{ renameError.text }}
              </p>
            </td>
            <td class="px-3 py-2 whitespace-nowrap" data-col="kind">{{ d.kind }} / {{ d.flavor ?? '-' }}</td>
            <td class="px-3 py-2 whitespace-nowrap" data-col="version">{{ d.version ?? '不明 (古い版)' }}</td>
            <td class="px-3 py-2 whitespace-nowrap" data-col="latest">{{ latestOf(d) ?? '-' }}</td>
            <td class="px-3 py-2 whitespace-nowrap" data-col="status">{{ statusLabel(d) }}</td>
            <td class="px-3 py-2 whitespace-nowrap text-xs" data-col="reported">{{ formatTime(d.reported_at_ms) }}</td>
            <td class="px-3 py-2 text-center">
              <button
                class="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors disabled:opacity-50"
                data-testid="firmware-update"
                :disabled="!canUpdate(d) || busy.has(d.device_id)"
                @click="update(d)"
              >
                更新する
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="text-xs text-gray-500 space-y-1">
      <p>更新は、その端末を USB で繋いでいるキオスクの画面が開いているときだけ始まります。点呼や測定の途中では始まらず、待機画面に戻ったときに始まります。</p>
      <p>更新中 (1〜2 分) は、キオスクの画面に「端末を更新しています」と表示され、操作できません。</p>
    </div>
  </div>
</template>
