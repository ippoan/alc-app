<script setup lang="ts">
import type { FirmwareDevice } from '~/utils/api'
import { listFirmwareDevices, updateFirmware } from '~/utils/api'
import { fetchLatestFirmwareVersions, hasFirmwareUpdate } from '~/utils/firmware-updates'

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
  latest.value = await fetchLatestFirmwareVersions()
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

function deviceName(d: FirmwareDevice): string {
  return d.label ?? d.device_id.slice(0, 8)
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
      報告している端末がありません。キオスクに CoreS3 を USB で繋ぎ、キオスクの画面を開いたままにしてください。
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
            <td class="px-3 py-2 whitespace-nowrap" data-col="name">{{ deviceName(d) }}</td>
            <td class="px-3 py-2 whitespace-nowrap" data-col="kind">{{ d.board ?? '-' }} / {{ d.flavor ?? '-' }}</td>
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
