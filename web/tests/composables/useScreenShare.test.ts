import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick, ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { withSetup } from '../helpers/with-setup'

// --- Mock useWebRtc ---
const mockConnect = vi.fn().mockResolvedValue(undefined)
const mockStartStreaming = vi.fn().mockResolvedValue(undefined)
const mockDisconnect = vi.fn()

const { useWebRtcMock } = vi.hoisted(() => ({
  useWebRtcMock: vi.fn(() => ({})),
}))

mockNuxtImport('useWebRtc', () => useWebRtcMock)

// Import AFTER mock setup
import { SCREEN_SHARE_ENDED_NOTICE_MS, useScreenShare } from '~/composables/useScreenShare'

// --- Helpers ---
function createMockVideoTrack() {
  return {
    kind: 'video',
    stop: vi.fn(),
    onended: null as any,
    enabled: true,
  }
}

function createMockAudioTrack() {
  return {
    kind: 'audio',
    stop: vi.fn(),
    enabled: true,
  }
}

function createMockStream(videoTracks: any[] = [], audioTracks: any[] = []) {
  return {
    getTracks: () => [...videoTracks, ...audioTracks],
    getVideoTracks: () => videoTracks,
    getAudioTracks: () => audioTracks,
  } as any as MediaStream
}

// --- Mock crypto.randomUUID ---
vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid-1234' })

