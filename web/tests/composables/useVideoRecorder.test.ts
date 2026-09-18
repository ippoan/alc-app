import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withSetup } from '../helpers/with-setup'
import { useVideoRecorder } from '~/composables/useVideoRecorder'

// MediaRecorder モック
class MockMediaRecorder {
  state = 'inactive' as 'inactive' | 'recording'
  ondataavailable: ((e: any) => void) | null = null
  onstop: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null

  static isTypeSupported = vi.fn(() => true)

  constructor(_stream: any, _options: any) {}

  start(_timeslice?: number) {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    // ondataavailable を先に呼ぶ
    this.ondataavailable?.({ data: new Blob(['test-data'], { type: 'video/webm' }) })
    this.onstop?.(new Event('stop'))
  }
}

describe('useVideoRecorder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('MediaRecorder', MockMediaRecorder)
  })

  it('初期値が正しい', () => {
    const { isRecording, recordedBlob, error } = useVideoRecorder()
    expect(isRecording.value).toBe(false)
    expect(recordedBlob.value).toBeNull()
    expect(error.value).toBeNull()
  })

  it('startRecording で録画開始', () => {
    const { startRecording, isRecording } = useVideoRecorder()
    const stream = {} as MediaStream
    startRecording(stream)
    expect(isRecording.value).toBe(true)
  })

  it('stopRecording で Blob が返る', async () => {
    const { startRecording, stopRecording } = useVideoRecorder()
    startRecording({} as MediaStream)
    const blob = await stopRecording()
    expect(blob).toBeInstanceOf(Blob)
  })

  it('stopRecording を録画前に呼んでも null', async () => {
    const { stopRecording } = useVideoRecorder()
    const blob = await stopRecording()
    expect(blob).toBeNull()
  })

  it('MediaRecorder 初期化失敗でエラー', () => {
    vi.stubGlobal('MediaRecorder', class {
      static isTypeSupported = vi.fn(() => true)
      constructor() { throw new Error('Not supported') }
    })

    const { startRecording, error, isRecording } = useVideoRecorder()
    startRecording({} as MediaStream)
    expect(error.value).toBe('録画の開始に失敗しました')
    expect(isRecording.value).toBe(false)
  })

  it('MediaRecorder onerror でエラー設定', () => {
    let capturedRecorder: any = null
    vi.stubGlobal('MediaRecorder', class {
      state = 'inactive' as string
      ondataavailable: any = null
      onstop: any = null
      onerror: any = null
      static isTypeSupported = vi.fn(() => true)
      constructor() { capturedRecorder = this }
      start() { this.state = 'recording' }
      stop() { this.state = 'inactive'; this.onstop?.(new Event('stop')) }
    })

    const { startRecording, error, isRecording } = useVideoRecorder()
    startRecording({} as MediaStream)
    expect(isRecording.value).toBe(true)

    // onerror を直接トリガー
    capturedRecorder.onerror()
    expect(error.value).toBe('録画中にエラーが発生しました')
    expect(isRecording.value).toBe(false)
  })

  it('isTypeSupported が false なら video/webm にフォールバック', () => {
    MockMediaRecorder.isTypeSupported.mockReturnValue(false)
    const { startRecording, isRecording } = useVideoRecorder()
    startRecording({} as MediaStream)
    expect(isRecording.value).toBe(true)
  })

  it('onUnmounted で録画中なら stop', () => {
    const [result, app] = withSetup(() => useVideoRecorder())
    result.startRecording({} as MediaStream)
    expect(result.isRecording.value).toBe(true)

    app.unmount()
    // onUnmounted で stop が呼ばれる
    expect(result.isRecording.value).toBe(false)
  })

  it('stopRecording chains prevOnStop handler when onstop was already set', async () => {
    const externalOnStop = vi.fn()
    let capturedRecorder: any = null
    vi.stubGlobal('MediaRecorder', class {
      state = 'inactive' as string
      ondataavailable: any = null
      onstop: any = null
      onerror: any = null
      static isTypeSupported = vi.fn(() => true)
      constructor() { capturedRecorder = this }
      start() { this.state = 'recording' }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['data'], { type: 'video/webm' }) })
        this.onstop?.(new Event('stop'))
      }
    })

    const { startRecording, stopRecording, recordedBlob } = useVideoRecorder()
    startRecording({} as MediaStream)

    // Save original onstop (set by startRecording) and replace with a custom one
    // that calls the original first (simulating a chain), then our spy
    const originalOnStop = capturedRecorder.onstop
    capturedRecorder.onstop = (e: Event) => {
      originalOnStop?.(e) // This sets recordedBlob
      externalOnStop(e)
    }

    const blob = await stopRecording()
    // stopRecording wraps the existing onstop, so the chain is:
    // stopRecording wrapper → prevOnStop (our custom) → originalOnStop (sets recordedBlob)
    expect(externalOnStop).toHaveBeenCalled()
    expect(recordedBlob.value).toBeInstanceOf(Blob)
    expect(blob).toBeInstanceOf(Blob)
  })

  it('stopRecording when prevOnStop is null (onstop cleared before stop)', async () => {
    let capturedRecorder: any = null
    vi.stubGlobal('MediaRecorder', class {
      state = 'inactive' as string
      ondataavailable: any = null
      onstop: any = null
      onerror: any = null
      static isTypeSupported = vi.fn(() => true)
      constructor() { capturedRecorder = this }
      start() { this.state = 'recording' }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['data'], { type: 'video/webm' }) })
        this.onstop?.(new Event('stop'))
      }
    })

    const { startRecording, stopRecording } = useVideoRecorder()
    startRecording({} as MediaStream)

    // Explicitly set onstop to null before stopRecording — prevOnStop will be null
    capturedRecorder.onstop = null

    const blob = await stopRecording()
    // stopRecording wraps null prevOnStop, so resolve still works
    // recordedBlob won't be set since original onstop was nulled, but resolve still fires
    expect(blob).toBeNull()
  })

  it('onUnmounted で録画未開始なら stop しない (mediaRecorder=null)', () => {
    const [, app] = withSetup(() => useVideoRecorder())
    // startRecording を呼ばずに unmount — mediaRecorder は null
    app.unmount()
    // No error should occur
  })

  it('onUnmounted で録画停止済みなら stop しない (state=inactive)', () => {
    let capturedRecorder: any = null
    vi.stubGlobal('MediaRecorder', class {
      state = 'inactive' as string
      ondataavailable: any = null
      onstop: any = null
      onerror: any = null
      static isTypeSupported = vi.fn(() => true)
      constructor() { capturedRecorder = this }
      start() { this.state = 'recording' }
      stop = vi.fn(() => {
        this.state = 'inactive'
        this.onstop?.(new Event('stop'))
      })
    })

    const [result, app] = withSetup(() => useVideoRecorder())
    result.startRecording({} as MediaStream)
    // Stop recording first so state is 'inactive'
    capturedRecorder.stop()
    capturedRecorder.stop.mockClear()

    app.unmount()
    // onUnmounted should NOT call stop again since state is 'inactive'
    expect(capturedRecorder.stop).not.toHaveBeenCalled()
  })

  // 段の切り替え (キオスクの v-else-if) で録画 blob を失わない (Refs ippoan/alc-app#349)
  it('stopRecording を 2 回呼んでも停止は 1 回で同じ Promise が返る', async () => {
    let capturedRecorder: any = null
    vi.stubGlobal('MediaRecorder', class {
      state = 'inactive' as string
      ondataavailable: any = null
      onstop: any = null
      onerror: any = null
      static isTypeSupported = vi.fn(() => true)
      constructor() { capturedRecorder = this }
      start() { this.state = 'recording' }
      stop = vi.fn(() => {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['data'], { type: 'video/webm' }) })
        this.onstop?.(new Event('stop'))
      })
    })

    const { startRecording, stopRecording } = useVideoRecorder()
    startRecording({} as MediaStream)

    const first = stopRecording()
    const second = stopRecording()
    expect(second).toBe(first)
    expect(await first).toBeInstanceOf(Blob)
    expect(capturedRecorder.stop).toHaveBeenCalledTimes(1)
  })

  it('unmount 後に stopRecording を呼んでも blob が取り出せる', async () => {
    const [result, app] = withSetup(() => useVideoRecorder())
    result.startRecording({} as MediaStream)
    expect(result.isRecording.value).toBe(true)

    // 段が切り替わって unmount — onUnmounted が stopRecording と同じ経路で止める
    app.unmount()
    expect(result.isRecording.value).toBe(false)

    // 呼び出し側が後から await しても blob は消えていない
    expect(await result.stopRecording()).toBeInstanceOf(Blob)
  })

  it('startRecording で停止の記憶がリセットされ、次の録画も止められる', async () => {
    const { startRecording, stopRecording } = useVideoRecorder()
    startRecording({} as MediaStream)
    await stopRecording()

    startRecording({} as MediaStream)
    expect(await stopRecording()).toBeInstanceOf(Blob)
  })

  it('ondataavailable で size=0 のデータは無視', async () => {
    vi.stubGlobal('MediaRecorder', class {
      state = 'inactive' as string
      ondataavailable: any = null
      onstop: any = null
      onerror: any = null
      static isTypeSupported = vi.fn(() => true)
      start() { this.state = 'recording' }
      stop() {
        this.state = 'inactive'
        // size=0 のデータ
        this.ondataavailable?.({ data: { size: 0 } })
        // 有効なデータ
        this.ondataavailable?.({ data: new Blob(['real-data'], { type: 'video/webm' }) })
        this.onstop?.(new Event('stop'))
      }
    })

    const { startRecording, stopRecording, recordedBlob } = useVideoRecorder()
    startRecording({} as MediaStream)
    await stopRecording()
    expect(recordedBlob.value).toBeInstanceOf(Blob)
  })
})
