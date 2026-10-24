<script setup lang="ts">
import { listCamClipsCameras, listCamClipsEvents, listCamHostKeys, listDeviceLabels, runCamClipsAuto } from '~/utils/api'
import type { CamClipsCamera, CamClipsEvent, KnownDeviceName } from '~/utils/cam-clips'
import { clipSrc, deviceDisplayName, errorText, eventKindLabel, formatJst, summarizeAutoRun } from '~/utils/cam-clips'
import { FETCH_TIMEOUT_MESSAGE_WRITE } from '~/utils/fetch-timeout'
import { jstTodayDate } from '~/utils/jst'

/**
 * 拠点カメラの自動切り出しの一覧 (Refs ippoan/alc-cam#2)。カメラと JST の日付を選ぶと、
 * その日のイベント (アルコール・血圧・打刻・免許証・指静脈登録) と切り出しの結果を時刻順に出す。読み取りだけ。
 * 再生は押した行の 1 本だけをモーダルで出す (同じ clip が複数のイベントに付くので、行ごとには並べない)。
 * 閉じるのは閉じるボタン・背景クリック・Esc。閉じると video は DOM から外れ、再生が止まる。
 */

const cameras = ref<CamClipsCamera[]>([])
const cameraId = ref('')
const date = ref(jstTodayDate())
const events = ref<CamClipsEvent[]>([])
const loaded = ref(false)
const error = ref('')
const running = ref(false)
const runResult = ref('')
const playing = ref<{ sourceId: string, key: string, occurredAt: string, kind: CamClipsEvent['kind'] } | null>(null)
const labels = ref<KnownDeviceName[]>([])

/** 端末の表示名。取れなくても一覧は出す (名前が「名前未登録の端末」になるだけ) */
onMounted(async () => {
  const [reg, keys] = await Promise.allSettled([listDeviceLabels(), listCamHostKeys()])
  labels.value = [
    ...(reg.status === 'fulfilled' ? reg.value.devices : []),
    ...(keys.status === 'fulfilled' ? keys.value.names ?? [] : []),
  ]
})

async function loadEvents() {
  playing.value = null
  if (!cameraId.value || !date.value) return
  try {
    events.value = await listCamClipsEvents(cameraId.value, date.value)
    error.value = ''
  }
  catch (e) {
    events.value = []
    error.value = errorText(e, 'イベントを取得できませんでした')
  }
  loaded.value = true
}

onMounted(async () => {
  try {
    cameras.value = (await listCamClipsCameras()).cameras
  }
  catch (e) {
    error.value = errorText(e, 'カメラの一覧を取得できませんでした')
    return
  }
  if (cameras.value.length === 1) cameraId.value = cameras.value[0]!.id
})

watch([cameraId, date], loadEvents)

/** cron (毎時 0 分) と同じ自動切り出しを、選んだカメラで今すぐ回す */
async function runNow() {
  running.value = true
  runResult.value = ''
  try {
    runResult.value = summarizeAutoRun((await runCamClipsAuto(cameraId.value)).cameras[0]!)
    await loadEvents()
  }
  catch (e) {
    const msg = errorText(e, '切り出しを実行できませんでした')
    error.value = msg === FETCH_TIMEOUT_MESSAGE_WRITE
      ? '時間がかかっています。裏で続いている可能性があるので、少し後に一覧を更新してください'
      : msg
  }
  finally {
    running.value = false
  }
}

function play(ev: CamClipsEvent) {
  playing.value = { sourceId: ev.source_id, key: ev.clip!.key, occurredAt: ev.occurred_at, kind: ev.kind }
}

function closePlayer() {
  playing.value = null
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closePlayer()
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="bg-white rounded-xl p-4 shadow-sm space-y-3 mt-4" data-testid="cam-clips-events">
    <h3 class="font-bold text-sm">自動切り出しの一覧</h3>
    <div class="flex flex-wrap items-end gap-3 text-sm">
      <label>
        カメラ
        <select v-model="cameraId" class="block border rounded px-2 py-1" data-testid="cam-clips-events-camera">
          <option value="">(選んでください)</option>
          <option v-for="c in cameras" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </label>
      <button
        class="px-3 py-1 rounded bg-blue-600 text-white disabled:opacity-50"
        :disabled="!cameraId || running"
        data-testid="cam-clips-events-run"
        @click="runNow"
      >
        {{ running ? '切り出し中…' : '今すぐ切り出す' }}
      </button>
      <label>
        日付 (JST)
        <input v-model="date" type="date" class="block border rounded px-2 py-1" data-testid="cam-clips-events-date">
      </label>
    </div>
    <p v-if="runResult" class="text-sm text-gray-700" data-testid="cam-clips-events-run-result">{{ runResult }}</p>
    <p v-if="error" class="text-sm text-red-600" data-testid="cam-clips-events-error">{{ error }}</p>
    <p v-else-if="loaded && events.length === 0" class="text-sm text-gray-500" data-testid="cam-clips-events-empty">
      この日のイベントはありません
    </p>
    <div v-else-if="events.length > 0" class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-gray-500">
            <th class="py-1 pr-3">時刻</th>
            <th class="py-1 pr-3">種類</th>
            <th class="py-1 pr-3">端末</th>
            <th class="py-1">切り出し</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ev in events" :key="ev.source_id" class="border-t" data-testid="cam-clips-events-row">
            <td class="py-2 pr-3" data-testid="cam-clips-events-time">{{ formatJst(ev.occurred_at) }}</td>
            <td class="py-2 pr-3" data-testid="cam-clips-events-kind">{{ eventKindLabel(ev.kind) }}</td>
            <td class="py-2 pr-3">
              <span class="font-semibold" data-testid="cam-clips-events-device-name">{{ deviceDisplayName(ev.device_id, labels) }}</span>
              <span
                v-if="ev.is_dev"
                class="ml-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-xs"
                data-testid="cam-clips-events-dev"
              >開発端末</span>
              <span class="block text-xs text-gray-500 font-mono" data-testid="cam-clips-events-device">{{ ev.device_id }}</span>
            </td>
            <td class="py-2">
              <span v-if="ev.clip === null" class="text-gray-500" data-testid="cam-clips-events-none">未切り出し</span>
              <span v-else-if="ev.clip.status === 'failed'" class="text-red-600" data-testid="cam-clips-events-failed">
                失敗<template v-if="ev.clip.error">: {{ ev.clip.error }}</template>
              </span>
              <button
                v-else
                class="text-xs text-blue-700 underline"
                data-testid="cam-clips-events-play"
                @click="play(ev)"
              >
                再生
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div
      v-if="playing"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="cam-clips-events-modal"
      @click.self="closePlayer"
    >
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-3xl mx-4 p-4 space-y-3">
        <div class="flex items-center justify-between">
          <h4 class="font-bold text-sm">{{ formatJst(playing.occurredAt) }} {{ eventKindLabel(playing.kind) }}</h4>
          <button
            class="px-3 py-1 rounded border text-sm"
            data-testid="cam-clips-events-modal-close"
            @click="closePlayer"
          >
            閉じる
          </button>
        </div>
        <video
          :src="clipSrc(playing.key)"
          controls
          autoplay
          preload="metadata"
          class="w-full bg-black"
          data-testid="cam-clips-events-video"
        />
      </div>
    </div>
  </div>
</template>
