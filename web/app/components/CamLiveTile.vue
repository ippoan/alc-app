<script setup lang="ts">
/**
 * 拠点カメラ 1 台ぶんのライブ表示タイル。`/cam-room/<roomId>` (roomId = alc_api.cameras.id) に
 * admin として繋ぎ、映像・接続状態・全画面を出す。カメラ一覧 (グリッド) と、単体の接続画面で共用する。
 * 切断は「切る」ボタン・unmount・`autoConnect` が false に戻ったとき。
 * カメラ (alc-cam の host) が首振りのデータチャネル `ptz` を出していれば、映像の上に方向ボタン
 * (押している間動く・離したら止まる) とプリセットを出す (`useCamPtz`)。出さない host ではボタンも出ない。
 * 音声 (alc-cam の host 0.4.4〜): カメラのマイクの音は既定でミュート、ボタンで鳴らす。「押して話す」は押している間だけ
 * 自分のマイクの声をカメラのスピーカーへ送る (`useCamTalk`)。音声を出さない host ではどちらのボタンも出ない。
 * 自己更新 (alc-cam の host 0.4.5〜): 拠点 PC の host と拡張の版を出し、「更新を確認」で拠点 PC に確認させる (`useCamUpdate`)。
 */
import type { PtzDir } from '~/composables/useCamPtz'

const props = withDefaults(defineProps<{
  roomId: string
  /** タイルの見出し (カメラ名など)。無ければ roomId を出す */
  label?: string
  /** true なら mount 時に自分で繋ぐ。false なら「接続」ボタンで繋ぐ */
  autoConnect?: boolean
  /**
   * 入室に付けるトークンの取り方。繋ぐたびに呼ぶ (期限は getter の側で扱う)。投げたらその文言を出す。
   * 無ければ管理者ログインの JWT (`useAuth().accessToken`)。遠隔点呼の画面は運行管理者席の鍵を渡す
   */
  getToken?: () => Promise<string | null>
  /**
   * 一斉更新の合図 (連番)。増えたら、拠点 PC が対応していれば (`useCamUpdate` の caps が来ていれば) 更新を確認させる。
   * カメラ一覧 (`CamLiveGrid`) の「一斉に更新を確認」が渡す
   */
  updateAllCount?: number
}>(), { label: undefined, autoConnect: false, getToken: undefined, updateAllCount: 0 })

const emit = defineEmits<{
  'update:active': [boolean]
  /** 拠点 PC が「更新を確認」に対応しているか (caps が来た / 消えた) */
  'update:updatable': [boolean]
}>()

const config = useRuntimeConfig()
const { accessToken } = useAuth()
const webRtc = useWebRtc('admin')
const ptz = useCamPtz(webRtc.ptzChannel)
const talk = useCamTalk(webRtc.ptzChannel, webRtc.camAudioSender)
const hostUpdate = useCamUpdate(webRtc.ptzChannel)

watch(() => !!hostUpdate.caps.value, v => emit('update:updatable', v))
watch(() => props.updateAllCount, () => {
  if (hostUpdate.caps.value) hostUpdate.check()
})

/** カメラの音を鳴らす (既定はミュート。自動再生の制限もあるのでボタンで解除する) */
const soundOn = ref(false)

/** 聞く音量 (0〜100)。見る人ごと・このブラウザに覚える (カメラの設定は変えない) */
const CAM_VOLUME_KEY = 'alc_cam_volume'
const volume = ref(readVolume())

function readVolume() {
  try {
    const saved = localStorage.getItem(CAM_VOLUME_KEY)
    const v = Number(saved)
    return saved !== null && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100
  }
  catch {
    return 100
  }
}

function onVolume(e: Event) {
  volume.value = Number((e.target as HTMLInputElement).value)
  try {
    localStorage.setItem(CAM_VOLUME_KEY, String(volume.value))
  }
  catch {
    // 保存できなくても今の画面では効く
  }
}

/** 方向ボタンの並び (3x3、真ん中はホーム) */
const PTZ_PAD: Array<PtzDir | 'home' | null> = [null, 'up', null, 'left', 'home', 'right', null, 'down', null]
const PTZ_ICON: Record<PtzDir | 'home', string> = { up: '▲', down: '▼', left: '◀', right: '▶', home: '●' }
const PTZ_LABEL: Record<PtzDir | 'home', string> = { up: '上へ', down: '下へ', left: '左へ', right: '右へ', home: 'ホームへ' }

