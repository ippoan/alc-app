import type { SignalingInMessage, SignalingOutMessage } from '~/types'
import type { DeviceTokenKind } from '~/utils/token-selection'
import {
  DEV_SIGNALING_TOKEN_UNAVAILABLE_MESSAGE,
  devSignalingToken,
  isDevDevice,
} from '~/utils/token-selection'

/**
 * signaling が close code 1008 で切ってきたときの文言 (Refs ippoan/alc-app#387)。
 * 開発用の端末の部屋に、開発用でない運行管理者が入っていた場合に signaling が切る。
 */
export const SIGNALING_REJECTED_MESSAGE = 'この通話には参加できません (開発用の端末の通話です)'
const CLOSE_POLICY_VIOLATION = 1008

/**
 * `/room` に繋ぐとき、**どの端末の鍵の dev の印を見るか** (role ごと。先頭から見て最初に
 * 印が立っているものを使う)。運行管理者は運行管理者席の鍵だけ。端末側はキオスクのほか、
 * 画面共有 (`useScreenShare`) が測定台・運行管理者席でも出るので 3 種を順に見る。
 */
const DEV_KINDS: Record<'device' | 'admin', DeviceTokenKind[]> = {
  admin: ['manager-device'],
  device: ['kiosk', 'bp-station', 'manager-device'],
}

/** 印が立っている鍵の getter。**印があるときにしか呼ばない** (composable の生成もそのときだけ)。 */
const DEV_TOKEN_GETTERS: Record<DeviceTokenKind, () => () => Promise<string | null>> = {
  'kiosk': () => useDeviceToken().getDeviceJwt,
  'bp-station': () => useBpStationDeviceToken().getBpStationJwt,
  'manager-device': () => useManagerDeviceToken().getManagerJwt,
}

