import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import { withSetup } from '../helpers/with-setup'
import { useBlowVideoRecording } from '~/composables/useBlowVideoRecording'

// --- 下層はすべて mock する。ここで見るのは「配線」だけ ---
// (MediaRecorder / IndexedDB / R2 の中身は useVideoRecorder / video-store /
//  offline-queue のテストが担当する)

vi.mock('~/utils/api', () => ({
  updateMeasurement: vi.fn(),
}))

vi.mock('~/utils/offline-queue', () => ({
  uploadLinkedVideo: vi.fn(),
}))

vi.mock('~/utils/video-store', () => ({
  saveVideo: vi.fn(),
  getPendingVideos: vi.fn(),
  cleanupOldVideos: vi.fn(),
}))

const cameraStream = ref<MediaStream | null>(null)
const cameraIsActive = ref(false)
const cameraStart = vi.fn(async () => { cameraIsActive.value = true })
const cameraStop = vi.fn(() => { cameraIsActive.value = false })
mockNuxtImport('useCamera', () => () => ({
  stream: cameraStream,
  videoRef: ref(null),
  isActive: cameraIsActive,
  start: cameraStart,
  stop: cameraStop,
}))

const isRecording = ref(false)
const startRecording = vi.fn((_s: MediaStream) => { isRecording.value = true })
const stopRecording = vi.fn(async () => null as Blob | null)
mockNuxtImport('useVideoRecorder', () => () => ({
  isRecording,
  recordedBlob: ref(null),
  error: ref(null),
  startRecording,
  stopRecording,
}))

const STREAM = {} as MediaStream

