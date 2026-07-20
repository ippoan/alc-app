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

  function sendSignaling(msg: SignalingOutMessage) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  function createPeerConnection() {
    pc = new RTCPeerConnection(rtcConfig)

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignaling({ type: 'ice_candidate', candidate: event.candidate.toJSON() })
      }
    }

    pc.ontrack = (event) => {
      remoteStream.value = event.streams[0] || null
    }

    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'failed' || pc?.connectionState === 'disconnected') {
        error.value = 'P2P 接続が切断されました'
        isPeerConnected.value = false
        remoteStream.value = null
      }
    }

    // ローカルストリームのトラックを追加
    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream)
      }
    }

    return pc
  }

  async function handleOffer(sdp: string) {
    if (!pc) createPeerConnection()
    await pc!.setRemoteDescription({ type: 'offer', sdp })
    const answer = await pc!.createAnswer()
    await pc!.setLocalDescription(answer)
    sendSignaling({ type: 'sdp_answer', sdp: answer.sdp! })
  }

  async function handleAnswer(sdp: string) {
    if (pc) {
      await pc.setRemoteDescription({ type: 'answer', sdp })
    }
  }

  async function handleIceCandidate(candidate: RTCIceCandidateInit) {
    if (pc) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate))
    }
  }

  function handleSignalingMessage(data: SignalingInMessage) {
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
        isPeerConnected.value = true
        // Device 側: peer(admin)が来たら offer を作成
        if (role === 'device' && pc) {
          createAndSendOffer()
        }
        break
      case 'peer_left':
        isPeerConnected.value = false
        remoteStream.value = null
        break
      case 'error':
        error.value = data.message || 'シグナリングエラー'
        break
    }
  }

  async function createAndSendOffer() {
    const offer = await pc!.createOffer()
    await pc!.setLocalDescription(offer)
    sendSignaling({ type: 'sdp_offer', sdp: offer.sdp! })
  }

  /** シグナリングサーバーに接続。token は cam-room 等サーバー側で認証を要求する path 向け (省略可) */
  async function connect(signalingUrl: string, roomId: string, path: 'room' | 'cam-room' = 'room', token?: string) {
    error.value = null
    disconnect()

    createPeerConnection()

    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : ''
    const url = `${signalingUrl}/${path}/${roomId}?role=${role}${tokenParam}`
    ws = new WebSocket(url)

    ws.onopen = () => {
      isConnected.value = true
      // Keep-alive ping
      pingTimer = setInterval(() => sendSignaling({ type: 'ping' }), 30000)
    }

    ws.onmessage = (event) => {
      try {
        const data: SignalingInMessage = JSON.parse(event.data)
        handleSignalingMessage(data)
      } catch {
        // ignore invalid messages
      }
    }

    ws.onerror = () => {
      error.value = 'シグナリングサーバー接続エラー'
    }

    ws.onclose = () => {
      isConnected.value = false
      if (pingTimer) {
        clearInterval(pingTimer)
        pingTimer = null
      }
    }
  }

  /** カメラ映像の P2P 送信を開始 */
  async function startStreaming(stream: MediaStream) {
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
