import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, readonly, nextTick, toRaw } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { IT_TENKO_POLL_INTERVAL_MS, useItTenkoCall } from '~/composables/useItTenkoCall'
import { withSetup } from '../helpers/with-setup'

// IT点呼 の通話と判定待ち (Refs ippoan/alc-app#387)。
// 下の層 (useCamera / useWebRtc / getTenkoSession / マイク) だけを差し替える。

// --- 点呼の記録の取得 ---

const getTenkoSessionMock = vi.fn()
vi.mock('~/utils/api', () => ({
  getTenkoSession: (...args: unknown[]) => getTenkoSessionMock(...args),
}))

// --- カメラ ---

class FakeTrack {
  stop = vi.fn()
  constructor(public kind: 'video' | 'audio') {}
}
/** `new MediaStream([...tracks])` と `getVideoTracks` / `getAudioTracks` だけを持つ代用品 */
class FakeMediaStream {
  tracks: FakeTrack[]
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks
  }

  getTracks() { return this.tracks }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video') }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio') }
}

const cameraStream = ref<FakeMediaStream | null>(null)
const cameraStart = vi.fn()
const cameraStop = vi.fn(() => { cameraStream.value = null })
mockNuxtImport('useCamera', () => () => ({
  stream: readonly(cameraStream),
  start: cameraStart,
  stop: cameraStop,
}))

// --- 通話 ---

const rtc = {
  isConnected: ref(false),
  isPeerConnected: ref(false),
  remoteStream: ref<MediaStream | null>(null),
  error: ref<string | null>(null),
}
const rtcConnect = vi.fn()
const rtcStartStreaming = vi.fn()
const rtcDisconnect = vi.fn()
const useWebRtcSpy = vi.fn()
mockNuxtImport('useWebRtc', () => (role: string) => {
  useWebRtcSpy(role)
  return {
    isConnected: readonly(rtc.isConnected),
    isPeerConnected: readonly(rtc.isPeerConnected),
    remoteStream: readonly(rtc.remoteStream),
    error: readonly(rtc.error),
    connect: rtcConnect,
    startStreaming: rtcStartStreaming,
    disconnect: rtcDisconnect,
  }
})

// --- マイク ---

const getUserMedia = vi.fn()

/** 判定が付いていない点呼の記録 */
function session(judgment: string | null = null, reason: string | null = null) {
  return { id: 'session-1', manager_judgment: judgment, manager_judgment_reason: reason }
}

