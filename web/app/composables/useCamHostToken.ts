/**
 * 拠点 PC のカメラ配信の拡張 (ippoan/alc-cam の extension) に、**cam-host の鍵**を渡す。
 *
 * 拡張は渡された鍵で担当カメラ (`GET /api/cam-clips/cameras/mine` = RTSP の接続先) を引き、
 * cam-room に `?token=` で入る (signaling が role=`device-cam-host` を確かめる)。
 *
 * ```
 * GET  /device/alarm-nonce?usage=cam-host             → { nonce }
 * POST /device/alarm-token {nonce,pubkey,sig,usage}   → { access_token, expires_in }  (900s)
 * chrome.runtime.sendMessage(ALC_CAM_EXTENSION_ID, { type: 'cam_host_token', token, exp })
 * ```
 *
 * - 署名は **CoreS3** (`AUTH SIGN <nonce>`)。cam-host は専用の鍵を持たず、キオスクの鍵 (CoreS3)
 *   の署名で出る (auth-worker 側で sub を `alarm:<fp>` に揃え、録画の設定の紐づけ ID にするため)。
 * - **キオスクの鍵 (`useDeviceToken`) は拡張に渡さない** — 拡張に渡すのはこの用途の鍵だけ。
 * - `usage` は nonce (query) と token (body) の両方に要る (`useManagerDeviceToken` と同じ作法)。
 * - 期限の `REFRESH_BEFORE_MS` 前に取り直して渡し直す。失敗したら `RETRY_MS` 後に試し直す。
 * - `chrome.runtime.sendMessage` が無いブラウザ (拡張が入っていない・Chrome 以外) では、
 *   鍵を取りにも行かず静かに何もしない。拡張が無いときの送信の失敗も握りつぶす。
 *
 * 動かすのは点呼の画面 (`pages/index.vue`。ロールタブに関わらず) で、CoreS3 が繋がっている間だけ。
 * storage には書かない (メモリと拡張への受け渡しだけ)。トークンはログに出さない。
 */
import { signAlarmDeviceNonce } from '~/utils/alarm-sign'
import { withTimeout, AUTH_WORKER_FETCH_TIMEOUT_MS } from '~/utils/fetch-timeout'
import { ALC_CAM_EXTENSION_ID, extensionSendMessage, swallowLastError, type ExtensionSendMessage } from '~/utils/alc-cam-extension'

/** auth-worker が拠点 PC の拡張に割り当てた用途。nonce (query) と token (body) の両方で使う。 */
export const CAM_HOST_KEY_USAGE = 'cam-host'

/** `expires_in` 欠落時の fallback TTL (秒。auth-worker の 900s と同値) */
const DEFAULT_TTL_SECONDS = 900
/** 期限のこれだけ前に取り直して渡し直す (ms) */
export const REFRESH_BEFORE_MS = 60_000
/** 失敗してから試し直すまで (ms) */
export const RETRY_MS = 60_000

type SendMessage = ExtensionSendMessage

// --- module スコープ (PC に 1 つ) ---
let installed = false
let timer: ReturnType<typeof setTimeout> | null = null
/** CoreS3 の接続の世代。切断・再接続のたびに増やし、古い世代の結果は捨てる */
let generation = 0

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
}

function warnFailure(stage: string, status: number | null): void {
  console.warn(`[useCamHostToken] 拡張の鍵の取得に失敗 stage=${stage} status=${status ?? '-'}`)
}

export function useCamHostToken(): void {
  if (installed) return
  installed = true

  const config = useRuntimeConfig()
  const authWorkerUrl = (config.public.authWorkerUrl as string).replace(/\/$/, '')
  const coreS3 = useCoreS3Serial()
  const { getDeviceJwt } = useDeviceToken()

  /** cam-host の鍵を 1 本取る。取れなければ null。 */
  async function mint(): Promise<{ token: string, expMs: number } | null> {
    let stage = 'nonce'
    let status: number | null = null
    try {
      const nonceRes = await fetch(
        `${authWorkerUrl}/device/alarm-nonce?usage=${CAM_HOST_KEY_USAGE}`,
        withTimeout({}, AUTH_WORKER_FETCH_TIMEOUT_MS),
      )
      if (!nonceRes.ok) {
        status = nonceRes.status
        throw new Error('nonce')
      }
      const { nonce } = (await nonceRes.json()) as { nonce?: string }
      if (!nonce) throw new Error('nonce')

      stage = 'sign'
      const signed = await signAlarmDeviceNonce(nonce, coreS3.request)
      if (!signed) throw new Error('sign')

      stage = 'token-exchange'
      const tokenRes = await fetch(`${authWorkerUrl}/device/alarm-token`, withTimeout({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, pubkey: signed.pubkey, sig: signed.sig, usage: CAM_HOST_KEY_USAGE }),
      }, AUTH_WORKER_FETCH_TIMEOUT_MS))
      if (!tokenRes.ok) {
        status = tokenRes.status
        throw new Error('token-exchange')
      }
      const data = (await tokenRes.json()) as { access_token?: string, expires_in?: number }
      if (!data.access_token) throw new Error('token-exchange')
      const ttl = typeof data.expires_in === 'number' ? data.expires_in : DEFAULT_TTL_SECONDS
      return { token: data.access_token, expMs: Date.now() + ttl * 1000 }
    }
    catch {
      warnFailure(stage, status)
      return null
    }
  }

  /** 取って渡し、次の取り直しを予約する。CoreS3 が切れた (世代が変わった) 後の結果は捨てる。 */
  async function handOver(gen: number, send: SendMessage): Promise<void> {
    // キオスクの鍵の取得 (接続時の先取り) と CoreS3 への署名要求がぶつからないよう、先に済ませる
    try {
      await getDeviceJwt()
    }
    catch { /* キオスクの鍵の成否はこちらに関係ない */ }
    if (gen !== generation) return
    const minted = await mint()
    if (gen !== generation) return
    if (!minted) {
      timer = setTimeout(() => start(gen, send), RETRY_MS)
      return
    }
    try {
      send(ALC_CAM_EXTENSION_ID, { type: 'cam_host_token', token: minted.token, exp: Math.floor(minted.expMs / 1000) }, swallowLastError)
    }
    catch { /* 拡張が無い */ }
    timer = setTimeout(() => start(gen, send), Math.max(minted.expMs - REFRESH_BEFORE_MS - Date.now(), 0))
  }

  function start(gen: number, send: SendMessage): void {
    timer = null
    void handOver(gen, send)
  }

  coreS3.onOpen(() => {
    // 拡張に渡す口が無い端末では鍵を取りにも行かない
    const send = extensionSendMessage()
    if (!send) return
    clearTimer()
    start(++generation, send)
  })
  coreS3.onClose(() => {
    generation += 1
    clearTimer()
  })
}
