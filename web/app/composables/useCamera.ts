import { isClient } from '~/utils/env'

// コンソールから window.switchToDummyCamera() で全videoをシルエット映像に差し替え
// マニュアル用スクリーンショット撮影時に使用
if (isClient) {
  (window as any).switchToDummyCamera = () => {
    const canvas = document.createElement('canvas')
    canvas.width = 720
    canvas.height = 720
    const ctx = canvas.getContext('2d')!

    // リアルな人物イラスト描画
    function drawFrame() {
      // 背景（部屋っぽいグラデーション）
      const bg = ctx.createLinearGradient(0, 0, 0, 720)
      bg.addColorStop(0, '#e8e4e0')
      bg.addColorStop(1, '#d0ccc8')
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, 720, 720)

      // 体（グレーのTシャツ）
      ctx.fillStyle = '#888e96'
      ctx.beginPath()
      ctx.moveTo(200, 520)
      ctx.quadraticCurveTo(200, 420, 280, 390)
      ctx.lineTo(440, 390)
      ctx.quadraticCurveTo(520, 420, 520, 520)
      ctx.lineTo(520, 720)
      ctx.lineTo(200, 720)
      ctx.closePath()
      ctx.fill()
      // 襟
      ctx.fillStyle = '#7d838b'
      ctx.beginPath()
      ctx.moveTo(310, 390)
      ctx.quadraticCurveTo(360, 430, 410, 390)
      ctx.quadraticCurveTo(360, 410, 310, 390)
      ctx.fill()

      // 首
      ctx.fillStyle = '#d4a574'
      ctx.fillRect(330, 330, 60, 70)

      // 顔（楕円）
      ctx.fillStyle = '#dbb08c'
      ctx.beginPath()
      ctx.ellipse(360, 260, 85, 105, 0, 0, Math.PI * 2)
      ctx.fill()

      // 髪（上部）
      ctx.fillStyle = '#3a3028'
      ctx.beginPath()
      ctx.ellipse(360, 190, 95, 70, 0, Math.PI, Math.PI * 2)
      ctx.fill()
      // 髪サイド
      ctx.fillRect(268, 190, 20, 60)
      ctx.fillRect(432, 190, 20, 60)

      // 耳
      ctx.fillStyle = '#d4a574'
      ctx.beginPath()
      ctx.ellipse(272, 270, 14, 22, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.ellipse(448, 270, 14, 22, 0, 0, Math.PI * 2)
      ctx.fill()

      // 目
      ctx.fillStyle = '#2c2420'
      ctx.beginPath()
      ctx.ellipse(325, 265, 12, 8, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.ellipse(395, 265, 12, 8, 0, 0, Math.PI * 2)
      ctx.fill()
      // 白目のハイライト
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.arc(328, 263, 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.arc(398, 263, 3, 0, Math.PI * 2)
      ctx.fill()

      // 眉
      ctx.strokeStyle = '#3a3028'
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(308, 245)
      ctx.quadraticCurveTo(325, 238, 342, 245)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(378, 245)
      ctx.quadraticCurveTo(395, 238, 412, 245)
      ctx.stroke()

      // 鼻
      ctx.strokeStyle = '#c49570'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(360, 270)
      ctx.lineTo(355, 300)
      ctx.quadraticCurveTo(360, 308, 370, 300)
      ctx.stroke()

      // 口
      ctx.strokeStyle = '#b07060'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.moveTo(335, 325)
      ctx.quadraticCurveTo(360, 338, 385, 325)
      ctx.stroke()
    }
    drawFrame()

    const dummyStream = canvas.captureStream(30)
    // 全videoのsrcObjectを差し替え
    document.querySelectorAll('video').forEach((v) => {
      v.srcObject = dummyStream
      v.play()
    })
    console.log('[DummyCamera] switched all video elements to silhouette stream')
  }
}

/**
 * 既定のカメラが NotReadableError のとき、つながっているカメラを 1 台ずつ deviceId 指定で開く。
 * どれも開けなければ最初のエラーを投げ直す。どのカメラがどう失敗したかをログに残す
 */
async function openAnyCamera(size: MediaTrackConstraints, firstError: DOMException): Promise<MediaStream> {
  const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput')
  console.warn('[Camera] default camera not readable:', firstError.message, 'cameras:', cameras.map(c => c.label || c.deviceId.slice(0, 8)))
  for (const cam of cameras) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.deviceId }, ...size }, audio: false })
      console.warn('[Camera] opened instead:', cam.label || cam.deviceId.slice(0, 8))
      return s
    }
    catch (e) {
      console.warn('[Camera] open failed:', cam.label || cam.deviceId.slice(0, 8), e instanceof DOMException ? `${e.name}: ${e.message}` : e)
    }
  }
  throw firstError
}

