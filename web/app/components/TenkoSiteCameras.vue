<script setup lang="ts">
import { listCamClipsCamerasForTenko, MANAGER_DEVICE_AUTH_FAILED_MESSAGE } from '~/utils/api'
import { selectSendToken } from '~/utils/token-selection'
import type { CamClipsCameraSummary } from '~/utils/cam-clips'
import { errorText } from '~/utils/cam-clips'

/**
 * 遠隔点呼の通話中に、乗務員の端末 (kiosk) が置かれた拠点のカメラを映す。
 * kiosk が申告した端末 ID を `device_ids` に含むカメラを全部 `CamLiveTile` (roomId = camera.id) で出す。
 * 通話を終えて外される (unmount) と、タイルごと切れる。端末 ID が変わったら引き直す。
 */
const props = defineProps<{ deviceId: string }>()

const { accessToken } = useAuth()
const { getManagerJwt } = useManagerDeviceToken()

/**
 * cam-room への入室に付けるトークン。カメラ一覧 (`'manager-device'` の口) と同じ規則 —
 * 管理者ログインがあればその JWT、無ければ運行管理者席の鍵 (期限・再取得は getManagerJwt が持つ)
 */
async function getSeatToken(): Promise<string> {
  const token = await selectSendToken(accessToken.value, 'manager-device', getManagerJwt)
  if (!token) throw new Error(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
  return token
}

const cameras = ref<CamClipsCameraSummary[]>([])
const loading = ref(true)
const error = ref('')

async function load(deviceId: string) {
  loading.value = true
  error.value = ''
  try {
    const { cameras: all } = await listCamClipsCamerasForTenko()
    // 待つあいだに別の端末に変わっていたら、古い結果は捨てる
    if (deviceId !== props.deviceId) return
    cameras.value = all.filter(c => c.device_ids.includes(deviceId))
  }
  catch (e) {
    if (deviceId !== props.deviceId) return
    cameras.value = []
    error.value = errorText(e, 'カメラの一覧を取得できませんでした')
  }
  loading.value = false
}

watch(() => props.deviceId, id => load(id), { immediate: true })
</script>

<template>
  <div class="space-y-2" data-testid="site-cameras">
    <h3 class="text-xs font-semibold text-gray-300">拠点カメラ</h3>
    <p v-if="loading" class="text-xs text-gray-400" data-testid="site-cameras-loading">読み込み中...</p>
    <div v-else-if="error" class="rounded-lg bg-red-50 border border-red-200 px-2 py-1 text-xs text-red-700" data-testid="site-cameras-error">
      {{ error }}
    </div>
    <p v-else-if="cameras.length === 0" class="text-xs text-gray-400" data-testid="site-cameras-empty">
      この端末に紐づくカメラはありません
    </p>
    <div v-else class="flex gap-2 overflow-x-auto">
      <CamLiveTile
        v-for="c in cameras"
        :key="c.id"
        :room-id="c.id"
        :label="c.name"
        :auto-connect="true"
        :get-token="getSeatToken"
        class="w-80 shrink-0"
      />
    </div>
  </div>
</template>