function ptzShown(cell: PtzDir | 'home') {
  const caps = ptz.caps.value!
  return cell === 'home' ? caps.home : caps.dirs.includes(cell)
}

/** 押している間は動かす。指が外へずれても離すまで追えるよう pointer を捕まえる */
function onPtzPress(e: PointerEvent, cell: PtzDir | 'home') {
  if (cell === 'home') return ptz.home()
  ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  ptz.move(cell)
}

/** 押して話す: 首振りと同じく、指がずれても離すまで追う */
function onTalkPress(e: PointerEvent) {
  ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  talk.press()
}

const talkLabel = computed(() => talk.talking.value ? '話しています' : talk.holding.value ? '接続中...' : '押して話す')

const isActive = ref(false)
const isConnecting = ref(false)
const connectError = ref<string | null>(null)

const videoContainer = ref<HTMLElement | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
const isFullscreen = ref(false)

const signalingWsUrl = (config.public.signalingUrl as string).replace(/^https/, 'wss').replace(/^http:/, 'ws:')

/** 409 (視聴人数の上限・既に視聴中) はハンドシェイクで弾かれ、ブラウザには「接続エラー」としか見えない */
const SIGNALING_ERROR_HINT = '接続できませんでした。他の人が視聴中か、カメラが配信していない可能性があります'

/**
 * 切れたら (P2P の切断・シグナリングの切断・弾かれた) 畳んで繋ぎ直す。待ちは倍々で上限あり、映像が繋がったら最初に戻す。
 * 「切る」・unmount・`autoConnect` が false に戻ったときは繋ぎ直さない
 */
const RECONNECT_FIRST_MS = 3_000
const RECONNECT_MAX_MS = 60_000
/** 見ていたい (接続を押した・autoConnect)。切る・unmount で false */
let wanted = false
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = RECONNECT_FIRST_MS
const reconnecting = ref(false)

function cancelRetry() {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  reconnecting.value = false
}

function scheduleRetry() {
  if (!wanted || retryTimer) return
  reconnecting.value = true
  retryTimer = setTimeout(() => {
    retryTimer = null
    reconnecting.value = false
    open()
  }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS)
}

/** 接続ボタン・autoConnect から。待っている繋ぎ直しは今すぐにする */
function connect() {
  wanted = true
  cancelRetry()
  retryDelay = RECONNECT_FIRST_MS
  return open()
}

/** 切れた: 畳んで (次の接続は新しい PeerConnection で始める)、見ていたいなら繋ぎ直しを予約する */
function drop() {
  if (isActive.value) emit('update:active', false)
  isActive.value = false
  webRtc.disconnect()
  scheduleRetry()
}

async function open() {
  if (isActive.value || isConnecting.value) return
  connectError.value = null
  isConnecting.value = true
  let token: string | null
  try {
    token = props.getToken ? await props.getToken() : accessToken.value
  }
  catch (e) {
    connectError.value = e instanceof Error ? e.message : '接続に必要な認証情報を取得できませんでした'
    isConnecting.value = false
    scheduleRetry()
    return
  }
  if (!token) {
    connectError.value = 'ログインセッションが見つかりません。再ログインしてください。'
    isConnecting.value = false
    scheduleRetry()
    return
  }
  try {
    await webRtc.connect(signalingWsUrl, props.roomId, 'cam-room', token)
    isActive.value = true
    emit('update:active', true)
  }
  catch {
    connectError.value = '接続に失敗しました'
    scheduleRetry()
  }
  finally {
    isConnecting.value = false
  }
}

/** 切るボタン・unmount・autoConnect が false。繋ぎ直さない */
function disconnect() {
  wanted = false
  cancelRetry()
  webRtc.disconnect()
  if (isActive.value) emit('update:active', false)
  isActive.value = false
}

function toggleFullscreen() {
  if (!videoContainer.value) return
  if (!document.fullscreenElement) videoContainer.value.requestFullscreen()
  else document.exitFullscreen()
}

function onFullscreenChange() {
  isFullscreen.value = !!document.fullscreenElement
}

watch(() => webRtc.error.value, (e) => {
  if (!e) return
  connectError.value = e === 'シグナリングサーバー接続エラー' ? SIGNALING_ERROR_HINT : e
  // 弾かれた・P2P が切れた: 映像の枠を畳んで繋ぎ直す (P2P だけ切れた PeerConnection は使い回さない)
  if (isActive.value) drop()
})

// シグナリングが黙って閉じた (エラー無し)
watch(() => webRtc.isConnected.value, (now, before) => {
  if (before && !now && isActive.value) drop()
})