export function useCamera() {
  const stream = ref<MediaStream | null>(null)
  const videoRef = ref<HTMLVideoElement | null>(null)
  const isActive = ref(false)
  const error = ref<string | null>(null)
  const permissionDenied = ref(false)

  async function start(facingMode: 'user' | 'environment' = 'user', deviceModel?: string | null) {
    error.value = null
    permissionDenied.value = false
    try {
      // 権限状態を事前チェック
      if (navigator.permissions) {
        try {
          const status = await navigator.permissions.query({ name: 'camera' as PermissionName })
          if (status.state === 'denied') {
            permissionDenied.value = true
            error.value = 'カメラの権限が拒否されています。端末の設定からカメラの権限を許可してください'
            throw new DOMException('Permission denied', 'NotAllowedError')
          }
        }
        catch (e) {
          // permissions.query が camera をサポートしない場合は無視して getUserMedia へ
          if (e instanceof DOMException && e.name === 'NotAllowedError') throw e
        }
      }

      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
      const isKyocera = deviceModel?.includes('TB305') ?? false

      let width = isMobile ? 1280 : 1920
      let height = isMobile ? 720 : 1080
      if (isKyocera) {
        width = 640
        height = 480
      }

      const size = { width: { ideal: width }, height: { ideal: height } }
      let mediaStream: MediaStream
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode, ...size }, audio: false })
      }
      catch (e) {
        // NotReadableError = 既定のカメラを OS から開けない (他のアプリが掴んでいる・仮想カメラ等)。
        // 権限はあるので、つながっている他のカメラを順に試す
        if (!(e instanceof DOMException && e.name === 'NotReadableError')) throw e
        mediaStream = await openAnyCamera(size, e)
      }
      stream.value = mediaStream
      isActive.value = true

      if (videoRef.value) {
        videoRef.value.srcObject = mediaStream
        await videoRef.value.play()
      }
    }
    catch (e) {
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        permissionDenied.value = true
        error.value = 'カメラの権限が拒否されています。端末の設定からカメラの権限を許可してください'
      }
      else {
        error.value = e instanceof Error ? e.message : 'カメラの起動に失敗しました'
      }
      throw e
    }
  }

  function stop() {
    if (stream.value) {
      stream.value.getTracks().forEach(t => t.stop())
      stream.value = null
    }
    if (videoRef.value) {
      videoRef.value.srcObject = null
    }
    isActive.value = false
  }

  function takeSnapshot(): Blob | null {
    const video = videoRef.value
    if (!video || !isActive.value) return null

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    ctx.drawImage(video, 0, 0)

    let blob: Blob | null = null
    canvas.toBlob((b) => { blob = b }, 'image/jpeg', 0.85)
    return blob
  }

  async function takeSnapshotAsync(): Promise<Blob | null> {
    const video = videoRef.value
    if (!video || !isActive.value) return null

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    ctx.drawImage(video, 0, 0)

    return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/jpeg', 0.85))
  }

  onUnmounted(() => stop())

  return {
    stream: readonly(stream),
    videoRef,
    isActive: readonly(isActive),
    error: readonly(error),
    permissionDenied: readonly(permissionDenied),
    start,
    stop,
    takeSnapshot,
    takeSnapshotAsync,
  }
}
