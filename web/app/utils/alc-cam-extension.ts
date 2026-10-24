/**
 * 拠点 PC のカメラ配信の拡張 (ippoan/alc-cam の extension) への送信口。
 *
 * 拡張は externally_connectable で `https://alc.ippoan.org/*` からの `chrome.runtime.sendMessage` だけを受ける。
 * 受ける形は alc-cam の `docs/extension-messages.md`:
 *
 * - `{ type: 'cam_host_token', token, exp }` → `{ ok }` (useCamHostToken)
 * - `{ type: 'cam_status' }` → `{ ok, status }` (v0.4.2〜)
 * - `{ type: 'cam_control', action }` → `{ ok, message, status }` (v0.4.2〜)
 *
 * 古い拡張 (v0.4.1 まで) は cam_status / cam_control に `{ ok: false }` を返す。
 */

/** 拡張 alc-cam の ID (manifest の key で固定)。 */
export const ALC_CAM_EXTENSION_ID = 'icmmpdjddlphkbokdalofdjpkcgfiggd'

export type ExtensionSendMessage = (extensionId: string, message: unknown, callback: (response?: unknown) => void) => void

type ChromeRuntime = { sendMessage?: unknown, lastError?: unknown }
const runtime = (): ChromeRuntime | undefined => (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime

/** 拡張へ送る口。無ければ null (拡張が無い / Chrome 以外では `chrome.runtime.sendMessage` が生えない)。 */
export function extensionSendMessage(): ExtensionSendMessage | null {
  const rt = runtime()
  if (typeof rt?.sendMessage !== 'function') return null
  return (id, message, callback) => (rt.sendMessage as ExtensionSendMessage).call(rt, id, message, callback)
}

/** 拡張が無い・応答しないときの lastError を読んで捨てる (Chrome がコンソールに出さないように)。 */
export function swallowLastError(): void {
  void runtime()?.lastError
}

/** 応答を待つ上限 (ms)。service worker の起き上がりを含めても数秒で返る。 */
export const EXTENSION_REPLY_TIMEOUT_MS = 5_000

/**
 * 拡張に送って返事を待つ。送る口が無い・拡張が無い (lastError)・返事が無い・時間切れは null。
 */
export function requestExtension(message: unknown, timeoutMs = EXTENSION_REPLY_TIMEOUT_MS): Promise<unknown> {
  const send = extensionSendMessage()
  if (!send) return Promise.resolve(null)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    const done = (v: unknown) => {
      clearTimeout(timer)
      resolve(v)
    }
    try {
      send(ALC_CAM_EXTENSION_ID, message, (response) => {
        const failed = runtime()?.lastError
        done(failed || response === undefined ? null : response)
      })
    }
    catch {
      done(null)
    }
  })
}
