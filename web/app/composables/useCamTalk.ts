import type { Ref } from 'vue'

/**
 * 拠点カメラのスピーカーへ話す (押して話す)。声は映像と同じ PeerConnection の音声 (`useWebRtc` の `camAudioSender`) で
 * alc-cam の host に送り、host がカメラの通話の CGI へ流す。合図は首振りと同じデータチャネル `ptz` の `type: "talk"`。
 * メッセージは alc-cam の `docs/host-protocol.md` の「音声」。
 *
 * - host はチャネルが開くと `caps` を送ってくる。届くまで (古い host なら永久に) `canTalk` は false
 * - 押したらマイクを取り、送り口に付けて `start` を {@link TALK_RESEND_MS} ごとに送り直す。離したら外して `stop`。
 *   host は 1.5 秒送り直しが無ければ離したとみなす。マイクは押している間だけ開く (離したら止める)
 * - 同時に話せるのは 1 人。後から押した人が優先で、外されたら送るのを止めて `message` に出す
 * - マイクの許可が無い・使えないときは `message` に案内を出す
 */
export const TALK_RESEND_MS = 500

export const MIC_DENIED_MESSAGE = 'マイクが許可されていません。アドレスバー左のサイトの設定でマイクを「許可」にしてから、もう一度押してください'
export const MIC_UNAVAILABLE_MESSAGE = 'マイクを使えません。マイクがつながっているか、他のアプリが使っていないかを確かめてください'
export const TAKEN_OVER_MESSAGE = '他の人が話し始めたので、送るのを止めました'

interface TalkEvent {
  type?: string
  event?: string
  speak?: boolean
  talking?: boolean
  mine?: boolean
  ok?: boolean
  message?: string
}

export function useCamTalk(
  channel: Readonly<Ref<RTCDataChannel | null>>,
  sender: Readonly<Ref<RTCRtpSender | null>>,
) {
  /** host が通話に対応している (`caps`) */
  const canTalk = ref(false)
  /** 押している (マイクを取りに行っている間も含む) */
  const holding = ref(false)
  /** host が「自分が話している」と言っている */
  const talking = ref(false)
  /** 他の人が話している */
  const othersTalking = ref(false)
  const message = ref<string | null>(null)
  let timer: ReturnType<typeof setInterval> | null = null
  let mic: MediaStream | null = null
  // 押すたびに進める。マイクを待つ間に離された・押し直された古い press() は何もしない
  let pressGen = 0

  function send(action: 'start' | 'stop') {
    const ch = channel.value
    if (ch?.readyState === 'open') ch.send(JSON.stringify({ type: 'talk', action }))
  }

  /** 送るのをやめる (送り口を外し、マイクを止める)。`start` を送り始めていたら true (呼び手が `stop` を送るか決める) */
  function releaseLocal() {
    pressGen++
    const started = timer !== null
    if (timer) clearInterval(timer)
    timer = null
    holding.value = false
    sender.value?.replaceTrack(null).catch(() => {})
    mic?.getTracks().forEach(t => t.stop())
    mic = null
    return started
  }

  async function press() {
    if (holding.value || !sender.value) return
    holding.value = true
    message.value = null
    const gen = ++pressGen
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    }
    catch (e) {
      if (gen !== pressGen) return
      holding.value = false
      message.value = e instanceof DOMException && e.name === 'NotAllowedError' ? MIC_DENIED_MESSAGE : MIC_UNAVAILABLE_MESSAGE
      return
    }
    if (gen !== pressGen) {
      stream.getTracks().forEach(t => t.stop()) // 待つ間に離された
      return
    }
    mic = stream
    await sender.value?.replaceTrack(stream.getAudioTracks()[0] ?? null)
    if (gen !== pressGen) return
    send('start')
    timer = setInterval(() => send('start'), TALK_RESEND_MS)
  }

  function release() {
    if (!holding.value) return
    if (releaseLocal()) send('stop')
  }

  function reset() {
    releaseLocal()
    canTalk.value = false
    talking.value = false
    othersTalking.value = false
    message.value = null
  }

  function onMessage(ev: MessageEvent) {
    let msg: TalkEvent
    try {
      msg = JSON.parse(String(ev.data))
    }
    catch {
      return
    }
    if (msg?.type !== 'talk') return
    if (msg.event === 'caps') {
      canTalk.value = !!msg.speak
      return
    }
    if (msg.event === 'state') {
      talking.value = !!msg.mine
      othersTalking.value = !!msg.talking && !msg.mine
      if (othersTalking.value && holding.value) {
        message.value = TAKEN_OVER_MESSAGE
        release()
      }
      return
    }
    if (msg.event !== 'result') return
    if (msg.ok) {
      message.value = null
      return
    }
    message.value = msg.message || 'カメラのスピーカーに送れませんでした'
    release()
  }

  // チャネルの付け替えと同じ流れで受け始める (host が開いてすぐ送る caps を取りこぼさない)
  watch(channel, (ch, old) => {
    old?.removeEventListener('message', onMessage)
    old?.removeEventListener('close', reset)
    reset()
    ch?.addEventListener('message', onMessage)
    ch?.addEventListener('close', reset)
  }, { immediate: true, flush: 'sync' })

  onUnmounted(() => {
    release()
    channel.value?.removeEventListener('message', onMessage)
    channel.value?.removeEventListener('close', reset)
  })

  return {
    canTalk: readonly(canTalk),
    holding: readonly(holding),
    talking: readonly(talking),
    othersTalking: readonly(othersTalking),
    message: readonly(message),
    press,
    release,
  }
}
