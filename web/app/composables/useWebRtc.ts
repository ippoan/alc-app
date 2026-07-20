import type { SignalingInMessage, SignalingOutMessage } from '~/types'

export function useWebRtc(role: 'device' | 'admin') {
  const isConnected = ref(false)
  const isPeerConnected = ref(false)
  const remoteStream = ref<MediaStream | null>(null)
  const error = ref<string | null>(null)

  let ws: WebSocket | null = null
  let pc: RTCPeerConnection | null = null
  let localStream: MediaStream | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null

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

  async function handleOffer(sdp: string) {
    log('handleOffer: sdp received, length=', sdp.length)
    if (!pc) createPeerConnection()
    await pc!.setRemoteDescription({ type: 'offer', sdp })
    const answer = await pc!.createAnswer()
    await pc!.setLocalDescription(answer)
    log('handleOffer: answer created, length=', answer.sdp?.length)
    sendSignaling({ type: 'sdp_answer', sdp: answer.sdp! })
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

  /** シグナリングサーバーに接続。token は cam-room 等サーバー側で認証を要求する path 向け (省略可) */
  async function connect(signalingUrl: string, roomId: string, path: 'room' | 'cam-room' = 'room', token?: string) {
    error.value = null
    disconnect()

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

  /** 切断 */
  function disconnect() {
    log('disconnect')
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
    connect,
    startStreaming,
    disconnect,
  }
}
