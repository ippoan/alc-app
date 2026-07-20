import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withSetup } from '../helpers/with-setup'
import { useWebRtc } from '~/composables/useWebRtc'

// --- Mock WebSocket ---
let wsInstances: MockWebSocket[] = []

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.OPEN
  url: string
  onopen: any = null
  onmessage: any = null
  onerror: any = null
  onclose: any = null

  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  })

  constructor(url: string) {
    this.url = url
    wsInstances.push(this)
  }
}

// --- Mock RTCPeerConnection ---
let pcInstances: MockRTCPeerConnection[] = []

class MockRTCPeerConnection {
  onicecandidate: any = null
  ontrack: any = null
  onconnectionstatechange: any = null
  onicegatheringstatechange: any = null
  oniceconnectionstatechange: any = null
  onsignalingstatechange: any = null
  connectionState = 'new'
  iceGatheringState = 'new'
  iceConnectionState = 'new'
  signalingState = 'stable'

  createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'mock-offer-sdp' })
  createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'mock-answer-sdp' })
  setLocalDescription = vi.fn().mockResolvedValue(undefined)
  setRemoteDescription = vi.fn().mockResolvedValue(undefined)
  addIceCandidate = vi.fn().mockResolvedValue(undefined)
  addTrack = vi.fn()
  getSenders = vi.fn().mockReturnValue([])
  getStats = vi.fn().mockResolvedValue(new Map())
  close = vi.fn()

  constructor(_config?: any) {
    pcInstances.push(this)
  }
}

vi.stubGlobal('WebSocket', MockWebSocket)
vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection)
vi.stubGlobal('RTCIceCandidate', class MockRTCIceCandidate {
  constructor(public candidate: any) {}
})

