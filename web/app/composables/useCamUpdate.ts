import type { Ref } from 'vue'

/**
 * 拠点 PC (alc-cam の host と拡張) の自己更新を、管理者の画面から確認させる。映像と同じ PeerConnection の
 * データチャネル `ptz` の `type: "update"` で host に直接頼む (cam-room・拡張は通らない)。
 * メッセージは alc-cam の `docs/host-protocol.md` の「見る側からの自己更新の確認」。
 *
 * - host はチャネルが開くと `caps` (host と拡張の版) を送ってくる。届くまで (0.4.4 までの host なら永久に) `caps` は null
 * - `check()` で確認を頼む。経過・結果 (`state`) は見ている人全員に届くので、他の人が押した結果もここに出る
 * - host は次の起動から新しい版になる。拡張は見ている人が居なくなってから入れ替わる (文言は host が返す)
 */
export interface CamUpdateCaps {
  host: string
  extension: string | null
}

export type CamUpdateState = 'checking' | 'latest' | 'installed' | 'deferred' | 'failed' | 'unsupported'

interface UpdateEvent {
  type?: string
  event?: string
  host?: string
  extension?: string | null
  state?: CamUpdateState
  latest?: string | null
  message?: string
}

const STATE_LABEL: Record<CamUpdateState, string> = {
  checking: '確認中...',
  latest: '最新です',
  installed: '更新しました',
  deferred: '見る人が居なくなってから入れ替えます',
  failed: '更新に失敗しました',
  unsupported: 'この拠点 PC は自己更新に対応していません',
}

export function useCamUpdate(channel: Readonly<Ref<RTCDataChannel | null>>) {
  const caps = ref<CamUpdateCaps | null>(null)
  const state = ref<CamUpdateState | null>(null)
  const message = ref<string | null>(null)

  function reset() {
    caps.value = null
    state.value = null
    message.value = null
  }

  function onMessage(ev: MessageEvent) {
    let msg: UpdateEvent
    try {
      msg = JSON.parse(String(ev.data))
    }
    catch {
      return
    }
    if (msg?.type !== 'update') return
    if (msg.event === 'caps') {
      caps.value = { host: msg.host ?? '', extension: msg.extension ?? null }
      return
    }
    if (msg.event !== 'state' || !msg.state || !(msg.state in STATE_LABEL)) return
    state.value = msg.state
    // host の文言 (何を入れたか・なぜ失敗したか) を優先し、無ければ状態の名前
    message.value = msg.message || STATE_LABEL[msg.state]
  }

  // チャネルの付け替えと同じ流れで受け始める (host が開いてすぐ送る caps を取りこぼさない)
  watch(channel, (ch, old) => {
    old?.removeEventListener('message', onMessage)
    old?.removeEventListener('close', reset)
    reset()
    ch?.addEventListener('message', onMessage)
    ch?.addEventListener('close', reset)
  }, { immediate: true, flush: 'sync' })

  /** 確認を頼む (確認中は重ねない) */
  function check() {
    const ch = channel.value
    if (state.value === 'checking' || ch?.readyState !== 'open') return
    ch.send(JSON.stringify({ type: 'update', action: 'check' }))
    state.value = 'checking'
    message.value = STATE_LABEL.checking
  }

  onUnmounted(() => {
    channel.value?.removeEventListener('message', onMessage)
    channel.value?.removeEventListener('close', reset)
  })

  return {
    caps: readonly(caps),
    state: readonly(state),
    message: readonly(message),
    check,
  }
}
