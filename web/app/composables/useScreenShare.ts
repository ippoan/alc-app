import { screenShareRoomId } from '~/utils/it-tenko'

/** 「管理者が画面共有を終了しました」を出しておく時間 */
export const SCREEN_SHARE_ENDED_NOTICE_MS = 5000

export function useScreenShare() {
  const webRtc = useWebRtc('device')

  const isSharing = ref(false)
  /** 「画面共有」を押してから、共有が始まる (`isSharing`) か失敗して抜けるまで */
  const isStarting = ref(false)
  const roomId = ref<string | null>(null)
  const error = ref<string | null>(null)

  const isMuted = ref(false)
  /** 運行管理者の「画面共有を終了」で止まった直後か (数秒で false に戻る) */
  const endedByAdmin = ref(false)

  let screenStream: MediaStream | null = null
  let micStream: MediaStream | null = null
  let endedTimer: ReturnType<typeof setTimeout> | null = null

  function clearEndedNotice() {
    if (endedTimer) { clearTimeout(endedTimer); endedTimer = null }
    endedByAdmin.value = false
  }

  async function startSharing(signalingUrl: string) {
    isStarting.value = true
    try {
      await beginSharing(signalingUrl)
    } finally {
      isStarting.value = false
    }
  }

  async function beginSharing(signalingUrl: string) {
    error.value = null
    clearEndedNotice()
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'monitor' }, audio: false })
    } catch {
      error.value = '画面共有の許可が得られませんでした'
      return
    }

    // ユーザーが共有停止ボタンを押した場合
    const videoTrack = screenStream.getVideoTracks()[0]
    if (videoTrack) {
      videoTrack.onended = () => stopSharing()
    }

    // マイク音声を取得して合成
    let streamToSend: MediaStream = screenStream
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      streamToSend = new MediaStream([
        ...screenStream.getVideoTracks(),
        ...micStream.getAudioTracks(),
      ])
    } catch (e) {
      console.warn('[ScreenShare] getUserMedia failed, continuing without mic:', e)
    }

    const id = screenShareRoomId(crypto.randomUUID())
    roomId.value = id

    const wsUrl = signalingUrl.replace(/^https/, 'wss').replace(/^http:/, 'ws:')
    try {
      await webRtc.connect(wsUrl, id)
      await webRtc.startStreaming(streamToSend)
      isSharing.value = true
    } catch {
      screenStream.getTracks().forEach(t => t.stop())
      screenStream = null
      micStream?.getTracks().forEach(t => t.stop())
      micStream = null
      roomId.value = null
      error.value = 'シグナリングサーバーへの接続に失敗しました'
    }
  }

  function toggleMute() {
    isMuted.value = !isMuted.value

    // Android bridge: OS レベルでマイクミュート
    const android = (window as any).Android
    if (android?.setMicMuted) {
      android.setMicMuted(isMuted.value)
    }

    // Web 標準: track.enabled でミュート
    if (micStream) {
      for (const track of micStream.getAudioTracks()) {
        track.enabled = !isMuted.value
      }
    }
  }

  function stopSharing() {
    screenStream?.getTracks().forEach(t => t.stop())
    screenStream = null
    micStream?.getTracks().forEach(t => t.stop())
    micStream = null
    webRtc.disconnect()
    isSharing.value = false
    roomId.value = null
    isMuted.value = false
  }

  // 運行管理者が「画面共有を終了」を押した: 共有を止め、その旨を数秒出す。
  // 見る側が抜けただけ (`peer_left`)・回線の瞬断では止めない
  watch(webRtc.endShareCount, () => {
    stopSharing()
    clearEndedNotice()
    endedByAdmin.value = true
    endedTimer = setTimeout(clearEndedNotice, SCREEN_SHARE_ENDED_NOTICE_MS)
  })

  // 共有を始めている途中と共有中は、新版への載せ替えのリロードを止める (Refs ippoan/alc-app#387)。
  // 送る側はどのタブでも載っているので、待機中の画面が「安全」と申告していてもこれが優先する
  useKioskScreen().declareReloadBlocked(() => isStarting.value || isSharing.value)

  onUnmounted(() => {
    clearEndedNotice()
    stopSharing()
  })

  return {
    isSharing: readonly(isSharing),
    roomId: readonly(roomId),
    error: readonly(error),
    isPeerConnected: webRtc.isPeerConnected,
    isConnected: webRtc.isConnected,
    isMuted: readonly(isMuted),
    endedByAdmin: readonly(endedByAdmin),
    remoteStream: webRtc.remoteStream,
    startSharing,
    stopSharing,
    toggleMute,
  }
}
