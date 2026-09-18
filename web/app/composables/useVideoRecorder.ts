/**
 * MediaRecorder ラッパー composable
 * アルコール測定時の吹きかけ映像を録画する
 */
export function useVideoRecorder() {
  const isRecording = ref(false)
  const recordedBlob = ref<Blob | null>(null)
  const error = ref<string | null>(null)

  let mediaRecorder: MediaRecorder | null = null
  let chunks: BlobPart[] = []
  /** 進行中 (または完了済み) の停止処理。`stopRecording` を何度呼んでも 1 回だけ止める */
  let stopPromise: Promise<Blob | null> | null = null

  function startRecording(stream: MediaStream) {
    chunks = []
    recordedBlob.value = null
    error.value = null
    stopPromise = null

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm'

    try {
      mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 500_000,
      })
    } catch (e) {
      error.value = '録画の開始に失敗しました'
      console.error('[VideoRecorder] MediaRecorder init failed:', e)
      return
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    mediaRecorder.onstop = () => {
      recordedBlob.value = new Blob(chunks, { type: mimeType })
      isRecording.value = false
    }
    mediaRecorder.onerror = () => {
      error.value = '録画中にエラーが発生しました'
      isRecording.value = false
    }

    mediaRecorder.start(1000)
    isRecording.value = true
    console.log('[VideoRecorder] Recording started')
  }

  /**
   * 録画を止めて blob を返す。
   *
   * **停止は 1 回だけ走らせ、Promise を使い回す** — キオスクは段が切り替わると
   * 録画中のまま unmount されるので、下の `onUnmounted` も同じ経路で止める。
   * 以前は `onUnmounted` が `mediaRecorder.stop()` を直接呼んでいたため、
   * await 中の `stopRecording()` が解決されず**録画 blob が取り出せずに消えていた**
   * (Refs ippoan/alc-app#349)。unmount の後にここを呼んだ場合も同じ Promise が
   * 返るので、blob は段の切り替えで失われない。
   */
  function stopRecording(): Promise<Blob | null> {
    if (stopPromise) return stopPromise
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      return Promise.resolve(recordedBlob.value)
    }
    const recorder = mediaRecorder
    stopPromise = new Promise((resolve) => {
      const prevOnStop = recorder.onstop
      recorder.onstop = (e) => {
        if (prevOnStop) (prevOnStop as (e: Event) => void)(e)
        resolve(recordedBlob.value)
      }
      recorder.stop()
      console.log('[VideoRecorder] Recording stopped')
    })
    return stopPromise
  }

  onUnmounted(() => {
    // 録画中に unmount されても blob を捨てない (上の stopRecording のコメント参照)
    if (mediaRecorder?.state === 'recording') void stopRecording()
  })

  return { isRecording, recordedBlob, error, startRecording, stopRecording }
}