describe('composables/useBlowVideoRecording', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cameraStream.value = null
    cameraIsActive.value = false
    isRecording.value = false
    stopRecording.mockResolvedValue(null)
    vi.stubGlobal('crypto', { randomUUID: () => 'vid-uuid-1' })
  })

  describe('retryPendingUploads (起動時の後片付け)', () => {
    it('7 日超を削除し、measurement に紐づく未アップロード分を送り直す', async () => {
      const { cleanupOldVideos, getPendingVideos } = await import('~/utils/video-store')
      const { uploadLinkedVideo } = await import('~/utils/offline-queue')
      const { updateMeasurement } = await import('~/utils/api')
      vi.mocked(cleanupOldVideos).mockResolvedValue(0)
      vi.mocked(getPendingVideos).mockResolvedValue([
        { id: 'v1', videoBlob: new Blob(['a']), employeeId: 'e1', measurementId: 'm1', createdAt: 'x' },
        // measurement に紐づいていないものは送れない (video_url を載せる先が無い)
        { id: 'v2', videoBlob: new Blob(['b']), employeeId: 'e1', createdAt: 'x' },
      ])

      const { retryPendingUploads } = useBlowVideoRecording()
      await retryPendingUploads()

      expect(cleanupOldVideos).toHaveBeenCalledWith(7)
      expect(uploadLinkedVideo).toHaveBeenCalledTimes(1)
      expect(uploadLinkedVideo).toHaveBeenCalledWith('v1', 'm1', updateMeasurement)
    })

    it('cleanupOldVideos が失敗しても投げない', async () => {
      const { cleanupOldVideos, getPendingVideos } = await import('~/utils/video-store')
      vi.mocked(cleanupOldVideos).mockRejectedValue(new Error('quota'))
      vi.mocked(getPendingVideos).mockResolvedValue([])

      const { retryPendingUploads } = useBlowVideoRecording()
      await expect(retryPendingUploads()).resolves.toBeUndefined()
    })

    it('IndexedDB が読めなくても投げない', async () => {
      const { cleanupOldVideos, getPendingVideos } = await import('~/utils/video-store')
      const { uploadLinkedVideo } = await import('~/utils/offline-queue')
      vi.mocked(cleanupOldVideos).mockResolvedValue(0)
      vi.mocked(getPendingVideos).mockRejectedValue(new Error('no idb'))

      const { retryPendingUploads } = useBlowVideoRecording()
      await expect(retryPendingUploads()).resolves.toBeUndefined()
      expect(uploadLinkedVideo).not.toHaveBeenCalled()
    })
  })

  describe('startCamera', () => {
    it('カメラを起こすだけでは録画は始めない', async () => {
      cameraStream.value = STREAM
      const { startCamera, isCameraActive } = useBlowVideoRecording()
      await startCamera()

      expect(cameraStart).toHaveBeenCalledWith('user')
      expect(startRecording).not.toHaveBeenCalled()
      expect(isCameraActive.value).toBe(true)
    })

    it('recordImmediately ならその場で録画を始める (デモモード)', async () => {
      cameraStream.value = STREAM
      const { startCamera } = useBlowVideoRecording()
      await startCamera({ recordImmediately: true })

      expect(startRecording).toHaveBeenCalledWith(STREAM)
    })

    it('recordImmediately でも stream が無ければ録画しない', async () => {
      cameraStream.value = null
      const { startCamera } = useBlowVideoRecording()
      await startCamera({ recordImmediately: true })

      expect(startRecording).not.toHaveBeenCalled()
    })

    it('カメラが起きなくても投げない (測定は続ける)', async () => {
      cameraStart.mockRejectedValueOnce(new Error('NotAllowedError'))
      const { startCamera } = useBlowVideoRecording()
      await expect(startCamera()).resolves.toBeUndefined()
    })
  })

  describe('onAlcStateChange (吹き込み待ちで録画開始)', () => {
    it('blow_waiting で録画を始める', () => {
      cameraStream.value = STREAM
      const { onAlcStateChange } = useBlowVideoRecording()
      onAlcStateChange('blow_waiting')

      expect(startRecording).toHaveBeenCalledWith(STREAM)
    })

    it('blow_waiting 以外では始めない', () => {
      cameraStream.value = STREAM
      const { onAlcStateChange } = useBlowVideoRecording()
      onAlcStateChange('ready')
      onAlcStateChange('measuring')

      expect(startRecording).not.toHaveBeenCalled()
    })

    it('stream が無ければ始めない', () => {
      cameraStream.value = null
      const { onAlcStateChange } = useBlowVideoRecording()
      onAlcStateChange('blow_waiting')

      expect(startRecording).not.toHaveBeenCalled()
    })

    it('すでに録画中なら二重に始めない', () => {
      cameraStream.value = STREAM
      isRecording.value = true
      const { onAlcStateChange } = useBlowVideoRecording()
      onAlcStateChange('blow_waiting')

      expect(startRecording).not.toHaveBeenCalled()
    })
  })

  describe('finishRecording', () => {
    it('録画があればローカルに保存し、状態は pending になる', async () => {
      const { saveVideo } = await import('~/utils/video-store')
      const blob = new Blob(['video'], { type: 'video/webm' })
      stopRecording.mockResolvedValue(blob)
      vi.mocked(saveVideo).mockResolvedValue(undefined)

      const { finishRecording, videoStoreId, uploadStatus } = useBlowVideoRecording()
      await finishRecording('emp-1', 'meas-1')

      expect(saveVideo).toHaveBeenCalledWith('vid-uuid-1', blob, 'emp-1', 'meas-1')
      expect(videoStoreId.value).toBe('vid-uuid-1')
      expect(uploadStatus.value).toBe('pending')
      expect(cameraStop).toHaveBeenCalled()
    })

    it('ローカル保存が失敗しても投げない', async () => {
      const { saveVideo } = await import('~/utils/video-store')
      stopRecording.mockResolvedValue(new Blob(['video']))
      vi.mocked(saveVideo).mockRejectedValue(new Error('quota'))

      const { finishRecording, uploadStatus } = useBlowVideoRecording()
      await expect(finishRecording('emp-1', 'meas-1')).resolves.toBeUndefined()
      expect(uploadStatus.value).toBe('pending')
    })

    it('録画が無ければ保存せず、カメラだけ止める', async () => {
      const { saveVideo } = await import('~/utils/video-store')
      stopRecording.mockResolvedValue(null)

      const { finishRecording, videoStoreId, uploadStatus } = useBlowVideoRecording()
      await finishRecording('emp-1')

      expect(saveVideo).not.toHaveBeenCalled()
      expect(videoStoreId.value).toBeNull()
      expect(uploadStatus.value).toBeNull()
      expect(cameraStop).toHaveBeenCalled()
    })
  })

  describe('uploadRecording', () => {
    it('録画を上げ、成功したら uploaded になる', async () => {
      const { saveVideo } = await import('~/utils/video-store')
      const { uploadLinkedVideo } = await import('~/utils/offline-queue')
      const { updateMeasurement } = await import('~/utils/api')
      const blob = new Blob(['video'], { type: 'video/webm' })
      stopRecording.mockResolvedValue(blob)
      vi.mocked(saveVideo).mockResolvedValue(undefined)
      vi.mocked(uploadLinkedVideo).mockResolvedValue('uploaded')

      const { finishRecording, uploadRecording, uploadStatus } = useBlowVideoRecording()
      await finishRecording('emp-1', 'meas-1')
      uploadRecording('meas-1')

      expect(uploadStatus.value).toBe('uploading')
      // 手元の blob をそのまま渡す (IndexedDB の書き込み完了を待たない)
      expect(uploadLinkedVideo).toHaveBeenCalledWith('vid-uuid-1', 'meas-1', updateMeasurement, blob)
      await vi.waitFor(() => expect(uploadStatus.value).toBe('uploaded'))
    })

    it('skipped でも uploaded 扱いにする (送るものが無かっただけ)', async () => {
      const { saveVideo } = await import('~/utils/video-store')
      const { uploadLinkedVideo } = await import('~/utils/offline-queue')
      stopRecording.mockResolvedValue(new Blob(['video']))
      vi.mocked(saveVideo).mockResolvedValue(undefined)
      vi.mocked(uploadLinkedVideo).mockResolvedValue('skipped')

      const { finishRecording, uploadRecording, uploadStatus } = useBlowVideoRecording()
      await finishRecording('emp-1', 'meas-1')
      uploadRecording('meas-1')

      await vi.waitFor(() => expect(uploadStatus.value).toBe('uploaded'))
    })

    it('失敗したら failed になる (次回起動時にリトライ)', async () => {
      const { saveVideo } = await import('~/utils/video-store')
      const { uploadLinkedVideo } = await import('~/utils/offline-queue')
      stopRecording.mockResolvedValue(new Blob(['video']))
      vi.mocked(saveVideo).mockResolvedValue(undefined)
      vi.mocked(uploadLinkedVideo).mockResolvedValue('failed')

      const { finishRecording, uploadRecording, uploadStatus } = useBlowVideoRecording()
      await finishRecording('emp-1', 'meas-1')
      uploadRecording('meas-1')

      await vi.waitFor(() => expect(uploadStatus.value).toBe('failed'))
    })

    it('録画が無ければ何もしない', async () => {
      const { uploadLinkedVideo } = await import('~/utils/offline-queue')
      const { uploadRecording, uploadStatus } = useBlowVideoRecording()
      uploadRecording('meas-1')

      expect(uploadLinkedVideo).not.toHaveBeenCalled()
      expect(uploadStatus.value).toBeNull()
    })
  })

  describe('reset', () => {
    it('録画の状態を捨ててカメラを止める', async () => {
      const { saveVideo } = await import('~/utils/video-store')
      const { uploadLinkedVideo } = await import('~/utils/offline-queue')
      stopRecording.mockResolvedValue(new Blob(['video']))
      vi.mocked(saveVideo).mockResolvedValue(undefined)

      const { finishRecording, reset, uploadRecording, videoStoreId, uploadStatus } = useBlowVideoRecording()
      await finishRecording('emp-1', 'meas-1')
      reset()

      expect(videoStoreId.value).toBeNull()
      expect(uploadStatus.value).toBeNull()
      expect(cameraStop).toHaveBeenCalled()

      // reset 後は前の測定の録画を上げない
      uploadRecording('meas-1')
      expect(uploadLinkedVideo).not.toHaveBeenCalled()
    })
  })

  describe('stopCamera', () => {
    it('カメラだけ止める', () => {
      const [{ stopCamera }, app] = withSetup(() => useBlowVideoRecording())
      stopCamera()
      expect(cameraStop).toHaveBeenCalled()
      app.unmount()
    })
  })
})
