import { updateMeasurement } from '~/utils/api'
import { uploadLinkedVideo } from '~/utils/offline-queue'
import { saveVideo, getPendingVideos, cleanupOldVideos } from '~/utils/video-store'

/**
 * 吹きかけ録画の状態。`'pending'` は「ローカルには保存済みでまだ上げていない」。
 */
export type BlowVideoUploadStatus = 'pending' | 'uploading' | 'uploaded' | 'failed'

/** ローカル録画を保持する日数 (これを超えたものは起動時に削除) */
const VIDEO_RETENTION_DAYS = 7

/**
 * アルコール測定の吹きかけ録画を回す composable (Refs ippoan/alc-app#349)。
 *
 * 通常点呼 (`NormalMeasurement.vue`) にしか配線されていなかった録画を、自動点呼と
 * 遠隔点呼 (`TenkoKiosk.vue`) でも同じ形で回すための共通部。下層はそのまま使う —
 * `useCamera` (プレビュー) / `useVideoRecorder` (MediaRecorder) /
 * `video-store` (IndexedDB) / `offline-queue.uploadLinkedVideo` (R2 + `video_url`)。
 *
 * **境界は「録画と `video_url` の反映」まで。** 測定行の作成 (`/measurements/start`) と
 * 完了更新 (`PUT /measurements/{id}`) は利用側に残す — 通常点呼の完了更新には
 * `record_as_tenko: true` が載っており、これをここに持ち込むとキオスクにも付いてきて
 * `tenko_method = 通常点呼` の点呼セッションがもう 1 本でき、CSV に同じ点呼が
 * 二重に出る。
 *
 * プレビューと状態表示の template は利用側に置く (段のレイアウトが違うため)。
 */
export function useBlowVideoRecording() {
  const camera = useCamera()
  const { isRecording, startRecording, stopRecording } = useVideoRecorder()

  /** IndexedDB 上の録画 ID。オフラインキューへ引き継ぐので利用側にも見せる */
  const videoStoreId = ref<string | null>(null)
  const uploadStatus = ref<BlowVideoUploadStatus | null>(null)
  let recordedBlob: Blob | null = null

  /**
   * 起動時の後片付け: 7 日超のローカル録画を削除し、未アップロード分を送り直す。
   * どちらも best-effort で、失敗しても測定フローは止めない。
   */
  async function retryPendingUploads(): Promise<void> {
    cleanupOldVideos(VIDEO_RETENTION_DAYS).catch(() => {})
    try {
      const pending = await getPendingVideos()
      for (const v of pending) {
        if (!v.measurementId) continue
        void uploadLinkedVideo(v.id, v.measurementId, updateMeasurement)
      }
    }
    catch {
      // IndexedDB が読めない環境ではリトライを諦める (録画自体は続けられる)
    }
  }

  /**
   * プレビュー用のカメラを起こす (best-effort — カメラが無い端末でも測定は続ける)。
   *
   * `recordImmediately` はデモモード用。FC-1200 の state 変化が来ないので
   * `onAlcStateChange` が発火せず、録画が始まらないため。
   */
  async function startCamera(options: { recordImmediately?: boolean } = {}): Promise<void> {
    try {
      await camera.start('user')
      if (options.recordImmediately && camera.stream.value) {
        startRecording(camera.stream.value)
      }
    }
    catch (e) {
      console.warn('[BlowVideo] Recording camera failed:', e)
    }
  }

  /** カメラを止める (録画は止めない)。段から離れるときに呼ぶ */
  function stopCamera(): void {
    camera.stop()
  }

  /**
   * `AlcMeasurement` の `state-change` を受けて吹き込み待ちで録画を始める。
   * PC 直結の FC-1200 と CoreS3 経由 (EVT FC1200) のどちらの進みでも同じ語が来る。
   */
  function onAlcStateChange(alcState: string): void {
    if (alcState === 'blow_waiting' && camera.stream.value && !isRecording.value) {
      startRecording(camera.stream.value)
    }
  }

  /**
   * 測定結果が出たところで録画を止め、ローカル (IndexedDB) に保存してカメラを落とす。
   *
   * **段を進める前に呼ぶこと** — キオスクは段が切り替わると録画中の component が
   * unmount されるため。録画があれば `uploadStatus` は `'pending'` になり、
   * オンラインなら続けて `uploadRecording()` を呼ぶ。
   */
  async function finishRecording(employeeId: string, measurementId?: string): Promise<void> {
    const blob = await stopRecording()
    if (blob) {
      recordedBlob = blob
      const vid = crypto.randomUUID()
      videoStoreId.value = vid
      uploadStatus.value = 'pending'
      saveVideo(vid, blob, employeeId, measurementId)
        .catch(e => console.warn('[BlowVideo] video local save failed:', e))
      console.log(`[BlowVideo] Video recorded: ${(blob.size / 1024).toFixed(0)}KB`)
    }
    stopCamera()
  }

  /**
   * ローカルに持っている録画を R2 へ上げ、その測定に `video_url` を載せる
   * (バックグラウンド。待たない)。
   */
  function uploadRecording(measurementId: string): void {
    if (!recordedBlob || !videoStoreId.value) return
    uploadStatus.value = 'uploading'
    void uploadLinkedVideo(videoStoreId.value, measurementId, updateMeasurement, recordedBlob)
      .then((outcome) => {
        uploadStatus.value = outcome === 'failed' ? 'failed' : 'uploaded'
      })
  }

  /** 次の測定に備えて録画の状態を捨てる */
  function reset(): void {
    recordedBlob = null
    videoStoreId.value = null
    uploadStatus.value = null
    stopCamera()
  }

  return {
    videoRef: camera.videoRef,
    isCameraActive: camera.isActive,
    isRecording,
    videoStoreId,
    uploadStatus,
    retryPendingUploads,
    startCamera,
    stopCamera,
    onAlcStateChange,
    finishRecording,
    uploadRecording,
    reset,
  }
}