export function useWebRtc(role: 'device' | 'admin') {
  const isConnected = ref(false)
  const isPeerConnected = ref(false)
  const remoteStream = ref<MediaStream | null>(null)
  const error = ref<string | null>(null)
  /**
   * 相手 (運行管理者) から「画面共有を終了」の合図を受けた回数。専用の callback は持たず、
   * 読む側 (`useScreenShare`) がこの連番を watch する (`useAlarmDevice` の `buttonPressCount` と同じ作法)
   */
  const endShareCount = ref(0)

  let ws: WebSocket | null = null
  let pc: RTCPeerConnection | null = null
  let localStream: MediaStream | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  // connect() / disconnect() の世代。dev端末がトークンを待つあいだに次の connect() や
  // disconnect() が来たら、待っていた古い connect() は WebSocket を作らずに終わる
  let connectGeneration = 0
  // cam-room の device peer (P4/alc-gw-p4) は non-trickle 実装で、admin からの
  // ice_candidate メッセージを受信しても無視する (alc-gw-p4/main/signaling_client.c)。
  // そのため admin 側は answer を即送信せず、ICE gathering 完了を待って全候補を
  // answer SDP 本体に埋め込んでから送る必要がある (path='cam-room' の時のみ)。
  let waitForGatheringBeforeAnswer = false
  const ICE_GATHERING_TIMEOUT_MS = 5000

  const rtcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  }

  const log = (...args: unknown[]) => console.log(`[useWebRtc:${role}]`, ...args)

  function sendSignaling(msg: SignalingOutMessage) {
    log('sendSignaling ->', msg.type, msg)
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    } else {
      log('sendSignaling skipped: ws not OPEN (readyState=', ws?.readyState, ')')
    }
  }

  // 接続中の統計 (bytesReceived等) を定期ログするタイマー。「peer_joined したのに
  // 映像が固まる」系の切り分け用 (受信データが本当に増えているか vs 増えているのに
  // 描画されていないかを区別する)。
  let statsTimer: ReturnType<typeof setInterval> | null = null
  let lastStatsBytes = -1

  function startStatsLogging() {
    stopStatsLogging()
    statsTimer = setInterval(async () => {
      // disconnect() は stopStatsLogging() (このタイマーの clearInterval) を
      // pc=null にする前に必ず呼ぶので、このコールバックが動く時点で pc は非null。
      const stats = await pc!.getStats()
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          const delta = lastStatsBytes >= 0 ? report.bytesReceived - lastStatsBytes : 0
          log(
            `inbound-rtp video: bytesReceived=${report.bytesReceived} (+${delta}/5s) `
            + `framesDecoded=${report.framesDecoded} framesDropped=${report.framesDropped} `
            + `packetsLost=${report.packetsLost} jitter=${report.jitter}`,
          )
          lastStatsBytes = report.bytesReceived
        }
      })
    }, 5000)
  }

  function stopStatsLogging() {
    if (statsTimer) {
      clearInterval(statsTimer)
      statsTimer = null
    }
    lastStatsBytes = -1
  }

  function createPeerConnection() {
    pc = new RTCPeerConnection(rtcConfig)

    pc.onicecandidate = (event) => {
      log('onicecandidate:', event.candidate ? event.candidate.candidate : '(gathering complete)')
      if (event.candidate) {
        sendSignaling({ type: 'ice_candidate', candidate: event.candidate.toJSON() })
      }
    }

    pc.onicegatheringstatechange = () => {
      log('iceGatheringState:', pc?.iceGatheringState)
    }

    pc.oniceconnectionstatechange = () => {
      log('iceConnectionState:', pc?.iceConnectionState)
    }

    pc.onsignalingstatechange = () => {
      log('signalingState:', pc?.signalingState)
    }

    pc.ontrack = (event) => {
      log('ontrack:', event.track?.kind, event.track?.readyState, 'streams=', event.streams.length)
      remoteStream.value = event.streams[0] || null
      startStatsLogging()
    }

    pc.onconnectionstatechange = () => {
      log('connectionState:', pc?.connectionState)
      if (pc?.connectionState === 'failed' || pc?.connectionState === 'disconnected') {
        error.value = 'P2P 接続が切断されました'
        isPeerConnected.value = false
        remoteStream.value = null
        stopStatsLogging()
      }
    }

    // ローカルストリームのトラックを追加
    if (localStream) {
      for (const track of localStream.getTracks()) {
        log('createPeerConnection: adding local track', track.kind)
        pc.addTrack(track, localStream)
      }
    }

    return pc
  }

  /** pc.iceGatheringState が 'complete' になるまで待つ (タイムアウト付き)。 */
  function waitForIceGatheringComplete(): Promise<void> {
    if (pc!.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        pc!.removeEventListener('icegatheringstatechange', onChange)
        log('waitForIceGatheringComplete: timeout, send with whatever gathered so far')
        resolve()
      }, ICE_GATHERING_TIMEOUT_MS)
      const onChange = () => {
        if (pc!.iceGatheringState === 'complete') {
          clearTimeout(timeoutId)
          pc!.removeEventListener('icegatheringstatechange', onChange)
          resolve()
        }
      }
      pc!.addEventListener('icegatheringstatechange', onChange)
    })
  }

  async function handleOffer(sdp: string) {
    log('handleOffer: sdp received, length=', sdp.length)
    if (!pc) createPeerConnection()
    await pc!.setRemoteDescription({ type: 'offer', sdp })
    const answer = await pc!.createAnswer()
    await pc!.setLocalDescription(answer)
    log('handleOffer: answer created, length=', answer.sdp?.length)

    if (waitForGatheringBeforeAnswer) {
      // non-trickle peer (P4) は ice_candidate メッセージを無視するため、
      // 全候補が embed された localDescription を待ってから送る。
      log('handleOffer: non-trickle peer, waiting for ICE gathering to complete before sending answer')
      await waitForIceGatheringComplete()
    }

    // gathering を待った場合は候補が追記された最新の localDescription を使う
    // (createAnswer() が返した answer オブジェクトは候補を含まない静的スナップショット)。
    const sdpToSend = pc!.localDescription!.sdp
    log('handleOffer: sending answer, length=', sdpToSend.length, waitForGatheringBeforeAnswer ? '(候補embed済み)' : '(trickle)')
    sendSignaling({ type: 'sdp_answer', sdp: sdpToSend })
  }

  async function handleAnswer(sdp: string) {
    log('handleAnswer: sdp received, length=', sdp.length)
    if (pc) {
      await pc.setRemoteDescription({ type: 'answer', sdp })
    } else {
      log('handleAnswer: pc is null, ignored')
    }
  }

  async function handleIceCandidate(candidate: RTCIceCandidateInit) {
    log('handleIceCandidate:', candidate.candidate)
    if (pc) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate))
    } else {
      log('handleIceCandidate: pc is null, ignored')
    }
  }

  function handleSignalingMessage(data: SignalingInMessage) {
    log('handleSignalingMessage <-', data.type, data)
    switch (data.type) {
      case 'sdp_offer':
        if (data.sdp) handleOffer(data.sdp)
        break
      case 'sdp_answer':
        if (data.sdp) handleAnswer(data.sdp)
        break
      case 'ice_candidate':
        if (data.candidate) handleIceCandidate(data.candidate)
        break
      case 'peer_joined':
        log('peer_joined')
        isPeerConnected.value = true
        // Device 側: peer(admin)が来たら offer を作成
        if (role === 'device' && pc) {
          createAndSendOffer()
        }
        break
      case 'peer_left':
        log('peer_left')
        isPeerConnected.value = false
        remoteStream.value = null
        break
      case 'error':
        log('server error:', data.message)
        error.value = data.message || 'シグナリングエラー'
        break
      case 'end_share':
        log('end_share')
        endShareCount.value += 1
        break
      default:
        log('unhandled message type:', data.type)
    }
  }

  async function createAndSendOffer() {
    const offer = await pc!.createOffer()
    await pc!.setLocalDescription(offer)
    log('createAndSendOffer: offer created, length=', offer.sdp?.length)
    sendSignaling({ type: 'sdp_offer', sdp: offer.sdp! })
  }

  /**
   * シグナリングサーバーに接続。token は cam-room 等サーバー側で認証を要求する path 向け (省略可)。
   *
   * **dev端末 (端末の鍵に dev の印がある) が `/room` に繋ぐときだけ**、端末の鍵のトークンを
   * 取って `token` として付ける (Refs ippoan/alc-app#387)。取れなければ接続しない
   * (fail-closed) — token なしで繋ぐと部屋が本番の側に登録されるため。
   * 印が無い端末・`cam-room`・token を明示した呼び出しは、この分岐に入らず今までどおり
   * (WebSocket は connect() の同期の流れの中で作られる)。
   */
  async function connect(signalingUrl: string, roomId: string, path: 'room' | 'cam-room' = 'room', token?: string) {
    error.value = null
    const generation = ++connectGeneration

    const devKind = path === 'room' && !token ? DEV_KINDS[role].find(isDevDevice) : undefined
    if (devKind) {
      // peer connection を作る前に取る — 取れなかったときに何も残さないため
      try {
        token = await devSignalingToken(DEV_TOKEN_GETTERS[devKind]())
      }
      catch (e) {
        if (generation !== connectGeneration) return
        disconnect()
        error.value = DEV_SIGNALING_TOKEN_UNAVAILABLE_MESSAGE
        throw e
      }
      // 待つあいだに disconnect() か次の connect() が来ていたら、こちらは何もしない
      if (generation !== connectGeneration) return
    }

    disconnect()

    waitForGatheringBeforeAnswer = path === 'cam-room'
    createPeerConnection()

    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : ''
    const url = `${signalingUrl}/${path}/${roomId}?role=${role}${tokenParam}`
    log('connect:', `${signalingUrl}/${path}/${roomId}?role=${role}`, token ? '(token付き)' : '(token無し)')
    ws = new WebSocket(url)

    ws.onopen = () => {
      log('ws.onopen')
      isConnected.value = true
      // Keep-alive ping
      pingTimer = setInterval(() => sendSignaling({ type: 'ping' }), 30000)
    }

    ws.onmessage = (event) => {
      try {
        const data: SignalingInMessage = JSON.parse(event.data)
        handleSignalingMessage(data)
      } catch (e) {
        log('ws.onmessage: invalid JSON, ignored', event.data, e)
      }
    }

    ws.onerror = (event) => {
      log('ws.onerror', event)
      error.value = 'シグナリングサーバー接続エラー'
    }

    ws.onclose = (event) => {
      log('ws.onclose code=', event?.code, 'reason=', event?.reason, 'wasClean=', event?.wasClean)
      isConnected.value = false
      if (pingTimer) {
        clearInterval(pingTimer)
        pingTimer = null
      }
      // 開発用の端末の部屋から signaling に切られた。自動では繋ぎ直さない
      if (event?.code === CLOSE_POLICY_VIOLATION) error.value = SIGNALING_REJECTED_MESSAGE
    }
  }

  /** カメラ映像の P2P 送信を開始 */
  async function startStreaming(stream: MediaStream) {
    log('startStreaming: tracks=', stream.getTracks().map(t => t.kind))
    localStream = stream

    if (pc) {
      // 既存トラックを置換 or 追加
      for (const track of stream.getTracks()) {
        const sender = pc.getSenders().find(s => s.track?.kind === track.kind)
        if (sender) {
          sender.replaceTrack(track)
        } else {
          pc.addTrack(track, stream)
        }
      }

      // Peer が既に接続中なら offer を再送 (device/admin 両方)
      if (isPeerConnected.value) {
        await createAndSendOffer()
      }
    }
  }

  /**
   * 見ている画面共有を、共有している側に終了させる (運行管理者の側だけが使う)。
   * signaling が中継するのは admin から・画面共有の部屋だけで、それ以外は `error` が返る
   */
  function sendEndShare() {
    sendSignaling({ type: 'end_share' })
  }

  /** 切断 */
  function disconnect() {
    log('disconnect')
    connectGeneration += 1
    stopStatsLogging()
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
    if (ws) {
      ws.close()
      ws = null
    }
    if (pc) {
      pc.close()
      pc = null
    }
    isConnected.value = false
    isPeerConnected.value = false
    remoteStream.value = null
  }

  onUnmounted(() => disconnect())

  return {
    isConnected: readonly(isConnected),
    isPeerConnected: readonly(isPeerConnected),
    remoteStream: readonly(remoteStream),
    error: readonly(error),
    endShareCount: readonly(endShareCount),
    connect,
    startStreaming,
    sendEndShare,
    disconnect,
  }
}