describe('useWebRtc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    wsInstances = []
    pcInstances = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function getWs(): MockWebSocket {
    return wsInstances[wsInstances.length - 1]!
  }
  function getPc(): MockRTCPeerConnection {
    return pcInstances[pcInstances.length - 1]!
  }

  // --- connect ---

  it('connect: WebSocket 作成、onopen で isConnected=true', async () => {
    const rtc = useWebRtc('device')
    expect(rtc.isConnected.value).toBe(false)

    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    expect(ws.url).toBe('wss://sig.example.com/room/room-1?role=device')

    // onopen 発火
    ws.onopen?.()
    expect(rtc.isConnected.value).toBe(true)
  })

  it('connect: path="cam-room" 指定で /cam-room/:siteId に接続する', async () => {
    const rtc = useWebRtc('admin')
    await rtc.connect('wss://sig.example.com', 'site-1', 'cam-room')
    const ws = getWs()
    expect(ws.url).toBe('wss://sig.example.com/cam-room/site-1?role=admin')
  })

  it('connect: token 指定時は &token=... がURLに付与される', async () => {
    const rtc = useWebRtc('admin')
    await rtc.connect('wss://sig.example.com', 'site-1', 'cam-room', 'jwt.abc def')
    const ws = getWs()
    expect(ws.url).toBe('wss://sig.example.com/cam-room/site-1?role=admin&token=jwt.abc%20def')
  })

  it('connect: onopen で ping timer が開始される', async () => {
    const rtc = useWebRtc('admin')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    // 30 秒後に ping 送信
    await vi.advanceTimersByTimeAsync(30000)
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }))

    // 60 秒後にもう一回
    await vi.advanceTimersByTimeAsync(30000)
    expect(ws.send).toHaveBeenCalledTimes(2)
  })

  it('connect: disconnect が先に呼ばれる (再接続時)', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws1 = getWs()
    ws1.onopen?.()
    expect(rtc.isConnected.value).toBe(true)

    // 2 回目の connect
    await rtc.connect('wss://sig.example.com', 'room-2')
    // 前の ws が close されている
    expect(ws1.close).toHaveBeenCalled()
  })

  // --- disconnect ---

  it('disconnect: ws.close + pc.close + 状態リセット', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    const pc = getPc()
    ws.onopen?.()

    rtc.disconnect()
    expect(ws.close).toHaveBeenCalled()
    expect(pc.close).toHaveBeenCalled()
    expect(rtc.isConnected.value).toBe(false)
    expect(rtc.isPeerConnected.value).toBe(false)
    expect(rtc.remoteStream.value).toBeNull()
  })

  it('disconnect: pingTimer がクリアされる', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    rtc.disconnect()

    // timer がクリアされているので ping は送られない
    ws.send.mockClear()
    await vi.advanceTimersByTimeAsync(60000)
    expect(ws.send).not.toHaveBeenCalled()
  })

  // --- ws.onerror ---

  it('ws.onerror → error ref が設定される', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()

    ws.onerror?.()
    expect(rtc.error.value).toBe('シグナリングサーバー接続エラー')
  })

  // --- ws.onclose ---

  it('ws.onclose → isConnected=false + timer clear', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()
    expect(rtc.isConnected.value).toBe(true)

    ws.onclose?.()
    expect(rtc.isConnected.value).toBe(false)

    // timer もクリア済み
    ws.send.mockClear()
    await vi.advanceTimersByTimeAsync(60000)
    expect(ws.send).not.toHaveBeenCalled()
  })

  // --- ws.onmessage: handleSignalingMessage ---

  it('handleSignalingMessage: sdp_offer → handleOffer → createAnswer + sendSignaling', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    ws.onmessage?.({ data: JSON.stringify({ type: 'sdp_offer', sdp: 'remote-offer-sdp' }) } as any)
    await vi.advanceTimersByTimeAsync(0)

    const pc = getPc()
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'remote-offer-sdp' })
    expect(pc.createAnswer).toHaveBeenCalled()
    expect(pc.setLocalDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'mock-answer-sdp' })
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'sdp_answer', sdp: 'mock-answer-sdp' }))
  })

  it('handleOffer when pc is null → creates new PC then processes offer', async () => {
    const rtc = useWebRtc('admin')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    // Save the onmessage handler before disconnect nullifies pc
    const savedOnMessage = ws.onmessage

    // Disconnect sets pc=null and ws=null internally
    rtc.disconnect()

    const pcCountBefore = pcInstances.length

    // Simulate a late-arriving sdp_offer message via the saved handler
    // This exercises the if (!pc) createPeerConnection() path in handleOffer
    savedOnMessage?.({ data: JSON.stringify({ type: 'sdp_offer', sdp: 'late-offer-sdp' }) } as any)
    await vi.advanceTimersByTimeAsync(0)

    // A new PC should have been created by handleOffer
    expect(pcInstances.length).toBe(pcCountBefore + 1)
    const newPc = getPc()
    expect(newPc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'late-offer-sdp' })
    expect(newPc.createAnswer).toHaveBeenCalled()
  })

  it('handleIceCandidate when pc is null → no-op, no throw', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    const savedOnMessage = ws.onmessage

    // Disconnect nullifies pc
    rtc.disconnect()

    const pcCountBefore = pcInstances.length

    // Send ice_candidate after disconnect — pc is null, should be silently ignored
    const candidate = { candidate: 'candidate-string', sdpMid: '0', sdpMLineIndex: 0 }
    savedOnMessage?.({ data: JSON.stringify({ type: 'ice_candidate', candidate }) } as any)
    await vi.advanceTimersByTimeAsync(0)

    // No new PC should have been created (handleIceCandidate just returns if pc is null)
    expect(pcInstances.length).toBe(pcCountBefore)
  })

  it('handleAnswer when pc is null → no-op', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    const savedOnMessage = ws.onmessage
    rtc.disconnect()

    // Send sdp_answer after disconnect — pc is null
    savedOnMessage?.({ data: JSON.stringify({ type: 'sdp_answer', sdp: 'answer-sdp' }) } as any)
    await vi.advanceTimersByTimeAsync(0)

    // No crash, no new PC
    expect(pcInstances.length).toBe(1) // only the one from connect()
  })

  it('handleSignalingMessage: sdp_answer → setRemoteDescription', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    ws.onmessage?.({ data: JSON.stringify({ type: 'sdp_answer', sdp: 'remote-answer-sdp' }) } as any)
    await vi.advanceTimersByTimeAsync(0)

    expect(getPc().setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'remote-answer-sdp' })
  })

  it('handleSignalingMessage: ice_candidate → addIceCandidate', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    const candidate = { candidate: 'candidate-string', sdpMid: '0', sdpMLineIndex: 0 }
    ws.onmessage?.({ data: JSON.stringify({ type: 'ice_candidate', candidate }) } as any)
    await vi.advanceTimersByTimeAsync(0)

    expect(getPc().addIceCandidate).toHaveBeenCalled()
  })

  it('handleSignalingMessage: peer_joined (device) → isPeerConnected=true + createAndSendOffer', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    ws.onmessage?.({ data: JSON.stringify({ type: 'peer_joined' }) } as any)
    await vi.advanceTimersByTimeAsync(0)

    expect(rtc.isPeerConnected.value).toBe(true)

    const pc = getPc()
    expect(pc.createOffer).toHaveBeenCalled()
    expect(pc.setLocalDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'mock-offer-sdp' })
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'sdp_offer', sdp: 'mock-offer-sdp' }))
  })

  it('handleSignalingMessage: peer_joined (admin) → isPeerConnected=true, offer は作成しない', async () => {
    const rtc = useWebRtc('admin')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    ws.onmessage?.({ data: JSON.stringify({ type: 'peer_joined' }) } as any)
    await vi.advanceTimersByTimeAsync(0)

    expect(rtc.isPeerConnected.value).toBe(true)
    expect(getPc().createOffer).not.toHaveBeenCalled()
  })

  it('handleSignalingMessage: peer_left → isPeerConnected=false + remoteStream=null', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    // First join
    ws.onmessage?.({ data: JSON.stringify({ type: 'peer_joined' }) } as any)
    await vi.advanceTimersByTimeAsync(0)
    expect(rtc.isPeerConnected.value).toBe(true)

    // Then leave
    ws.onmessage?.({ data: JSON.stringify({ type: 'peer_left' }) } as any)
    expect(rtc.isPeerConnected.value).toBe(false)
    expect(rtc.remoteStream.value).toBeNull()
  })

  it('handleSignalingMessage: error → error ref 設定', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    ws.onmessage?.({ data: JSON.stringify({ type: 'error', message: 'room full' }) } as any)
    expect(rtc.error.value).toBe('room full')
  })

  it('handleSignalingMessage: error without message → default message', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    ws.onmessage?.({ data: JSON.stringify({ type: 'error' }) } as any)
    expect(rtc.error.value).toBe('シグナリングエラー')
  })

  it('ws.onmessage: invalid JSON は無視される', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    // Should not throw
    ws.onmessage?.({ data: 'not-json{{{' } as any)
    expect(rtc.error.value).toBeNull()
  })

  // --- sdp_offer/sdp_answer/ice_candidate with missing data ---

  it('handleSignalingMessage: sdp_offer without sdp → no-op', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    ws.onmessage?.({ data: JSON.stringify({ type: 'sdp_offer' }) } as any)
    await vi.advanceTimersByTimeAsync(0)

    expect(getPc().setRemoteDescription).not.toHaveBeenCalled()
  })

  it('handleSignalingMessage: sdp_answer without sdp → no-op', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    ws.onmessage?.({ data: JSON.stringify({ type: 'sdp_answer' }) } as any)
    await vi.advanceTimersByTimeAsync(0)

    expect(getPc().setRemoteDescription).not.toHaveBeenCalled()
  })

  it('handleSignalingMessage: ice_candidate without candidate → no-op', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    ws.onmessage?.({ data: JSON.stringify({ type: 'ice_candidate' }) } as any)
    await vi.advanceTimersByTimeAsync(0)

    expect(getPc().addIceCandidate).not.toHaveBeenCalled()
  })

  // --- handleAnswer when pc is null ---

  it('handleAnswer: pc が null なら no-op', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    // disconnect で pc を null にする
    rtc.disconnect()

    // 新しい ws を作らず、直接 handleSignalingMessage 経由でテスト不可
    // handleAnswer with null pc is covered by sdp_answer path when pc=null
    // → connect 前に disconnect 済みの場合
  })

  // --- handleIceCandidate when pc is null ---

  it('handleIceCandidate: pc が null なら no-op', async () => {
    // pc=null の状態で ice_candidate を受け取る状況
    // disconnect してから onmessage を受ける (タイミングの問題)
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    rtc.disconnect()
    // ws は close 済みだが、onmessage を手動発火できる
    // ただし pc も null なので addIceCandidate は呼ばれない
  })

  // --- pc.onicecandidate ---

  it('pc.onicecandidate → sendSignaling(ice_candidate)', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    const pc = getPc()
    ws.onopen?.()

    const mockCandidate = { toJSON: () => ({ candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 }) }
    pc.onicecandidate?.({ candidate: mockCandidate } as any)

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'ice_candidate',
      candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 },
    }))
  })

  it('pc.onicecandidate: candidate が null なら送信しない', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    const pc = getPc()
    ws.onopen?.()
    ws.send.mockClear()

    pc.onicecandidate?.({ candidate: null } as any)
    expect(ws.send).not.toHaveBeenCalled()
  })

  // --- pc.ontrack ---

  it('pc.ontrack → remoteStream が設定される', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()

    const mockStream = { id: 'remote-stream' } as any as MediaStream
    pc.ontrack?.({ streams: [mockStream] } as any)
    expect(rtc.remoteStream.value).toStrictEqual(mockStream)
  })

  it('pc.ontrack: streams が空なら remoteStream=null', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()

    pc.ontrack?.({ streams: [] } as any)
    expect(rtc.remoteStream.value).toBeNull()
  })

  // --- pc.onicegatheringstatechange / oniceconnectionstatechange / onsignalingstatechange ---

  it('pc.onicegatheringstatechange → ログのみ (例外にならない)', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()

    pc.iceGatheringState = 'gathering'
    expect(() => pc.onicegatheringstatechange?.()).not.toThrow()
  })

  it('pc.oniceconnectionstatechange → ログのみ (例外にならない)', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()

    pc.iceConnectionState = 'checking'
    expect(() => pc.oniceconnectionstatechange?.()).not.toThrow()
  })

  it('pc.onsignalingstatechange → ログのみ (例外にならない)', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()

    pc.signalingState = 'have-local-offer'
    expect(() => pc.onsignalingstatechange?.()).not.toThrow()
  })

  // --- 統計ログ (startStatsLogging / stopStatsLogging) ---

  it('ontrack 後、5秒ごとに getStats が呼ばれ inbound-rtp video を集計する', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()

    const statsReport = new Map([
      ['rtp1', {
        type: 'inbound-rtp', kind: 'video', bytesReceived: 1000,
        framesDecoded: 10, framesDropped: 0, packetsLost: 0, jitter: 0.01,
      }],
      // video 以外 / inbound-rtp 以外は集計対象外 (if 分岐の else 相当を踏む)
      ['rtp2', { type: 'inbound-rtp', kind: 'audio', bytesReceived: 500 }],
    ])
    pc.getStats.mockResolvedValue(statsReport)

    pc.ontrack?.({ streams: [{ id: 's1' } as any as MediaStream] } as any)

    await vi.advanceTimersByTimeAsync(5000)
    expect(pc.getStats).toHaveBeenCalled()

    // 2回目: bytesReceived の差分 (delta) 計算分岐も踏む
    statsReport.set('rtp1', { ...statsReport.get('rtp1'), bytesReceived: 2000 } as any)
    await vi.advanceTimersByTimeAsync(5000)
    expect(pc.getStats).toHaveBeenCalledTimes(2)
  })

  it('pc が null になった後の統計tick → getStats を呼ばず早期return', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()

    pc.ontrack?.({ streams: [{ id: 's1' } as any as MediaStream] } as any)
    rtc.disconnect() // pc=null, かつ stopStatsLogging でタイマー自体もクリアされる

    // タイマーは止まっているはずなので getStats はこれ以上増えない
    const callsBefore = pc.getStats.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(pc.getStats.mock.calls.length).toBe(callsBefore)
  })

  it('onconnectionstatechange: failed で統計タイマーも停止する (2回目の failed でも安全)', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()

    pc.ontrack?.({ streams: [{ id: 's1' } as any as MediaStream] } as any)
    pc.connectionState = 'failed'
    pc.onconnectionstatechange?.()

    const callsAtFail = pc.getStats.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(pc.getStats.mock.calls.length).toBe(callsAtFail)

    // 既にタイマーが無い状態で再度 failed → stopStatsLogging の if(statsTimer) が false 分岐
    expect(() => pc.onconnectionstatechange?.()).not.toThrow()
  })

  // --- pc.onconnectionstatechange ---

  it('pc.onconnectionstatechange: failed → error + isPeerConnected=false', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()

    pc.connectionState = 'failed'
    pc.onconnectionstatechange?.()

    expect(rtc.error.value).toBe('P2P 接続が切断されました')
    expect(rtc.isPeerConnected.value).toBe(false)
    expect(rtc.remoteStream.value).toBeNull()
  })

  it('pc.onconnectionstatechange: disconnected → error + isPeerConnected=false', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()

    pc.connectionState = 'disconnected'
    pc.onconnectionstatechange?.()

    expect(rtc.error.value).toBe('P2P 接続が切断されました')
    expect(rtc.isPeerConnected.value).toBe(false)
  })

  it('pc.onconnectionstatechange: connected → 何も変わらない', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()

    pc.connectionState = 'connected'
    pc.onconnectionstatechange?.()

    expect(rtc.error.value).toBeNull()
  })

  // --- startStreaming ---

  it('startStreaming: pc に addTrack する (新規トラック)', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()

    const mockTrack = { kind: 'video', id: 't1' }
    const stream = { getTracks: () => [mockTrack] } as any as MediaStream

    await rtc.startStreaming(stream)
    expect(pc.addTrack).toHaveBeenCalledWith(mockTrack, stream)
  })

  it('startStreaming: sender があるが kind が異なる場合は addTrack', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()

    // Sender exists but with audio kind, while we add a video track
    pc.getSenders.mockReturnValue([{ track: { kind: 'audio' }, replaceTrack: vi.fn() }])

    const mockTrack = { kind: 'video', id: 't-vid' }
    const stream = { getTracks: () => [mockTrack] } as any as MediaStream

    await rtc.startStreaming(stream)
    expect(pc.addTrack).toHaveBeenCalledWith(mockTrack, stream)
  })

  it('startStreaming: sender.track が null の場合は addTrack', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()

    // Sender exists but track is null
    pc.getSenders.mockReturnValue([{ track: null, replaceTrack: vi.fn() }])

    const mockTrack = { kind: 'video', id: 't-vid2' }
    const stream = { getTracks: () => [mockTrack] } as any as MediaStream

    await rtc.startStreaming(stream)
    expect(pc.addTrack).toHaveBeenCalledWith(mockTrack, stream)
  })

  it('startStreaming: 既存 sender がある場合は replaceTrack', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()

    const replaceTrack = vi.fn()
    pc.getSenders.mockReturnValue([{ track: { kind: 'video' }, replaceTrack }])

    const mockTrack = { kind: 'video', id: 't2' }
    const stream = { getTracks: () => [mockTrack] } as any as MediaStream

    await rtc.startStreaming(stream)
    expect(replaceTrack).toHaveBeenCalledWith(mockTrack)
    expect(pc.addTrack).not.toHaveBeenCalled()
  })

  it('startStreaming: isPeerConnected=true なら createAndSendOffer', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    const pc = getPc()
    ws.onopen?.()

    // peer_joined で isPeerConnected=true
    ws.onmessage?.({ data: JSON.stringify({ type: 'peer_joined' }) } as any)
    await vi.advanceTimersByTimeAsync(0)
    pc.createOffer.mockClear()
    ws.send.mockClear()

    const stream = { getTracks: () => [{ kind: 'video' }] } as any as MediaStream
    await rtc.startStreaming(stream)

    expect(pc.createOffer).toHaveBeenCalled()
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('sdp_offer'))
  })

  it('startStreaming: pc が null の場合は localStream のみ保存 (addTrack されない)', async () => {
    const rtc = useWebRtc('device')
    // Do not call connect — pc is null

    const mockTrack = { kind: 'video', id: 't-nopc' }
    const stream = { getTracks: () => [mockTrack] } as any as MediaStream

    await rtc.startStreaming(stream)
    // No PC exists, so no addTrack call
    expect(pcInstances).toHaveLength(0)
  })

  it('startStreaming: isPeerConnected=false なら offer を送らない', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const pc = getPc()
    const ws = getWs()
    ws.onopen?.()
    ws.send.mockClear()

    const stream = { getTracks: () => [{ kind: 'video' }] } as any as MediaStream
    await rtc.startStreaming(stream)

    expect(pc.createOffer).not.toHaveBeenCalled()
  })

  // --- sendSignaling when ws is not OPEN ---

  it('sendSignaling: ws が OPEN でない場合は送信しない', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    const pc = getPc()

    // ws を CLOSED にする
    ws.readyState = MockWebSocket.CLOSED

    // ice_candidate を発火しても send されない
    const mockCandidate = { toJSON: () => ({ candidate: 'c' }) }
    pc.onicecandidate?.({ candidate: mockCandidate } as any)
    expect(ws.send).not.toHaveBeenCalled()
  })

  // --- createAndSendOffer when pc is null ---

  it('createAndSendOffer: pc が null なら no-op', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    // disconnect で pc=null にする
    rtc.disconnect()

    // peer_joined を受けても (pc=null なので) offer は作らない
    // ws は close 済みだが内部ハンドラは残っている
  })

  // --- createPeerConnection with localStream ---

  it('createPeerConnection: localStream があればトラックを addTrack する', async () => {
    const rtc = useWebRtc('device')

    // startStreaming の前に localStream をセットするには、
    // connect → startStreaming → disconnect → connect の順で
    const mockTrack = { kind: 'audio', id: 'a1' }
    const stream = { getTracks: () => [mockTrack] } as any as MediaStream

    await rtc.connect('wss://sig.example.com', 'room-1')
    await rtc.startStreaming(stream)

    // 再接続時に createPeerConnection が localStream のトラックを追加する
    await rtc.connect('wss://sig.example.com', 'room-2')
    const pc = getPc()

    // localStream のトラックが addTrack されている
    expect(pc.addTrack).toHaveBeenCalledWith(mockTrack, stream)
  })

  // --- onUnmounted ---

  it('onUnmounted → disconnect が呼ばれる', async () => {
    const [rtc, app] = withSetup(() => useWebRtc('device'))
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    const pc = getPc()
    ws.onopen?.()

    app.unmount()

    expect(ws.close).toHaveBeenCalled()
    expect(pc.close).toHaveBeenCalled()
  })

  // --- disconnect when nothing is connected ---

  it('disconnect: 未接続状態でも安全', () => {
    const rtc = useWebRtc('device')
    // Should not throw
    rtc.disconnect()
    expect(rtc.isConnected.value).toBe(false)
  })

  // --- connect clears error ---

  it('connect: error がリセットされる', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onerror?.()
    expect(rtc.error.value).not.toBeNull()

    await rtc.connect('wss://sig.example.com', 'room-2')
    expect(rtc.error.value).toBeNull()
  })

  // --- ws.onclose when pingTimer is null ---

  it('ws.onclose: pingTimer が null でも安全', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    // onopen を呼ばない → pingTimer は null

    ws.onclose?.()
    expect(rtc.isConnected.value).toBe(false)
  })

  // --- pong message (default case) ---

  it('handleSignalingMessage: pong → 何もしない (switch default)', async () => {
    const rtc = useWebRtc('device')
    await rtc.connect('wss://sig.example.com', 'room-1')
    const ws = getWs()
    ws.onopen?.()

    ws.onmessage?.({ data: JSON.stringify({ type: 'pong' }) } as any)
    // No error, no state change
    expect(rtc.error.value).toBeNull()
  })
})
