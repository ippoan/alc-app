/**
 * IT点呼 の通話と判定待ち (Refs ippoan/alc-app#387)。
 *
 * IT点呼 は通常点呼の流れ (本人確認 → 測定 → 保存) の最後に運行管理者と通話し、
 * 運行管理者の判定が付いたら完了になる。ここはその「最後」だけを持つ:
 *
 *   1. カメラとマイクを取り、`it-<点呼の記録の id>` を部屋の id にして signaling に繋ぐ
 *      (接頭辞は `~/utils/it-tenko`。運行管理者側が部屋の一覧を接頭辞で振り分ける)
 *   2. 3 秒ごとに点呼の記録を引き、`manager_judgment` が付いたら通話を切って判定を出す
 *
 * **`NormalMeasurement` が `itMode` のときだけ生成する。** 通常点呼の画面では生成しない
 * (`useWebRtc` / `useCamera` の `onUnmounted` も増えない)。
 *
 * カメラ・マイクの取り方は `TenkoKiosk.vue` の遠隔点呼と同じ手順 (あちらは本番で動いている
 * 経路なので触らない。共通化は IT点呼 を通常点呼へ統合するときに行う)。
 *
 * `useWebRtc.connect` は、開発用の印がある端末では端末の鍵のトークンを自分で付け、
 * 取れなければ throw する。ここは受けて「通話できない」にするだけで、token なしで
 * 繋ぎ直すことはしない (部屋が本番の側に登録されるため)。
 */

import { getTenkoSession } from '~/utils/api'
import { itTenkoRoomId } from '~/utils/it-tenko'

/** 判定を引き直す間隔。運行管理者側 (`TenkoRemoteAdminView.vue`) と同じ */
export const IT_TENKO_POLL_INTERVAL_MS = 3000

/**
 * - `idle`: 始めていない
 * - `connecting`: カメラ・マイク・signaling を開いている途中
 * - `calling`: 繋いだ。運行管理者の判定を待っている
 * - `judged`: 判定が付いた (通話は切ってある)
 * - `unavailable`: 通話を始められなかった (カメラが取れない / signaling に繋げない)
 */
export type ItTenkoCallState = 'idle' | 'connecting' | 'calling' | 'judged' | 'unavailable'

export interface ItTenkoJudgment {
  judgment: 'ok' | 'ng'
  /** NG の理由 (任意入力) */
  reason: string | null
}

export function useItTenkoCall() {
  const config = useRuntimeConfig()
  const camera = useCamera()
  const webRtc = useWebRtc('device')

  const state = ref<ItTenkoCallState>('idle')
  const judgment = ref<ItTenkoJudgment | null>(null)
  /** 送っている映像 + 音声 (`TenkoVideoCall` の自分側の表示に渡す) */
  const localStream = shallowRef<MediaStream | null>(null)

  let sessionId: string | null = null
  let audioStream: MediaStream | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  // open() / stop() の世代。カメラや signaling を待つあいだに stop() が来たら、
  // 待っていた古い open() は何も残さずに終わる
  let generation = 0
  // 画面が消えたあとに start() が呼ばれても、止める人の居ないカメラを開かない
  let disposed = false

  // 運行管理者が一度つながったあとで切れたか (再接続ボタンの条件。`TenkoKiosk.vue` と同じ)
  const hadPeerConnected = ref(false)
  watch(webRtc.isPeerConnected, (connected) => {
    if (connected) hadPeerConnected.value = true
  })
  const isDisconnected = computed(
    () => state.value === 'calling' && hadPeerConnected.value && !webRtc.isPeerConnected.value,
  )

  function stopTracks(stream: MediaStream | null) {
    stream?.getTracks().forEach(t => t.stop())
  }

  /** 通話・カメラ・マイク・ポーリングを手放す (どの記録の通話だったかは残す) */
  function release() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    webRtc.disconnect()
    camera.stop()
    stopTracks(audioStream)
    audioStream = null
    localStream.value = null
    hadPeerConnected.value = false
  }

  async function poll(id: string, gen: number) {
    try {
      const session = await getTenkoSession(id)
      if (gen !== generation) return
      const j = session.manager_judgment
      if (j !== 'ok' && j !== 'ng') return
      generation += 1
      release()
      judgment.value = { judgment: j, reason: session.manager_judgment_reason }
      state.value = 'judged'
    }
    catch {
      // 一時的な通信の失敗では判定待ちをやめない (次の回で引き直す)
    }
  }

  async function open(id: string) {
    const gen = ++generation
    release()
    state.value = 'connecting'
    try {
      await camera.start('user')
      // カメラ映像 + マイク音声を合成して送る。マイクを断られたら映像だけで続ける
      let mic: MediaStream | null = null
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      }
      catch {
        mic = null
      }
      if (gen !== generation) {
        // 待つあいだに stop() が来ていた。いま開いたぶんだけ閉じて終わる
        stopTracks(mic)
        camera.stop()
        return
      }
      audioStream = mic
      const video = camera.stream.value as MediaStream
      const streamToSend = mic
        ? new MediaStream([...video.getVideoTracks(), ...mic.getAudioTracks()])
        : video
      localStream.value = streamToSend

      // 部屋の id だけ接頭辞つき。判定を引く `getTenkoSession` は点呼の記録の id のまま
      await webRtc.connect(config.public.signalingUrl, itTenkoRoomId(id))
      await webRtc.startStreaming(streamToSend)
    }
    catch (e) {
      if (gen !== generation) return
      console.warn('[ItTenkoCall] 通話を始められませんでした:', e)
      release()
      state.value = 'unavailable'
      return
    }
    if (gen !== generation) return
    state.value = 'calling'
    pollTimer = setInterval(() => void poll(id, gen), IT_TENKO_POLL_INTERVAL_MS)
  }

  /**
   * 点呼の記録 `id` の通話を始める。**既に始めていたら何もしない** (二重に繋がない) —
   * 次の通話は `stop()` のあと。
   */
  async function start(id: string) {
    if (disposed || sessionId) return
    sessionId = id
    judgment.value = null
    await open(id)
  }

  /** 同じ記録の通話を繋ぎ直す (切れたとき・始められなかったとき)。開いている途中は何もしない */
  async function reconnect() {
    if (!sessionId || state.value === 'connecting' || state.value === 'judged') return
    await open(sessionId)
  }

  /** 通話と判定待ちをやめて初めの状態へ戻す */
  function stop() {
    generation += 1
    release()
    sessionId = null
    judgment.value = null
    state.value = 'idle'
  }

  onUnmounted(() => {
    disposed = true
    stop()
  })

  return {
    state: readonly(state),
    judgment: readonly(judgment),
    localStream: readonly(localStream),
    remoteStream: webRtc.remoteStream,
    isConnected: webRtc.isConnected,
    isPeerConnected: webRtc.isPeerConnected,
    isDisconnected,
    /** signaling が返した失敗の文言 (開発用の部屋から切られた、等)。無ければ null */
    error: webRtc.error,
    start,
    reconnect,
    stop,
  }
}
