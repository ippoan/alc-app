<script setup lang="ts">
import { getDeviceKeyStatus } from '~/utils/api'
import { errorText, formatJst } from '~/utils/cam-clips'
import {
  COUNT_LABELS, DEFAULT_DEVICE_KEY_STATUS_DAYS, DEVICE_KEY_STATUS_DAYS, NOTE_BEFORE_RECORDING,
  kindLabel, rowWarnings, unattributedWarning,
  type DeviceKeyStatus,
} from '~/utils/device-key-status'

/**
 * 管理画面「端末の鍵の状態」(Refs ippoan/alc-cam#2、設計書 §7.2)。
 * 本番のキオスク・測定台・CoreS3 が機体の鍵で記録を送っているかを、期間ごとに確かめる。
 * 文言と判定は `~/utils/device-key-status`、端末の名前は `useDeviceNames` (名前の正本は鍵のラベル)。
 */
const { nameOf, ready: namesReady } = useDeviceNames()

const days = ref<number>(DEFAULT_DEVICE_KEY_STATUS_DAYS)
const status = ref<DeviceKeyStatus | null>(null)
const loading = ref(false)
const error = ref('')

/** 期間を変えて重ねて押したとき、遅れて返った古い応答で上書きしない */
let seq = 0

async function load() {
  const mine = ++seq
  loading.value = true
  try {
    const res = await getDeviceKeyStatus(days.value)
    if (mine !== seq) return
    status.value = res
    error.value = ''
  }
  catch (e) {
    if (mine !== seq) return
    status.value = null
    error.value = errorText(e, '端末の鍵の状態を取得できませんでした')
  }
  finally {
    if (mine === seq) loading.value = false
  }
}

onMounted(() => Promise.all([load(), namesReady]))
watch(days, load)

const unattributed = computed(() => (status.value ? unattributedWarning(status.value) : null))
</script>

<template>
  <div class="space-y-4" data-testid="device-key-status">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-lg font-bold text-gray-800">端末の鍵の状態</h2>
      <label class="text-sm text-gray-600">
        期間
        <select v-model.number="days" class="ml-1 border rounded px-2 py-1 text-sm" data-testid="device-key-status-days">
          <option v-for="d in DEVICE_KEY_STATUS_DAYS" :key="d" :value="d">直近 {{ d }} 日</option>
        </select>
      </label>
      <button class="text-sm text-blue-600 hover:underline" data-testid="device-key-status-reload" @click="load">再読み込み</button>
    </div>

    <p v-if="error" class="text-sm text-red-600" role="alert" data-testid="device-key-status-error">{{ error }}</p>
    <p v-else-if="loading && !status" class="text-sm text-gray-500" data-testid="device-key-status-loading">読み込み中…</p>

    <template v-if="status">
      <p v-if="unattributed" class="text-sm bg-yellow-50 border border-yellow-300 text-yellow-800 rounded px-3 py-2" data-testid="device-key-status-unattributed">
        {{ unattributed }}
        <span class="text-xs">(最終: {{ formatJst(status.unattributed.last_at) }})</span>
      </p>

      <p v-if="status.devices.length === 0" class="text-sm text-gray-500" data-testid="device-key-status-empty">
        この期間に記録のある端末はありません。
      </p>
      <div v-else class="overflow-x-auto">
        <table class="min-w-full text-sm border">
          <thead class="bg-gray-100 text-left">
            <tr>
              <th class="px-2 py-1">端末</th>
              <th class="px-2 py-1">鍵の種類</th>
              <th class="px-2 py-1">最終の記録 (JST)</th>
              <th v-for="c in COUNT_LABELS" :key="c.key" class="px-2 py-1 text-right">{{ c.label }}</th>
              <th class="px-2 py-1">警告と直し方</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in status.devices" :key="row.device_id" class="border-t align-top" data-testid="device-key-status-row">
              <td class="px-2 py-1">
                <span :title="row.device_id" data-testid="device-key-status-name">{{ nameOf(row.device_id) }}</span>
                <span v-if="row.is_dev" class="ml-1 text-xs bg-purple-100 text-purple-700 rounded px-1" data-testid="device-key-status-dev">開発用</span>
              </td>
              <td class="px-2 py-1" data-testid="device-key-status-kind">{{ kindLabel(row.kind) }}</td>
              <td class="px-2 py-1 whitespace-nowrap" data-testid="device-key-status-last">{{ formatJst(row.last_at) }}</td>
              <td v-for="c in COUNT_LABELS" :key="c.key" class="px-2 py-1 text-right tabular-nums" :data-testid="`device-key-status-count-${c.key}`">{{ row.counts[c.key] }}</td>
              <td class="px-2 py-1 text-yellow-800">
                <p v-for="w in rowWarnings(row)" :key="w" data-testid="device-key-status-warning">{{ w }}</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <p class="text-xs text-gray-500" data-testid="device-key-status-note">{{ NOTE_BEFORE_RECORDING }}</p>
  </div>
</template>