describe('useScreenShare', () => {
  let mockGetDisplayMedia: ReturnType<typeof vi.fn>
  let mockGetUserMedia: ReturnType<typeof vi.fn>
  // useWebRtc が受けた「画面共有を終了」の合図の連番 / 相手 (見る側) が居るか
  let endShareCount: ReturnType<typeof ref<number>>
  let isPeerConnected: ReturnType<typeof ref<boolean>>

  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.clearAllMocks()

    // clearAllMocks で実装がリセットされるので再設定
    mockConnect.mockResolvedValue(undefined)
    mockStartStreaming.mockResolvedValue(undefined)

    const videoTrack = createMockVideoTrack()
    const audioTrack = createMockAudioTrack()

    mockGetDisplayMedia = vi.fn().mockResolvedValue(createMockStream([videoTrack]))
    mockGetUserMedia = vi.fn().mockResolvedValue(createMockStream([], [audioTrack]))

    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: mockGetDisplayMedia,
        getUserMedia: mockGetUserMedia,
      },
    })

    endShareCount = ref(0)
    isPeerConnected = ref(false)
    useWebRtcMock.mockReturnValue({
      isConnected: ref(false),
      isPeerConnected,
      remoteStream: ref(null),
      error: ref(null),
      endShareCount,
      connect: mockConnect,
      startStreaming: mockStartStreaming,
      disconnect: mockDisconnect,
    })
  })

  // --- 初期値 ---

  it('初期値が正しい', () => {
    const ss = useScreenShare()
    expect(ss.isSharing.value).toBe(false)
    expect(ss.roomId.value).toBeNull()
    expect(ss.error.value).toBeNull()
    expect(ss.isMuted.value).toBe(false)
  })

  // --- startSharing: 正常フロー ---

  it('startSharing: 画面共有+マイク取得+接続+ストリーミング開始', async () => {
    const ss = useScreenShare()
    await ss.startSharing('https://sig.example.com')

    expect(mockGetDisplayMedia).toHaveBeenCalledWith({ video: { displaySurface: 'monitor' }, audio: false })
    expect(mockGetUserMedia).toHaveBeenCalledWith({ audio: true, video: false })
    expect(mockConnect).toHaveBeenCalledWith('wss://sig.example.com', 'screen-test-uuid-1234')
    expect(mockStartStreaming).toHaveBeenCalled()
    expect(ss.isSharing.value).toBe(true)
    expect(ss.roomId.value).toBe('screen-test-uuid-1234')
  })

  it('startSharing: http → ws に変換', async () => {
    const ss = useScreenShare()
    await ss.startSharing('http://localhost:8787')

    expect(mockConnect).toHaveBeenCalledWith('ws://localhost:8787', 'screen-test-uuid-1234')
  })

  // --- startSharing: 画面共有拒否 ---

  it('startSharing: getDisplayMedia 拒否 → error 設定、接続しない', async () => {
    mockGetDisplayMedia.mockRejectedValue(new Error('Permission denied'))

    const ss = useScreenShare()
    await ss.startSharing('https://sig.example.com')

    expect(ss.error.value).toBe('画面共有の許可が得られませんでした')
    expect(ss.isSharing.value).toBe(false)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  // --- startSharing: マイク取得失敗 → 画面のみで続行 ---

  it('startSharing: getUserMedia 失敗 → 画面のみでストリーミング', async () => {
    mockGetUserMedia.mockRejectedValue(new Error('No mic'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const ss = useScreenShare()
    await ss.startSharing('https://sig.example.com')

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ScreenShare] getUserMedia failed'),
      expect.any(Error),
    )
    expect(ss.isSharing.value).toBe(true)
    // startStreaming は screenStream のみで呼ばれる
    expect(mockStartStreaming).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  // --- startSharing: シグナリング接続失敗 ---

  it('startSharing: connect 失敗 → ストリーム停止 + error', async () => {
    const videoTrack = createMockVideoTrack()
    const audioTrack = createMockAudioTrack()
    mockGetDisplayMedia.mockResolvedValue(createMockStream([videoTrack]))
    mockGetUserMedia.mockResolvedValue(createMockStream([], [audioTrack]))
    mockConnect.mockRejectedValue(new Error('ws failed'))

    const ss = useScreenShare()
    await ss.startSharing('https://sig.example.com')

    expect(ss.error.value).toBe('シグナリングサーバーへの接続に失敗しました')
    expect(ss.isSharing.value).toBe(false)
    expect(ss.roomId.value).toBeNull()
    expect(videoTrack.stop).toHaveBeenCalled()
    expect(audioTrack.stop).toHaveBeenCalled()
  })

  it('startSharing: startStreaming 失敗 → ストリーム停止 + error', async () => {
    const videoTrack = createMockVideoTrack()
    mockGetDisplayMedia.mockResolvedValue(createMockStream([videoTrack]))
    mockGetUserMedia.mockRejectedValue(new Error('No mic'))
    mockStartStreaming.mockRejectedValue(new Error('streaming failed'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const ss = useScreenShare()
    await ss.startSharing('https://sig.example.com')

    expect(ss.error.value).toBe('シグナリングサーバーへの接続に失敗しました')
    expect(videoTrack.stop).toHaveBeenCalled()
    expect(ss.isSharing.value).toBe(false)
  })

  // --- stopSharing ---

  it('stopSharing: ストリーム停止 + disconnect + 状態リセット', async () => {
    const videoTrack = createMockVideoTrack()
    const audioTrack = createMockAudioTrack()
    mockGetDisplayMedia.mockResolvedValue(createMockStream([videoTrack]))
    mockGetUserMedia.mockResolvedValue(createMockStream([], [audioTrack]))

    const ss = useScreenShare()
    await ss.startSharing('https://sig.example.com')
    expect(ss.isSharing.value).toBe(true)

    ss.stopSharing()

    expect(videoTrack.stop).toHaveBeenCalled()
    expect(audioTrack.stop).toHaveBeenCalled()
    expect(mockDisconnect).toHaveBeenCalled()
    expect(ss.isSharing.value).toBe(false)
    expect(ss.roomId.value).toBeNull()
    expect(ss.isMuted.value).toBe(false)
  })

  it('stopSharing: ストリームが null でも安全', () => {
    const ss = useScreenShare()
    // Should not throw
    ss.stopSharing()
    expect(mockDisconnect).toHaveBeenCalled()
    expect(ss.isSharing.value).toBe(false)
  })

  // --- videoTrack.onended ---

  it('videoTrack.onended → stopSharing が呼ばれる', async () => {
    const videoTrack = createMockVideoTrack()
    mockGetDisplayMedia.mockResolvedValue(createMockStream([videoTrack]))

    const ss = useScreenShare()
    await ss.startSharing('https://sig.example.com')
    expect(ss.isSharing.value).toBe(true)

    // ユーザーが共有停止ボタンを押した
    videoTrack.onended?.()

    expect(ss.isSharing.value).toBe(false)
    expect(mockDisconnect).toHaveBeenCalled()
  })

  // --- toggleMute ---

  it('toggleMute: isMuted を切り替え + mic track.enabled を変更', async () => {
    const audioTrack = createMockAudioTrack()
    mockGetUserMedia.mockResolvedValue(createMockStream([], [audioTrack]))

    const ss = useScreenShare()
    await ss.startSharing('https://sig.example.com')

    ss.toggleMute()
    expect(ss.isMuted.value).toBe(true)
    expect(audioTrack.enabled).toBe(false)

    ss.toggleMute()
    expect(ss.isMuted.value).toBe(false)
    expect(audioTrack.enabled).toBe(true)
  })

  it('toggleMute: Android bridge setMicMuted を呼ぶ', async () => {
    const setMicMuted = vi.fn()
    ;(window as any).Android = { setMicMuted }

    const ss = useScreenShare()
    await ss.startSharing('https://sig.example.com')

    ss.toggleMute()
    expect(setMicMuted).toHaveBeenCalledWith(true)

    ss.toggleMute()
    expect(setMicMuted).toHaveBeenCalledWith(false)

    delete (window as any).Android
  })

  it('toggleMute: Android bridge がない場合も安全', async () => {
    delete (window as any).Android

    const ss = useScreenShare()
    await ss.startSharing('https://sig.example.com')

    // Should not throw
    ss.toggleMute()
    expect(ss.isMuted.value).toBe(true)
  })

  it('toggleMute: micStream が null でも安全', () => {
    const ss = useScreenShare()
    // micStream は null (startSharing していない)
    ss.toggleMute()
    expect(ss.isMuted.value).toBe(true)
  })

  // --- onUnmounted ---

  it('onUnmounted → stopSharing が呼ばれる', async () => {
    const videoTrack = createMockVideoTrack()
    const audioTrack = createMockAudioTrack()
    mockGetDisplayMedia.mockResolvedValue(createMockStream([videoTrack]))
    mockGetUserMedia.mockResolvedValue(createMockStream([], [audioTrack]))

    const [ss, app] = withSetup(() => useScreenShare())
    await ss.startSharing('https://sig.example.com')
    expect(ss.isSharing.value).toBe(true)

    app.unmount()

    expect(videoTrack.stop).toHaveBeenCalled()
    expect(audioTrack.stop).toHaveBeenCalled()
    expect(mockDisconnect).toHaveBeenCalled()
  })

  // --- startSharing: error リセット ---

  it('startSharing: error がリセットされる', async () => {
    mockGetDisplayMedia.mockRejectedValueOnce(new Error('fail'))

    const ss = useScreenShare()
    await ss.startSharing('https://sig.example.com')
    expect(ss.error.value).not.toBeNull()

    // 2回目の startSharing で error リセット
    mockGetDisplayMedia.mockResolvedValue(createMockStream([createMockVideoTrack()]))
    await ss.startSharing('https://sig.example.com')
    expect(ss.error.value).toBeNull()
  })

  // --- webRtc props are passed through ---

  it('isPeerConnected, isConnected, remoteStream は webRtc から渡される', () => {
    const ss = useScreenShare()
    // These are the refs from the mock
    expect(ss.isPeerConnected.value).toBe(false)
    expect(ss.isConnected.value).toBe(false)
    expect(ss.remoteStream.value).toBeNull()
  })

  // --- screenStream without video tracks ---

  it('startSharing: videoTrack がない場合は onended を設定しない', async () => {
    mockGetDisplayMedia.mockResolvedValue(createMockStream([], []))

    const ss = useScreenShare()
    await ss.startSharing('https://sig.example.com')
    // No error, just no onended handler
    expect(ss.isSharing.value).toBe(true)
  })

  // --- connect failure with micStream cleanup ---

  it('startSharing: connect 失敗時、micStream が null でも安全', async () => {
    mockGetDisplayMedia.mockResolvedValue(createMockStream([createMockVideoTrack()]))
    mockGetUserMedia.mockRejectedValue(new Error('No mic'))
    mockConnect.mockRejectedValue(new Error('ws failed'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const ss = useScreenShare()
    await ss.startSharing('https://sig.example.com')

    // micStream is null because getUserMedia failed
    expect(ss.error.value).toBe('シグナリングサーバーへの接続に失敗しました')
    expect(ss.isSharing.value).toBe(false)
  })

  // --- 運行管理者の「画面共有を終了」 ---

  describe('運行管理者からの終了の合図 (endShareCount)', () => {
    const TIMERS = { toFake: ['setTimeout', 'clearTimeout'] as ('setTimeout' | 'clearTimeout')[] }

    it('合図で共有を止め、endedByAdmin が数秒だけ立つ', async () => {
      vi.useFakeTimers(TIMERS)
      const videoTrack = createMockVideoTrack()
      mockGetDisplayMedia.mockResolvedValue(createMockStream([videoTrack]))
      const [ss, app] = withSetup(() => useScreenShare())
      await ss.startSharing('https://sig.example.com')
      expect(ss.isSharing.value).toBe(true)
      expect(ss.endedByAdmin.value).toBe(false)

      endShareCount.value = 1
      await nextTick()
      expect(ss.isSharing.value).toBe(false)
      expect(ss.roomId.value).toBeNull()
      expect(videoTrack.stop).toHaveBeenCalled()
      expect(mockDisconnect).toHaveBeenCalled()
      expect(ss.endedByAdmin.value).toBe(true)

      vi.advanceTimersByTime(SCREEN_SHARE_ENDED_NOTICE_MS - 1)
      expect(ss.endedByAdmin.value).toBe(true)
      vi.advanceTimersByTime(1)
      expect(ss.endedByAdmin.value).toBe(false)
      app.unmount()
    })

    it('★ 見る側が抜けただけ (peer_left = isPeerConnected が false) では止まらない', async () => {
      const [ss, app] = withSetup(() => useScreenShare())
      await ss.startSharing('https://sig.example.com')
      isPeerConnected.value = true
      await nextTick()
      isPeerConnected.value = false
      await nextTick()

      expect(ss.isSharing.value).toBe(true)
      expect(ss.endedByAdmin.value).toBe(false)
      expect(mockDisconnect).not.toHaveBeenCalled()
      app.unmount()
    })

    it('合図が続けて来たら、消えるまでの時間は後の合図から数え直す', async () => {
      vi.useFakeTimers(TIMERS)
      const [ss, app] = withSetup(() => useScreenShare())

      endShareCount.value = 1
      await nextTick()
      vi.advanceTimersByTime(SCREEN_SHARE_ENDED_NOTICE_MS - 1000)
      endShareCount.value = 2
      await nextTick()
      vi.advanceTimersByTime(SCREEN_SHARE_ENDED_NOTICE_MS - 1)
      expect(ss.endedByAdmin.value).toBe(true)
      vi.advanceTimersByTime(1)
      expect(ss.endedByAdmin.value).toBe(false)
      app.unmount()
    })

    it('もう一度共有を始めたら、その場で消える', async () => {
      vi.useFakeTimers(TIMERS)
      const [ss, app] = withSetup(() => useScreenShare())
      endShareCount.value = 1
      await nextTick()
      expect(ss.endedByAdmin.value).toBe(true)

      await ss.startSharing('https://sig.example.com')
      expect(ss.endedByAdmin.value).toBe(false)
      expect(ss.isSharing.value).toBe(true)
      // 前の合図の時間切れが、後から何かを消すことはない
      vi.advanceTimersByTime(SCREEN_SHARE_ENDED_NOTICE_MS)
      expect(ss.isSharing.value).toBe(true)
      app.unmount()
    })

    it('出ている間に画面が消えたら、時間切れを待たずに片付ける', async () => {
      vi.useFakeTimers(TIMERS)
      const [ss, app] = withSetup(() => useScreenShare())
      endShareCount.value = 1
      await nextTick()
      expect(ss.endedByAdmin.value).toBe(true)

      app.unmount()
      expect(ss.endedByAdmin.value).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
