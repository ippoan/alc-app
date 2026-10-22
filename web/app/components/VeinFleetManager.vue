<script setup lang="ts">
import type { VeinFleetDevice } from '~/utils/api'
import { getEmployees, listVeinFleet, requestVeinFleet } from '~/utils/api'

/**
 * 全端末の指静脈の一覧 (Refs ippoan/alc-app#436)。各キオスクのモジュールの ID ↔ 乗務員の対応表を並べる。
 *
 * 開いたとき (と「最新を取る」) に、購読中の全キオスクへ WebSocket で合図を出す。キオスクが報告すると
 * 「更新した」の合図が WebSocket で届くので、そのたびに一覧を引き直す。合図に中身は載らない
 * (一覧は `GET /api/vein-fleet`)。生体データ (記録の中身) は扱わない
 */

/** モジュールの ID の数 (10〜100) */
const CAPACITY = 91

const devices = ref<VeinFleetDevice[]>([])
const names = ref(new Map<string, string>())
const listError = ref('')
const notice = ref('')

async function loadList() {
  try {
    devices.value = (await listVeinFleet()).devices
    listError.value = ''
  }
  catch (e) {
    listError.value = e instanceof Error ? e.message : '一覧を取得できませんでした'
  }
}

async function requestLatest() {
  try {
    const { sent } = await requestVeinFleet()
    notice.value = sent === 0
      ? 'いま繋がっている端末がありません (前回の報告を出しています)'
      : `${sent} 台の端末に問い合わせました`
  }
  catch (e) {
    notice.value = e instanceof Error ? e.message : '問い合わせに失敗しました'
  }
}

const { accessToken } = useAuth()
const fleetWatch = useTimecardWatch({
  getToken: () => accessToken.value,
  onVeinListUpdated: () => { void loadList() },
})

onMounted(async () => {
  void fleetWatch.connect()
  try {
    names.value = new Map((await getEmployees()).map(e => [e.id, e.name]))
  }
  catch {
    // 名前が引けなくても ID と対応は出す
  }
  await loadList()
  await requestLatest()
})

function deviceName(d: VeinFleetDevice): string {
  return d.label ?? d.device_id.slice(0, 8)
}

function nameOf(employeeId: string): string {
  return names.value.get(employeeId) ?? `(名前不明 ${employeeId.slice(0, 8)})`
}

function sortedEntries(d: VeinFleetDevice) {
  return [...d.entries].sort((a, b) => a.module_id - b.module_id)
}

/** モジュールの登録人数と対応表の件数が違う */
function mismatch(d: VeinFleetDevice): boolean {
  return d.module_users !== undefined && d.module_users !== d.entries.length
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-bold text-gray-800">端末の指静脈</h2>
      <button class="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm" data-testid="vein-fleet-request" @click="requestLatest">
        最新を取る
      </button>
    </div>
    <p v-if="listError" class="text-sm text-red-600" data-testid="vein-fleet-error">{{ listError }}</p>
    <p v-if="notice" class="text-sm text-blue-700" data-testid="vein-fleet-notice">{{ notice }}</p>

    <p v-if="devices.length === 0" class="text-center py-8 text-gray-400" data-testid="vein-fleet-empty">
      報告した端末がありません
    </p>
    <section v-for="d in devices" :key="d.device_id" class="border rounded-lg p-3 bg-white" data-testid="vein-fleet-device">
      <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-2">
        <h3 class="font-semibold text-gray-800">{{ deviceName(d) }}</h3>
        <span class="text-sm text-gray-600">{{ d.entries.length }} 人 (空き {{ CAPACITY - d.entries.length }} / {{ CAPACITY }})</span>
        <span class="text-sm text-gray-600">モジュール {{ d.module_users !== undefined ? `${d.module_users} 人` : '-' }}</span>
        <span class="text-xs text-gray-400">{{ new Date(d.reported_at_ms).toLocaleString('ja-JP') }} の報告</span>
      </div>
      <p v-if="mismatch(d)" class="mb-2 text-sm text-amber-700" data-testid="vein-fleet-mismatch">
        モジュールと対応表の人数が食い違っています
      </p>
      <table v-if="d.entries.length" class="w-full text-sm">
        <thead>
          <tr class="bg-gray-100 text-gray-600 text-xs">
            <th class="px-2 py-1 text-left w-16">ID</th>
            <th class="px-2 py-1 text-left">乗務員</th>
            <th class="px-2 py-1 text-left w-24">状態</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in sortedEntries(d)" :key="e.module_id" class="border-t" data-testid="vein-fleet-row">
            <td class="px-2 py-1 tabular-nums">{{ e.module_id }}</td>
            <td class="px-2 py-1">{{ nameOf(e.employee_id) }}</td>
            <td class="px-2 py-1">{{ e.approved ? '承認済み' : '承認待ち' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="text-sm text-gray-400">まだ誰も入っていません</p>
    </section>
  </div>
</template>