// 映像が繋がったら、次に切れたときの待ちを最初に戻す
watch(() => webRtc.isPeerConnected.value, (v) => {
  if (v) {
    retryDelay = RECONNECT_FIRST_MS
    connectError.value = null
  }
})

// video は繋がってから描画される。映像が先に届いていても付くよう、要素の出現も見る
watch([() => webRtc.remoteStream.value, videoRef], ([stream, el]) => {
  if (el) el.srcObject = stream
})

watch([volume, videoRef], ([v, el]) => {
  if (el) el.volume = v / 100
}, { immediate: true })

watch(() => props.autoConnect, (v) => {
  if (v) connect()
  else disconnect()
})

onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreenChange)
  if (props.autoConnect) connect()
})

onUnmounted(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  wanted = false
  cancelRetry()
  webRtc.disconnect()
})
</script>

<template>
  <div class="bg-white rounded-xl p-3 shadow-sm space-y-2" data-testid="cam-tile">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 text-sm min-w-0">
        <span
          class="w-2 h-2 rounded-full shrink-0"
          :class="!isActive ? 'bg-gray-300' : webRtc.isPeerConnected.value ? 'bg-green-500 animate-pulse' : 'bg-yellow-400 animate-pulse'"
        />
        <span class="font-medium text-gray-700 truncate" data-testid="cam-tile-label">{{ label ?? roomId }}</span>
        <span class="text-xs text-gray-500 shrink-0" data-testid="cam-tile-status">
          {{ isConnecting ? '接続中...' : reconnecting ? '再接続待ち...' : !isActive ? '停止中' : webRtc.isPeerConnected.value ? '受信中' : 'カメラ接続待ち...' }}
        </span>
      </div>
      <!-- 繋ぎ直しを待つ間は「切る」で止められる -->
      <button
        v-if="!isActive && !reconnecting"
        class="px-3 py-1 text-xs rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
        :disabled="isConnecting"
        data-testid="cam-tile-connect"
        @click="connect"
      >
        接続
      </button>
      <button
        v-else
        class="px-3 py-1 text-xs rounded-lg bg-red-100 hover:bg-red-200 text-red-700"
        data-testid="cam-tile-disconnect"
        @click="disconnect"
      >
        切る
      </button>
    </div>

    <div v-if="connectError" class="rounded-lg bg-red-50 border border-red-200 px-2 py-1 text-xs text-red-700" data-testid="cam-tile-error">
      {{ connectError }}
    </div>

    <div
      v-if="isActive && hostUpdate.caps.value"
      class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500"
      data-testid="cam-tile-update"
    >
      <span data-testid="cam-tile-update-versions">
        拠点 PC: host v{{ hostUpdate.caps.value.host }}・拡張 {{ hostUpdate.caps.value.extension ? `v${hostUpdate.caps.value.extension}` : '(不明)' }}
      </span>
      <button
        class="px-2 py-0.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
        :disabled="hostUpdate.state.value === 'checking'"
        data-testid="cam-tile-update-check"
        @click="hostUpdate.check()"
      >
        更新を確認
      </button>
      <span
        v-if="hostUpdate.message.value"
        :class="hostUpdate.state.value === 'failed' ? 'text-red-600' : 'text-gray-600'"
        data-testid="cam-tile-update-message"
      >
        {{ hostUpdate.message.value }}
      </span>
    </div>

    <div v-if="isActive" ref="videoContainer" class="relative group bg-black rounded-lg overflow-hidden">
      <video
        v-show="webRtc.remoteStream.value"
        ref="videoRef"
        autoplay
        playsinline
        :muted="!soundOn"
        class="w-full max-h-[70vh] object-contain mx-auto"
      />
      <div
        v-if="!webRtc.remoteStream.value"
        class="flex items-center justify-center h-40 text-gray-400 text-sm"
      >
        カメラ接続待ち...
      </div>
      <div
        v-if="ptz.caps.value && webRtc.remoteStream.value"
        class="absolute bottom-2 left-2 flex items-end gap-2 select-none touch-none"
        data-testid="cam-tile-ptz"
      >
        <div class="grid grid-cols-3 gap-1">
          <template v-for="(cell, i) in PTZ_PAD" :key="i">
            <button
              v-if="cell && ptzShown(cell)"
              class="w-9 h-9 rounded-lg text-white text-sm"
              :class="ptz.held.value === cell ? 'bg-blue-600/80' : 'bg-black/40 hover:bg-black/60'"
              :title="PTZ_LABEL[cell]"
              :aria-label="PTZ_LABEL[cell]"
              :data-testid="`cam-tile-ptz-${cell}`"
              @pointerdown.prevent="onPtzPress($event, cell)"
              @pointerup="ptz.stop()"
              @pointercancel="ptz.stop()"
              @lostpointercapture="ptz.stop()"
              @contextmenu.prevent
            >
              {{ PTZ_ICON[cell] }}
            </button>
            <span v-else class="w-9 h-9" />
          </template>
        </div>
        <div class="flex flex-col gap-1">
          <div v-if="ptz.caps.value.zoom" class="flex gap-1">
            <button
              v-for="z in (['in', 'out'] as const)"
              :key="z"
              class="w-9 h-9 rounded-lg bg-black/40 hover:bg-black/60 text-white text-sm"
              :title="z === 'in' ? 'ズームイン' : 'ズームアウト'"
              :data-testid="`cam-tile-ptz-zoom-${z}`"
              @click="ptz.zoom(z)"
            >
              {{ z === 'in' ? '＋' : '－' }}
            </button>
          </div>
          <div v-if="ptz.caps.value.presets.length" class="flex gap-1">
            <button
              v-for="n in ptz.caps.value.presets"
              :key="n"
              class="w-9 h-9 rounded-lg bg-black/40 hover:bg-black/60 text-white text-xs"
              :title="`プリセット ${n} へ`"
              :data-testid="`cam-tile-ptz-preset-${n}`"
              @click="ptz.preset(n)"
            >
              P{{ n }}
            </button>
          </div>
        </div>
      </div>
      <div class="absolute bottom-2 right-2 max-w-[60%] flex flex-col items-end gap-1">
        <div
          v-if="ptz.message.value"
          class="rounded bg-black/60 px-2 py-1 text-xs text-white"
          data-testid="cam-tile-ptz-message"
        >
          {{ ptz.message.value }}
        </div>
        <div
          v-if="talk.message.value"
          class="rounded bg-black/60 px-2 py-1 text-xs text-white"
          data-testid="cam-tile-talk-message"
        >
          {{ talk.message.value }}
        </div>
        <div
          v-if="talk.othersTalking.value"
          class="rounded bg-black/60 px-2 py-1 text-xs text-white"
          data-testid="cam-tile-talk-others"
        >
          他の人が話しています
        </div>
        <div v-if="webRtc.camAudioSender.value && webRtc.remoteStream.value" class="flex items-center gap-1 select-none touch-none">
          <input
            v-if="soundOn"
            type="range"
            min="0"
            max="100"
            step="5"
            :value="volume"
            class="w-24 accent-blue-500"
            :title="`音量 ${volume}%`"
            aria-label="カメラの音量"
            data-testid="cam-tile-volume"
            @input="onVolume"
          >
          <button
            class="h-9 px-2 rounded-lg text-white text-xs"
            :class="soundOn ? 'bg-blue-600/80' : 'bg-black/40 hover:bg-black/60'"
            :title="soundOn ? 'カメラの音を消す' : 'カメラの音を聞く'"
            :aria-pressed="soundOn"
            data-testid="cam-tile-sound"
            @click="soundOn = !soundOn"
          >
            {{ soundOn ? '🔊 音あり' : '🔇 音なし' }}
          </button>
          <button
            v-if="talk.canTalk.value"
            class="h-9 px-3 rounded-lg text-white text-xs"
            :class="talk.talking.value ? 'bg-red-600/90' : talk.holding.value ? 'bg-red-400/80' : 'bg-black/40 hover:bg-black/60'"
            title="押している間、カメラのスピーカーから自分の声が出ます"
            data-testid="cam-tile-talk"
            @pointerdown.prevent="onTalkPress"
            @pointerup="talk.release()"
            @pointercancel="talk.release()"
            @lostpointercapture="talk.release()"
            @contextmenu.prevent
          >
            🎙 {{ talkLabel }}
          </button>
        </div>
      </div>
      <button
        class="absolute top-2 right-2 p-1.5 rounded-lg bg-black/40 hover:bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
        :title="isFullscreen ? '全画面解除' : '全画面表示'"
        data-testid="cam-tile-fullscreen"
        @click="toggleFullscreen"
      >
        <svg v-if="!isFullscreen" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
        <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M9 9V4m0 5H4m16 0h-5m5 0V4M9 15v5m0-5H4m16 0h-5m5 0v5" />
        </svg>
      </button>
    </div>
  </div>
</template>