/** 解決を外から握れる Promise */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('useItTenkoCall', () => {
  let app: ReturnType<typeof withSetup>[1] | null = null
  let originalMediaStream: typeof MediaStream

  function setup() {
    const [call, created] = withSetup(() => useItTenkoCall())
    app = created
    return call
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    cameraStream.value = null
    cameraStart.mockImplementation(async () => {
      cameraStream.value = new FakeMediaStream([new FakeTrack('video')])
    })
    rtc.isConnected.value = false
    rtc.isPeerConnected.value = false
    rtc.error.value = null
    rtcConnect.mockImplementation(async () => {})
    rtcStartStreaming.mockImplementation(async () => {})
    getTenkoSessionMock.mockImplementation(async () => session())
    getUserMedia.mockImplementation(async () => new FakeMediaStream([new FakeTrack('audio')]))
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
    originalMediaStream = globalThis.MediaStream
    vi.stubGlobal('MediaStream', FakeMediaStream)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    app?.unmount()
    app = null
    vi.useRealTimers()
    vi.stubGlobal('MediaStream', originalMediaStream)
    delete (navigator as unknown as Record<string, unknown>).mediaDevices
    vi.restoreAllMocks()
  })

  /** ポーリングを 1 回ぶん進め、取得の await を消化する */
  async function tick() {
    await vi.advanceTimersByTimeAsync(IT_TENKO_POLL_INTERVAL_MS)
  }

  it('生成しただけでは何も始めない (device 側として useWebRtc を 1 つ作るだけ)', () => {
    const call = setup()

    expect(useWebRtcSpy).toHaveBeenCalledTimes(1)
    expect(useWebRtcSpy).toHaveBeenCalledWith('device')
    expect(call.state.value).toBe('idle')
    expect(call.judgment.value).toBeNull()
    expect(cameraStart).not.toHaveBeenCalled()
    expect(rtcConnect).not.toHaveBeenCalled()
    expect(getTenkoSessionMock).not.toHaveBeenCalled()
  })

  it('★ start: カメラとマイクを取り、signaling の URL と点呼の記録の id で繋いで送り始める', async () => {
    const call = setup()

    await call.start('session-1')

    expect(cameraStart).toHaveBeenCalledWith('user')
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false })
    // **呼ぶ側は token も path も渡さない** (開発用の端末のトークンは useWebRtc が自分で付ける)
    expect(rtcConnect).toHaveBeenCalledTimes(1)
    expect(rtcConnect).toHaveBeenCalledWith(useRuntimeConfig().public.signalingUrl, 'session-1')
    // 送るのは映像 + 音声を合成したもの
    const sent = rtcStartStreaming.mock.calls[0]![0] as FakeMediaStream
    expect(sent.getTracks().map(t => t.kind)).toEqual(['video', 'audio'])
    expect(toRaw(call.localStream.value)).toBe(sent)
    expect(call.state.value).toBe('calling')
  })

  it('マイクを断られたら映像だけで続ける', async () => {
    getUserMedia.mockRejectedValue(new Error('denied'))
    const call = setup()

    await call.start('session-1')

    const sent = rtcStartStreaming.mock.calls[0]![0] as FakeMediaStream
    expect(sent.getTracks().map(t => t.kind)).toEqual(['video'])
    expect(call.state.value).toBe('calling')
  })

  it('★ 判定が付くまで 3 秒ごとに引き直し、付いたら通話を切って判定を出す', async () => {
    const call = setup()
    await call.start('session-1')
    const audio = (rtcStartStreaming.mock.calls[0]![0] as FakeMediaStream).getAudioTracks()[0]!
    rtcDisconnect.mockClear()
    cameraStop.mockClear()

    await tick()
    expect(getTenkoSessionMock).toHaveBeenCalledTimes(1)
    // scope は既定 (キオスクの鍵で読む)
    expect(getTenkoSessionMock).toHaveBeenCalledWith('session-1')
    expect(call.state.value).toBe('calling')
    expect(rtcDisconnect).not.toHaveBeenCalled()

    getTenkoSessionMock.mockResolvedValue(session('ng', '顔色が悪い'))
    await tick()

    expect(call.state.value).toBe('judged')
    expect(call.judgment.value).toEqual({ judgment: 'ng', reason: '顔色が悪い' })
    expect(rtcDisconnect).toHaveBeenCalledTimes(1)
    expect(cameraStop).toHaveBeenCalledTimes(1)
    expect(audio.stop).toHaveBeenCalledTimes(1)
    expect(call.localStream.value).toBeNull()

    // 判定のあとは引き直さない
    await tick()
    expect(getTenkoSessionMock).toHaveBeenCalledTimes(2)
  })

  it('OK の判定 (理由なし) も同じく出す', async () => {
    getTenkoSessionMock.mockResolvedValue(session('ok'))
    const call = setup()
    await call.start('session-1')

    await tick()

    expect(call.judgment.value).toEqual({ judgment: 'ok', reason: null })
    expect(call.state.value).toBe('judged')
  })

  it('知らない値の判定では完了にしない (待ち続ける)', async () => {
    getTenkoSessionMock.mockResolvedValue(session('pending'))
    const call = setup()
    await call.start('session-1')

    await tick()

    expect(call.state.value).toBe('calling')
    expect(call.judgment.value).toBeNull()
  })

  it('引き直しが一時的に失敗しても判定待ちをやめない', async () => {
    const call = setup()
    await call.start('session-1')

    getTenkoSessionMock.mockRejectedValueOnce(new Error('network'))
    await tick()
    expect(call.state.value).toBe('calling')

    getTenkoSessionMock.mockResolvedValue(session('ok'))
    await tick()
    expect(call.state.value).toBe('judged')
  })

  it('★ signaling に繋げなければ「通話できない」にして、何も残さない (token なしで繋ぎ直さない)', async () => {
    rtcConnect.mockRejectedValue(new Error('token unavailable'))
    const call = setup()

    await call.start('session-1')

    expect(call.state.value).toBe('unavailable')
    expect(rtcConnect).toHaveBeenCalledTimes(1)
    expect(rtcStartStreaming).not.toHaveBeenCalled()
    expect(cameraStop).toHaveBeenCalled()
    expect(call.localStream.value).toBeNull()
    // 判定待ちも始めない
    await tick()
    expect(getTenkoSessionMock).not.toHaveBeenCalled()
  })

  it('カメラが取れなければ「通話できない」にする (signaling には繋がない)', async () => {
    cameraStart.mockRejectedValue(new Error('NotAllowedError'))
    const call = setup()

    await call.start('session-1')

    expect(call.state.value).toBe('unavailable')
    expect(rtcConnect).not.toHaveBeenCalled()
  })

  it('★ 二重の start では二重に繋がない', async () => {
    const call = setup()

    const first = call.start('session-1')
    const second = call.start('session-1')
    await Promise.all([first, second])
    await call.start('session-2')

    expect(cameraStart).toHaveBeenCalledTimes(1)
    expect(rtcConnect).toHaveBeenCalledTimes(1)
    expect(rtcConnect).toHaveBeenCalledWith(expect.anything(), 'session-1')
  })

  it('★ stop: 判定待ちと通話を止めて初めの状態へ戻す', async () => {
    const call = setup()
    await call.start('session-1')
    rtcDisconnect.mockClear()

    call.stop()

    expect(call.state.value).toBe('idle')
    expect(rtcDisconnect).toHaveBeenCalledTimes(1)
    expect(cameraStop).toHaveBeenCalled()
    expect(call.localStream.value).toBeNull()
    await tick()
    expect(getTenkoSessionMock).not.toHaveBeenCalled()

    // stop のあとは次の通話を始められる
    await call.start('session-2')
    expect(rtcConnect).toHaveBeenLastCalledWith(expect.anything(), 'session-2')
    expect(call.state.value).toBe('calling')
  })

  it('stop のあとに届いた引き直しの応答では判定を出さない', async () => {
    const pending = deferred<ReturnType<typeof session>>()
    getTenkoSessionMock.mockReturnValue(pending.promise)
    const call = setup()
    await call.start('session-1')
    await tick()

    call.stop()
    pending.resolve(session('ok'))
    await pending.promise
    await nextTick()

    expect(call.state.value).toBe('idle')
    expect(call.judgment.value).toBeNull()
  })

  it('カメラを待つあいだに stop されたら、開いたぶんを閉じて繋がない', async () => {
    const gate = deferred()
    cameraStart.mockImplementation(async () => {
      await gate.promise
      cameraStream.value = new FakeMediaStream([new FakeTrack('video')])
    })
    const mic = new FakeMediaStream([new FakeTrack('audio')])
    getUserMedia.mockResolvedValue(mic)
    const call = setup()

    const starting = call.start('session-1')
    call.stop()
    cameraStop.mockClear()
    gate.resolve()
    await starting

    expect(rtcConnect).not.toHaveBeenCalled()
    expect(cameraStop).toHaveBeenCalledTimes(1)
    expect(mic.tracks[0]!.stop).toHaveBeenCalledTimes(1)
    expect(call.state.value).toBe('idle')
  })

  it('signaling を待つあいだに stop されたら、通話中にしない (判定待ちも始めない)', async () => {
    const gate = deferred()
    rtcConnect.mockReturnValue(gate.promise)
    const call = setup()

    const starting = call.start('session-1')
    await vi.waitFor(() => expect(rtcConnect).toHaveBeenCalled())
    call.stop()
    gate.resolve()
    await starting

    expect(call.state.value).toBe('idle')
    await tick()
    expect(getTenkoSessionMock).not.toHaveBeenCalled()
  })

  it('signaling を待つあいだに stop されたあとで失敗が届いても「通話できない」にしない', async () => {
    const gate = deferred()
    rtcConnect.mockReturnValue(gate.promise)
    const call = setup()

    const starting = call.start('session-1')
    await vi.waitFor(() => expect(rtcConnect).toHaveBeenCalled())
    call.stop()
    gate.reject(new Error('closed'))
    await starting

    expect(call.state.value).toBe('idle')
  })

  describe('再接続', () => {
    it('運行管理者が一度つながってから切れたら isDisconnected が立ち、reconnect で繋ぎ直す', async () => {
      const call = setup()
      await call.start('session-1')
      expect(call.isDisconnected.value).toBe(false)

      rtc.isPeerConnected.value = true
      await nextTick()
      expect(call.isDisconnected.value).toBe(false)
      rtc.isPeerConnected.value = false
      await nextTick()
      expect(call.isDisconnected.value).toBe(true)

      await call.reconnect()

      expect(rtcConnect).toHaveBeenCalledTimes(2)
      expect(rtcConnect).toHaveBeenLastCalledWith(useRuntimeConfig().public.signalingUrl, 'session-1')
      expect(call.state.value).toBe('calling')
      // 繋ぎ直したので「切れた」の印は下ろす
      expect(call.isDisconnected.value).toBe(false)

      // 判定待ちは 1 本だけ (繋ぎ直しで二重にならない)
      await tick()
      expect(getTenkoSessionMock).toHaveBeenCalledTimes(1)
    })

    it('始められなかった通話も reconnect でやり直せる', async () => {
      rtcConnect.mockRejectedValueOnce(new Error('token unavailable'))
      const call = setup()
      await call.start('session-1')
      expect(call.state.value).toBe('unavailable')

      await call.reconnect()

      expect(call.state.value).toBe('calling')
      expect(rtcConnect).toHaveBeenCalledTimes(2)
    })

    it('始めていない / 開いている途中 / 判定済み では何もしない', async () => {
      const call = setup()
      await call.reconnect()
      expect(rtcConnect).not.toHaveBeenCalled()

      const gate = deferred()
      rtcConnect.mockReturnValueOnce(gate.promise)
      const starting = call.start('session-1')
      await vi.waitFor(() => expect(rtcConnect).toHaveBeenCalledTimes(1))
      await call.reconnect()
      expect(rtcConnect).toHaveBeenCalledTimes(1)
      gate.resolve()
      await starting

      getTenkoSessionMock.mockResolvedValue(session('ok'))
      await tick()
      expect(call.state.value).toBe('judged')
      await call.reconnect()
      expect(rtcConnect).toHaveBeenCalledTimes(1)
    })
  })

  it('signaling の失敗の文言と通話の状態をそのまま見せる', async () => {
    const call = setup()

    rtc.error.value = 'この通話には参加できません'
    rtc.isConnected.value = true

    expect(call.error.value).toBe('この通話には参加できません')
    expect(call.isConnected.value).toBe(true)
    expect(call.isPeerConnected.value).toBe(false)
    expect(call.remoteStream.value).toBeNull()
  })

  it('★ unmount で止まり、そのあとの start ではカメラを開かない', async () => {
    const call = setup()
    await call.start('session-1')
    rtcDisconnect.mockClear()

    app!.unmount()
    app = null

    expect(rtcDisconnect).toHaveBeenCalled()
    await tick()
    expect(getTenkoSessionMock).not.toHaveBeenCalled()

    // 保存の応答が unmount のあとに返ってきた場合 — 止める人の居ないカメラを開かない
    cameraStart.mockClear()
    await call.start('session-2')
    expect(cameraStart).not.toHaveBeenCalled()
    expect(call.state.value).toBe('idle')
  })
})
