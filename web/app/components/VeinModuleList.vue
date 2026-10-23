<script setup lang="ts">
import type { ApiEmployee } from '~/types'
import { getEmployees } from '~/utils/api'
import { loadVeinModuleEntries } from '~/utils/vein-db'
import type { VeinModuleEntry } from '~/utils/vein-db'
import { VEIN_MODULE_ID_MAX, VEIN_MODULE_ID_MIN } from '~/utils/vein-module'
import { decodeJwtPayloadFromToken } from '@ippoan/auth-client'
import { sameVeinDevice, veinDeviceLabel } from '~/utils/vein-device-label'

/**
 * この端末の指静脈の一覧 (Refs ippoan/alc-app#436)。モジュールの ID (10〜100) ↔ 乗務員の対応表
 * (このブラウザの IndexedDB) と、モジュール自身が答える登録人数を並べる。
 * ID の空きが無い・モジュールと対応表の人数が食い違う (モジュールを入れ替えた等) ときに気づくための画面。
 * 生体データ (記録の中身) は出さない
 */

const emit = defineEmits<{ close: [] }>()

const veinSerial = useVeinSerial()
const entries = ref<VeinModuleEntry[]>([])
const names = ref(new Map<string, string>())
const moduleInfo = ref<{ users: number; max: number } | null>(null)
const moduleError = ref<string | null>(null)
const loading = ref(true)
/** この端末の id (端末の token の sub)。取れなければ null。「この端末で登録した記録」の印に使う */
const ownDeviceId = ref<string | null>(null)

const capacity = VEIN_MODULE_ID_MAX - VEIN_MODULE_ID_MIN + 1
const sorted = computed(() => [...entries.value].sort((a, b) => a.moduleId - b.moduleId))
const free = computed(() => capacity - entries.value.length)
/** モジュールの人数と対応表の件数が違う (入れ替え・初期化・書きかけ) */
const mismatch = computed(() => moduleInfo.value !== null && moduleInfo.value.users !== entries.value.length)

async function load() {
  loading.value = true
  moduleError.value = null
  entries.value = await loadVeinModuleEntries()
  try {
    const emps: ApiEmployee[] = await getEmployees('bp-station')
    names.value = new Map(emps.map(e => [e.id, e.name]))
  }
  catch {
    // 名前が引けなくても ID と対応は出す
  }
  try {
    const token = await useDeviceToken().getDeviceJwt()
    const sub = token ? (decodeJwtPayloadFromToken(token) as { sub?: unknown } | null)?.sub : null
    ownDeviceId.value = typeof sub === 'string' ? sub : null
  }
  catch {
    ownDeviceId.value = null
  }
  try {
    moduleInfo.value = await veinSerial.syncInfo()
  }
  catch (e) {
    moduleInfo.value = null
    moduleError.value = `モジュールの登録人数を読めませんでした (${(e as Error).message})`
  }
  loading.value = false
}

onMounted(load)

function nameOf(entry: VeinModuleEntry): string {
  return names.value.get(entry.employeeId) ?? `(名前不明 ${entry.employeeId.slice(0, 8)})`
}

/** いちばん新しい記録の版 (`updatedAt` の最大)。人数が多いと表から探せないので要約に出す */
const latest = computed(() =>
  entries.value.reduce<VeinModuleEntry | null>((max, e) => (!max || e.updatedAt > max.updatedAt ? e : max), null),
)

function registeredOf(entry: VeinModuleEntry): string {
  const label = veinDeviceLabel(entry.registeredDeviceId)
  return sameVeinDevice(entry.registeredDeviceId, ownDeviceId.value) ? `${label} (この端末)` : label
}

function versionOf(entry: VeinModuleEntry): string {
  const d = new Date(entry.updatedAt)
  return Number.isNaN(d.getTime()) ? entry.updatedAt : d.toLocaleString('ja-JP')
}
</script>

<template>
  <div class="bg-white rounded-2xl p-4 shadow-sm">
    <h2 class="text-lg font-semibold text-gray-700 mb-3">この端末の指静脈</h2>
    <p v-if="loading" class="text-sm text-gray-500">読み込み中...</p>
    <template v-else>
      <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mb-3" data-testid="vein-module-summary">
        <dt class="text-gray-500">対応表の人数</dt>
        <dd>{{ entries.length }} 人 (空き {{ free }} / {{ capacity }})</dd>
        <dt class="text-gray-500">モジュールの登録人数</dt>
        <dd>{{ moduleInfo ? `${moduleInfo.users} 人 (上限 ${moduleInfo.max})` : '-' }}</dd>
        <dt class="text-gray-500">最終の記録の版</dt>
        <dd data-testid="vein-module-latest">{{ latest ? `${versionOf(latest)} (ID ${latest.moduleId})` : '-' }}</dd>
      </dl>
      <p v-if="moduleError" class="mb-3 text-sm text-red-600">{{ moduleError }}</p>
      <p v-if="mismatch" data-testid="vein-module-mismatch" class="mb-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
        モジュールと対応表の人数が食い違っています。次の同期で書き直されます (モジュールを入れ替えた・初期化した場合など)
      </p>
      <p v-if="free === 0" class="mb-3 text-sm text-red-600">ID の空きがありません。新しい人の記録を書けません</p>
      <table v-if="sorted.length" class="w-full text-sm" data-testid="vein-module-table">
        <thead>
          <tr class="text-left text-gray-500 border-b">
            <th class="py-1 pr-2">ID</th>
            <th class="py-1 pr-2">乗務員</th>
            <th class="py-1 pr-2">状態</th>
            <th class="py-1 pr-2">登録した端末</th>
            <th class="py-1">記録の版</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in sorted" :key="e.moduleId" class="border-b last:border-0">
            <td class="py-1 pr-2 font-mono">{{ e.moduleId }}</td>
            <td class="py-1 pr-2">{{ nameOf(e) }}</td>
            <td class="py-1 pr-2">{{ e.approved ? '承認済み' : '承認待ち' }}</td>
            <td class="py-1 pr-2" data-testid="vein-module-registered">{{ registeredOf(e) }}</td>
            <td class="py-1 text-gray-500">{{ versionOf(e) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="text-sm text-gray-500">この端末のモジュールには、まだ誰も入っていません</p>
    </template>
    <div class="mt-4 flex gap-2">
      <button class="flex-1 px-4 py-3 bg-white border border-gray-300 text-gray-700 rounded-xl font-medium hover:bg-gray-50" :disabled="loading" @click="load">
        読み直す
      </button>
      <button class="flex-1 px-4 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700" @click="emit('close')">
        閉じる
      </button>
    </div>
  </div>
</template>
