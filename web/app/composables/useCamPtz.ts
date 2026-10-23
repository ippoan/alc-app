import type { Ref } from 'vue'

/**
 * 拠点カメラの首振り (パン・チルト・プリセット)。映像と同じ PeerConnection のデータチャネル `ptz` で
 * alc-cam の host に直接送る (cam-room・拡張は通らない)。メッセージは alc-cam の `docs/host-protocol.md`。
 *
 * - host はチャネルが開くと `caps` (できること) を送ってくる。届くまで (古い host なら永久に) `caps` は null
 * - 方向は押している間 `move` を {@link PTZ_RESEND_MS} ごとに送り直し、離したら `stop`。
 *   host は 1 秒送り直しが無ければ自分で止める (離したのが届かなくても動き続けない)
 * - 失敗は `message` に出す。カメラが首振りを持たない (unsupported) ときは `caps` を畳んでボタンを消す
 */
export type PtzDir = 'up' | 'down' | 'left' | 'right'

export interface PtzCaps {
  dirs: PtzDir[]
  home: boolean
  presets: number[]
  zoom: boolean
}

export const PTZ_RESEND_MS = 300

interface PtzEvent {
  type?: string
  event?: string
  dirs?: PtzDir[]
  home?: boolean
  presets?: number[]
  zoom?: boolean
  action?: string
  ok?: boolean
  unsupported?: boolean
  message?: string
}

export function useCamPtz(channel: Readonly<Ref<RTCDataChannel | null>>) {
  const caps = ref<PtzCaps | null>(null)
  const held = ref<PtzDir | null>(null)
  const message = ref<string | null>(null)
  let timer: ReturnType<typeof setInterval> | null = null

  function send(m: Record<string, unknown>) {
    const ch = channel.value
    if (ch?.readyState === 'open') ch.send(JSON.stringify({ type: 'ptz', ...m }))
  }

  function release() {
    if (timer) clearInterval(timer)
    timer = null
    held.value = null
  }

  function reset() {
    release()
    caps.value = null
    message.value = null
  }

  function onMessage(ev: MessageEvent) {
    let msg: PtzEvent
    try {
      msg = JSON.parse(String(ev.data))
    }
    catch {
      return
    }
    if (msg?.type !== 'ptz') return
    if (msg.event === 'caps') {
      caps.value = { dirs: msg.dirs ?? [], home: !!msg.home, presets: msg.presets ?? [], zoom: !!msg.zoom }
      return
    }
    if (msg.event !== 'result') return
    if (msg.ok) {
      message.value = null
      return
    }
    message.value = msg.message || '首振りに失敗しました'
    // host は失敗した移動を繰り返さないので、押し続けの送り直しも止める
    if (msg.action === 'move') release()
    if (msg.unsupported && msg.action !== 'zoom') caps.value = null
  }

  // チャネルの付け替えと同じ流れで受け始める (host が開いてすぐ送る caps を取りこぼさない)
  watch(channel, (ch, old) => {
    old?.removeEventListener('message', onMessage)
    old?.removeEventListener('close', reset)
    reset()
    ch?.addEventListener('message', onMessage)
    ch?.addEventListener('close', reset)
  }, { immediate: true, flush: 'sync' })

  function move(dir: PtzDir) {
    if (held.value === dir) return
    release()
    held.value = dir
    send({ action: 'move', dir })
    timer = setInterval(() => send({ action: 'move', dir }), PTZ_RESEND_MS)
  }

  function stop() {
    if (!held.value) return
    release()
    send({ action: 'stop' })
  }

  function home() {
    release()
    send({ action: 'home' })
  }

  function preset(n: number) {
    release()
    send({ action: 'preset', preset: n })
  }

  function zoom(dir: 'in' | 'out') {
    send({ action: 'zoom', dir })
  }

  onUnmounted(() => {
    release()
    channel.value?.removeEventListener('message', onMessage)
    channel.value?.removeEventListener('close', reset)
  })

  return {
    caps: readonly(caps),
    held: readonly(held),
    message: readonly(message),
    move,
    stop,
    home,
    preset,
    zoom,
  }
}
