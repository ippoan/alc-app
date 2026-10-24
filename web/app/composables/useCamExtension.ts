/**
 * この端末のカメラ配信の拡張 (ippoan/alc-cam) の状態を読み、操作する (メンテナンス画面の「カメラ配信 (拡張)」)。
 *
 * 拠点 PC では点呼の画面を PWA で開いているので拡張のサイドパネルが見えない。代わりに同じ origin から
 * `{ type: 'cam_status' }` を `POLL_MS` ごとに送って状態を出し、`{ type: 'cam_control', action }` で
 * 停止/開始・更新確認・担当カメラの取り直しをする。形は alc-cam の `docs/extension-messages.md`。
 *
 * - `supported`: `chrome.runtime.sendMessage` が生えているか (Chrome 以外・拡張が 1 つも許していない端末では false)。
 *   false なら取りにも行かない。
 * - 拡張が無い・応答しない・古い拡張 (v0.4.1 まで。`{ ok: false }` を返す) は `found = false` (「拡張が見つかりません」)。
 * - 状態には鍵の中身・パスワードは入っていない (拡張が伏せて返す)。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { extensionSendMessage, requestExtension } from '~/utils/alc-cam-extension'

/** 状態を取り直す間隔 (ms) */
export const POLL_MS = 5_000

export type CamControlAction = 'stop' | 'start' | 'update_check' | 'refetch'
/** [文言, class ('ok' | 'warn' | '')] (拡張のパネルの表示そのまま) */
export type CamLabel = [string, string]

export interface CamExtensionStatus {
  version: string
  hostVersion: string
  enabled: boolean
  tokenLive: boolean
  tokenExp: number
  tokenSub: string
  assigned: { id: string, name: string } | null
  config: CamLabel
  host: CamLabel
  signal: CamLabel
  camera: CamLabel
  viewers: { ok: boolean, message: string }[]
  update: CamLabel
  updateState: string
  updateAt: number
  lastError: { message: string, at: number } | null
}

/** 拡張の返事から状態を取り出す。形が違えば null (古い拡張・拡張が無い)。 */
export function parseStatusReply(reply: unknown): CamExtensionStatus | null {
  const r = reply as { ok?: unknown, status?: unknown } | null
  if (!r || r.ok !== true || typeof r.status !== 'object' || r.status === null) return null
  const st = r.status as Partial<CamExtensionStatus>
  if (typeof st.version !== 'string' || typeof st.enabled !== 'boolean') return null
  return st as CamExtensionStatus
}

/** ミリ秒 → 「10/24 09:05」(JST) */
export function jstMinuteLabel(ms: number): string {
  return new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 鍵の表示 (期限切れでも配信は写しで続く) */
export function tokenLabel(st: CamExtensionStatus): CamLabel {
  if (!st.tokenExp) return ['なし (CoreS3 が繋がると届きます)', 'warn']
  const sub = st.tokenSub ? `、${st.tokenSub}` : ''
  return st.tokenLive ? [`あり (${jstMinuteLabel(st.tokenExp)} まで${sub})`, 'ok'] : [`期限切れ (${jstMinuteLabel(st.tokenExp)}${sub})`, '']
}

/** 見る人と映像の表示 */
export function viewersLabel(st: CamExtensionStatus): CamLabel {
  const vs = st.viewers
  if (!vs.length) return ['なし', '']
  const ok = vs.filter(v => v.ok).length
  const other = [...new Set(vs.filter(v => !v.ok).map(v => v.message))]
  const text = [ok ? `接続 (P2P) ${ok} 人` : '', ...other].filter(Boolean).join(' / ')
  return [`${vs.length} 人: ${text}`, ok === vs.length ? 'ok' : '']
}

/** 最後の更新確認の表示 */
export function updateLabel(st: CamExtensionStatus): CamLabel {
  if (!st.updateAt) return [st.update[0], st.update[1]]
  return [`${st.update[0]} (${jstMinuteLabel(st.updateAt)})`, st.update[1]]
}

export function useCamExtension() {
  const supported = extensionSendMessage() !== null
  /** null = まだ聞いていない */
  const found = ref<boolean | null>(null)
  const status = ref<CamExtensionStatus | null>(null)
  const busy = ref<CamControlAction | null>(null)
  /** 最後の操作の結果 */
  const result = ref<{ ok: boolean, message: string } | null>(null)
  let timer: ReturnType<typeof setInterval> | null = null

  async function refresh(): Promise<void> {
    if (!supported) return
    const st = parseStatusReply(await requestExtension({ type: 'cam_status' }))
    found.value = st !== null
    status.value = st
  }

  async function control(action: CamControlAction): Promise<void> {
    if (!supported || busy.value) return
    busy.value = action
    try {
      const reply = ((await requestExtension({ type: 'cam_control', action })) ?? {}) as { ok?: unknown, message?: unknown, status?: unknown }
      // 返事に状態が付かない = 拡張が無い・応答しない・古い (v0.4.1 まで)
      const st = parseStatusReply({ ok: true, status: reply.status })
      found.value = st !== null
      status.value = st
      result.value = st
        ? { ok: reply.ok === true, message: String(reply.message ?? '') }
        : { ok: false, message: '拡張が見つかりません' }
    }
    finally {
      busy.value = null
    }
  }

  onMounted(() => {
    if (!supported) return
    void refresh()
    timer = setInterval(() => void refresh(), POLL_MS)
  })
  onBeforeUnmount(() => {
    if (timer !== null) clearInterval(timer)
    timer = null
  })

  return { supported, found, status, busy, result, refresh, control }
}
