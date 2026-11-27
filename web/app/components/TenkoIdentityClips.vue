<script setup lang="ts">
/**
 * 点呼の詳細の「本人確認のときの録画」(自己点検表 ト①「生体認証をする時の顔の画像」。Refs ippoan/alc-app#720)。
 * 点呼の本人確認 (指静脈の照合。開始と再開) ごとに、そのときの監視カメラの切り出しを再生する。
 * 監視カメラを結び付けていない端末・まだ切っていない本人確認は「録画なし」。端末のカメラで撮った顔写真はここには出さない
 */
import { fetchCamClip, listTenkoIdentityClips, type RequestTokenScope } from '~/utils/api'
import { formatJst, type TenkoIdentityClips } from '~/utils/cam-clips'

const props = withDefaults(defineProps<{
  sessionId: string
  /** 取得に使う鍵 (遠隔点呼モニターは 'tenko-monitor') */
  scope?: RequestTokenScope
}>(), { scope: 'tenko-monitor' })

const items = ref<TenkoIdentityClips[]>([])
const loading = ref(true)
const loadError = ref(false)
/** 再生中の切り出しのキーと object URL */
const playingKey = ref<string | null>(null)
const playingSrc = ref('')
const playError = ref('')
let playSeq = 0

const PHASE_LABEL: Record<TenkoIdentityClips['phase'], string> = { start: '開始', resume: '再開' }

onMounted(async () => {
  try {
    items.value = await listTenkoIdentityClips(props.sessionId, props.scope)
  }
  catch {
    loadError.value = true
  }
  finally {
    loading.value = false
  }
})

async function play(key: string) {
  closePlayer()
  playingKey.value = key
  const seq = playSeq
  const url = await fetchCamClip(key, props.scope)
  // 取り終える前に閉じた・別の切り出しを押した: 使わない URL は捨てる
  if (seq !== playSeq) {
    if (url) URL.revokeObjectURL(url)
    return
  }
  if (url) playingSrc.value = url
  else playError.value = '録画を取得できませんでした'
}

function closePlayer() {
  playSeq += 1
  if (playingSrc.value) URL.revokeObjectURL(playingSrc.value)
  playingSrc.value = ''
  playError.value = ''
  playingKey.value = null
}

onUnmounted(closePlayer)
</script>

<template>
  <div class="bg-gray-50 rounded-lg p-3" data-testid="identity-clips">
    <h4 class="font-medium text-gray-700 mb-1">本人確認のときの録画</h4>
    <p v-if="loading" class="text-xs text-gray-500">読み込み中...</p>
    <p v-else-if="loadError" class="text-xs text-red-600" data-testid="identity-clips-error">録画の一覧を取得できませんでした</p>
    <p v-else-if="items.length === 0" class="text-xs text-gray-500" data-testid="identity-clips-empty">本人確認の記録はありません</p>
    <ul v-else class="space-y-1">
      <li v-for="it in items" :key="it.id" class="text-xs text-gray-700" data-testid="identity-clips-item">
        <span>{{ PHASE_LABEL[it.phase] }} {{ formatJst(it.occurred_at) }}</span>
        <span v-if="it.method === 'vein'" class="ml-1 text-gray-500">(指静脈)</span>
        <template v-if="it.clips.length > 0">
          <template v-for="c in it.clips" :key="c.clip_id">
            <button
              v-if="c.status === 'ready'"
              class="ml-2 text-blue-600 underline"
              data-testid="identity-clips-play"
              @click="play(c.key)"
            >
              {{ c.camera_name ?? 'カメラ' }}の録画を再生
            </button>
            <span v-else class="ml-2 text-gray-500">{{ c.camera_name ?? 'カメラ' }}: 切り出しできませんでした</span>
          </template>
        </template>
        <span v-else class="ml-2 text-gray-400">録画なし</span>
      </li>
    </ul>
    <div v-if="playingKey" class="mt-2" data-testid="identity-clips-player">
      <video v-if="playingSrc" :src="playingSrc" controls autoplay class="w-full rounded-lg" />
      <p v-else-if="playError" class="text-xs text-red-600">{{ playError }}</p>
      <p v-else class="text-xs text-gray-500">録画を取得しています...</p>
      <button class="mt-1 text-xs text-gray-500 underline" data-testid="identity-clips-close" @click="closePlayer">閉じる</button>
    </div>
  </div>
</template>
