import { describe, it, expect, beforeEach, vi } from 'vitest'
import { toRaw } from 'vue'
import { useCamera } from '~/composables/useCamera'
import { withSetup } from '../helpers/with-setup'

const envMock = vi.hoisted(() => ({
  isClient: true,
}))
vi.mock('~/utils/env', () => envMock)

describe('useCamera', () => {
  let mockGetUserMedia: ReturnType<typeof vi.fn>
  let mockTrackStop: ReturnType<typeof vi.fn>

  function createMockStream() {
    mockTrackStop = vi.fn()
    return {
      getTracks: () => [{ stop: mockTrackStop }],
    } as unknown as MediaStream
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUserMedia = vi.fn()

    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: mockGetUserMedia },
      configurable: true,
      writable: true,
    })
    Object.defineProperty(navigator, 'permissions', {
      value: { query: vi.fn().mockResolvedValue({ state: 'granted' }) },
      configurable: true,
      writable: true,
    })
  })

  describe('start', () => {
    it('デスクトップ解像度 (1920x1080)', async () => {
      Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows)', configurable: true })
      mockGetUserMedia.mockResolvedValue(createMockStream())

      const cam = useCamera()
      await cam.start()

      expect(mockGetUserMedia).toHaveBeenCalledWith(expect.objectContaining({
        video: expect.objectContaining({ width: { ideal: 1920 }, height: { ideal: 1080 } }),
      }))
      expect(cam.isActive.value).toBe(true)
    })

    it('モバイル解像度 (1280x720)', async () => {
      Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 14)', configurable: true })
      mockGetUserMedia.mockResolvedValue(createMockStream())

      const cam = useCamera()
      await cam.start()

      expect(mockGetUserMedia).toHaveBeenCalledWith(expect.objectContaining({
        video: expect.objectContaining({ width: { ideal: 1280 }, height: { ideal: 720 } }),
      }))
    })

    it('Kyocera TB305 は 640x480', async () => {
      Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 14)', configurable: true })
      mockGetUserMedia.mockResolvedValue(createMockStream())

      const cam = useCamera()
      await cam.start('user', 'TB305-device')

      expect(mockGetUserMedia).toHaveBeenCalledWith(expect.objectContaining({
        video: expect.objectContaining({ width: { ideal: 640 }, height: { ideal: 480 } }),
      }))
    })

    it('deviceModel が null でも動く', async () => {
      Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows)', configurable: true })
      mockGetUserMedia.mockResolvedValue(createMockStream())

      const cam = useCamera()
      await cam.start('user', null)
      expect(cam.isActive.value).toBe(true)
    })

    it('permissions.query denied → エラー + throw', async () => {
      Object.defineProperty(navigator, 'permissions', {
        value: { query: vi.fn().mockResolvedValue({ state: 'denied' }) },
        configurable: true,
      })

      const cam = useCamera()
      await expect(cam.start()).rejects.toThrow()
      expect(cam.permissionDenied.value).toBe(true)
      expect(cam.error.value).toContain('カメラの権限')
    })

    it('permissions.query 非対応 → getUserMedia へ進む', async () => {
      Object.defineProperty(navigator, 'permissions', {
        value: { query: vi.fn().mockRejectedValue(new TypeError('not supported')) },
        configurable: true,
      })
      mockGetUserMedia.mockResolvedValue(createMockStream())

      const cam = useCamera()
      await cam.start()
      expect(cam.isActive.value).toBe(true)
    })

    it('getUserMedia NotAllowedError → permissionDenied', async () => {
      mockGetUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))

      const cam = useCamera()
      await expect(cam.start()).rejects.toThrow()
      expect(cam.permissionDenied.value).toBe(true)
    })

    it('getUserMedia 一般エラー', async () => {
      mockGetUserMedia.mockRejectedValue(new Error('Device not found'))

      const cam = useCamera()
      await expect(cam.start()).rejects.toThrow('Device not found')
      expect(cam.error.value).toBe('Device not found')
      expect(cam.permissionDenied.value).toBe(false)
    })

    describe('NotReadableError → 他のカメラを順に試す', () => {
      const notReadable = new DOMException('Could not start video source', 'NotReadableError')
      function withDevices(devices: Partial<MediaDeviceInfo>[]) {
        (navigator.mediaDevices as any).enumerateDevices = vi.fn().mockResolvedValue(devices)
      }

      it('2 台目で開ければそれを使う (videoinput だけを deviceId 指定で)', async () => {
        withDevices([
          { kind: 'audioinput', deviceId: 'mic', label: 'Mic' },
          { kind: 'videoinput', deviceId: 'cam-a', label: 'Cam A' },
          { kind: 'videoinput', deviceId: 'cam-b', label: '' },
        ])
        const stream = createMockStream()
        mockGetUserMedia
          .mockRejectedValueOnce(notReadable)
          .mockRejectedValueOnce(new DOMException('busy', 'NotReadableError'))
          .mockResolvedValueOnce(stream)

        const cam = useCamera()
        await cam.start()

        expect(toRaw(cam.stream.value)).toBe(stream)
        expect(mockGetUserMedia).toHaveBeenCalledTimes(3)
        expect(mockGetUserMedia.mock.calls[1]![0].video.deviceId).toEqual({ exact: 'cam-a' })
        expect(mockGetUserMedia.mock.calls[2]![0].video.deviceId).toEqual({ exact: 'cam-b' })
      })

      it('どれも開けなければ最初のエラーを投げる (DOMException 以外の失敗も続ける)', async () => {
        withDevices([{ kind: 'videoinput', deviceId: 'cam-a', label: 'Cam A' }, { kind: 'videoinput', deviceId: 'cam-b', label: '' }])
        mockGetUserMedia
          .mockRejectedValueOnce(notReadable)
          .mockRejectedValueOnce('odd')
          .mockRejectedValueOnce(new DOMException('busy', 'NotReadableError'))

        const cam = useCamera()
        await expect(cam.start()).rejects.toBe(notReadable)
        expect(cam.error.value).toBe('Could not start video source')
        expect(cam.isActive.value).toBe(false)
      })
    })

    it('非 Error throw', async () => {
      mockGetUserMedia.mockRejectedValue('unknown')

      const cam = useCamera()
      await expect(cam.start()).rejects.toBe('unknown')
      expect(cam.error.value).toBe('カメラの起動に失敗しました')
    })

    it('navigator.permissions undefined', async () => {
      Object.defineProperty(navigator, 'permissions', { value: undefined, configurable: true })
      mockGetUserMedia.mockResolvedValue(createMockStream())

      const cam = useCamera()
      await cam.start()
      expect(cam.isActive.value).toBe(true)
    })

    it('videoRef 設定済みなら srcObject + play', async () => {
      mockGetUserMedia.mockResolvedValue(createMockStream())
      const cam = useCamera()
      const mockVideo = { srcObject: null, play: vi.fn().mockResolvedValue(undefined) } as any
      cam.videoRef.value = mockVideo

      await cam.start()
      expect(mockVideo.srcObject).toBeTruthy()
      expect(mockVideo.play).toHaveBeenCalled()
    })
  })

  describe('stop', () => {
    it('トラック停止 + 状態リセット', async () => {
      mockGetUserMedia.mockResolvedValue(createMockStream())
      const cam = useCamera()
      await cam.start()
      cam.stop()

      expect(mockTrackStop).toHaveBeenCalled()
      expect(cam.isActive.value).toBe(false)
      expect(cam.stream.value).toBeNull()
    })

    it('videoRef の srcObject クリア', async () => {
      mockGetUserMedia.mockResolvedValue(createMockStream())
      const cam = useCamera()
      cam.videoRef.value = { srcObject: null, play: vi.fn().mockResolvedValue(undefined) } as any
      await cam.start()
      cam.stop()
      expect(cam.videoRef.value!.srcObject).toBeNull()
    })

    it('未開始でも安全', () => {
      useCamera().stop()
    })
  })

  describe('takeSnapshot', () => {
    it('videoRef なしで null', () => {
      expect(useCamera().takeSnapshot()).toBeNull()
    })

    it('未起動で null', async () => {
      mockGetUserMedia.mockResolvedValue(createMockStream())
      const cam = useCamera()
      await cam.start()
      expect(cam.takeSnapshot()).toBeNull()
    })

    it('正常: canvas に描画して blob 返却', async () => {
      mockGetUserMedia.mockResolvedValue(createMockStream())
      const cam = useCamera()
      const mockVideo = {
        srcObject: null,
        play: vi.fn().mockResolvedValue(undefined),
        videoWidth: 640,
        videoHeight: 480,
      } as any
      cam.videoRef.value = mockVideo
      await cam.start()

      const fakeBlob = new Blob(['test'], { type: 'image/jpeg' })
      const drawImage = vi.fn()
      const mockCtx = { drawImage }
      const origCreateElement = document.createElement.bind(document)
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        if (tag === 'canvas') {
          const canvas = origCreateElement('canvas') as HTMLCanvasElement
          vi.spyOn(canvas, 'getContext').mockReturnValue(mockCtx as any)
          vi.spyOn(canvas, 'toBlob').mockImplementation((cb) => cb(fakeBlob))
          return canvas
        }
        return origCreateElement(tag)
      })

      const result = cam.takeSnapshot()
      expect(drawImage).toHaveBeenCalledWith(mockVideo, 0, 0)
      expect(result).toBe(fakeBlob)

      vi.restoreAllMocks()
    })

    it('getContext null → null 返却', async () => {
      mockGetUserMedia.mockResolvedValue(createMockStream())
      const cam = useCamera()
      const mockVideo = {
        srcObject: null,
        play: vi.fn().mockResolvedValue(undefined),
        videoWidth: 640,
        videoHeight: 480,
      } as any
      cam.videoRef.value = mockVideo
      await cam.start()

      const origCreateElement = document.createElement.bind(document)
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        if (tag === 'canvas') {
          const canvas = origCreateElement('canvas') as HTMLCanvasElement
          vi.spyOn(canvas, 'getContext').mockReturnValue(null)
          return canvas
        }
        return origCreateElement(tag)
      })

      expect(cam.takeSnapshot()).toBeNull()
      vi.restoreAllMocks()
    })
  })

  describe('takeSnapshotAsync', () => {
    it('videoRef なしで null', async () => {
      expect(await useCamera().takeSnapshotAsync()).toBeNull()
    })

    it('正常: canvas に描画して blob を Promise で返却', async () => {
      mockGetUserMedia.mockResolvedValue(createMockStream())
      const cam = useCamera()
      const mockVideo = {
        srcObject: null,
        play: vi.fn().mockResolvedValue(undefined),
        videoWidth: 640,
        videoHeight: 480,
      } as any
      cam.videoRef.value = mockVideo
      await cam.start()

      const fakeBlob = new Blob(['test'], { type: 'image/jpeg' })
      const drawImage = vi.fn()
      const mockCtx = { drawImage }
      const origCreateElement = document.createElement.bind(document)
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        if (tag === 'canvas') {
          const canvas = origCreateElement('canvas') as HTMLCanvasElement
          vi.spyOn(canvas, 'getContext').mockReturnValue(mockCtx as any)
          vi.spyOn(canvas, 'toBlob').mockImplementation((cb) => cb(fakeBlob))
          return canvas
        }
        return origCreateElement(tag)
      })

      const result = await cam.takeSnapshotAsync()
      expect(drawImage).toHaveBeenCalledWith(mockVideo, 0, 0)
      expect(result).toBe(fakeBlob)

      vi.restoreAllMocks()
    })

    it('getContext null → null 返却', async () => {
      mockGetUserMedia.mockResolvedValue(createMockStream())
      const cam = useCamera()
      const mockVideo = {
        srcObject: null,
        play: vi.fn().mockResolvedValue(undefined),
        videoWidth: 640,
        videoHeight: 480,
      } as any
      cam.videoRef.value = mockVideo
      await cam.start()

      const origCreateElement = document.createElement.bind(document)
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        if (tag === 'canvas') {
          const canvas = origCreateElement('canvas') as HTMLCanvasElement
          vi.spyOn(canvas, 'getContext').mockReturnValue(null)
          return canvas
        }
        return origCreateElement(tag)
      })

      expect(await cam.takeSnapshotAsync()).toBeNull()
      vi.restoreAllMocks()
    })
  })

  describe('onUnmounted', () => {
    it('unmount 時に stop() が呼ばれる', async () => {
      mockGetUserMedia.mockResolvedValue(createMockStream())

      const [cam, app] = withSetup(() => useCamera())
      await cam.start()
      expect(cam.isActive.value).toBe(true)

      app.unmount()
      expect(cam.isActive.value).toBe(false)
      expect(mockTrackStop).toHaveBeenCalled()
    })
  })

  describe('SSR (isClient=false)', () => {
    it('switchToDummyCamera is not set when isClient=false', async () => {
      delete (window as any).switchToDummyCamera
      envMock.isClient = false
      vi.resetModules()
      await import('~/composables/useCamera')
      expect((window as any).switchToDummyCamera).toBeUndefined()
      // Restore: re-import with isClient=true to re-register the side effect
      envMock.isClient = true
      vi.resetModules()
      await import('~/composables/useCamera')
    })
  })

  describe('switchToDummyCamera', () => {
    it('window に存在する', () => {
      expect(typeof (window as any).switchToDummyCamera).toBe('function')
    })

    it('全 video 要素の srcObject を差し替え', () => {
      const mockPlay = vi.fn()
      const mockVideo1 = { srcObject: null, play: mockPlay } as any
      const mockVideo2 = { srcObject: null, play: mockPlay } as any

      vi.spyOn(document, 'querySelectorAll').mockReturnValue([mockVideo1, mockVideo2] as any)

      const origCreateElement = document.createElement.bind(document)
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        if (tag === 'canvas') {
          const canvas = origCreateElement('canvas') as HTMLCanvasElement
          const mockCtx = {
            createLinearGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
            fillRect: vi.fn(),
            beginPath: vi.fn(),
            moveTo: vi.fn(),
            quadraticCurveTo: vi.fn(),
            lineTo: vi.fn(),
            closePath: vi.fn(),
            fill: vi.fn(),
            ellipse: vi.fn(),
            arc: vi.fn(),
            stroke: vi.fn(),
            set fillStyle(_: any) {},
            set strokeStyle(_: any) {},
            set lineWidth(_: any) {},
          }
          vi.spyOn(canvas, 'getContext').mockReturnValue(mockCtx as any)
          const fakeStream = { id: 'dummy' } as any
          vi.spyOn(canvas, 'captureStream').mockReturnValue(fakeStream)
          return canvas
        }
        return origCreateElement(tag)
      })

      ;(window as any).switchToDummyCamera()

      expect(mockVideo1.srcObject).toBeTruthy()
      expect(mockVideo2.srcObject).toBeTruthy()
      expect(mockPlay).toHaveBeenCalledTimes(2)

      vi.restoreAllMocks()
    })
  })
})
