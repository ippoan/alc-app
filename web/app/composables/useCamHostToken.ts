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
 * - 署名はその PC に挿さった機体 (`AUTH SIGN <nonce>`)。cam-host は専用の鍵を持たず、機体の鍵の
 *   署名で出る (auth-worker 側で sub を `alarm:<fp>` に揃え、録画の設定の紐づけ ID にするため)。
 *   署名を頼む相手は繋がっている 1 台: Vein Station (用途 kiosk)・CoreS3 (用途 kiosk)・
 *   測定台の ATOM S3 (用途 bp-station)。1 台の PC に 2 台を同時に挿すことはない前提
 *   ({@link CAM_HOST_SIGNERS} の順は見る順というだけ。移行先の Vein Station を先に置く)。
 *   `AUTH SIGNBP` は使わない (ボンド状態は cam-host の鍵に関係ない。全機種のファームが `AUTH SIGN` に答える)。
 * - 機体ごとの鍵 (キオスク = `useDeviceToken`、測定台 = `useBpStationDeviceToken`) の取得と
 *   署名要求がぶつからないよう、先にそちらを済ませてから署名を頼む (どちらも single-flight)。
 * - **キオスクの鍵 (`useDeviceToken`) は拡張に渡さない** — 拡張に渡すのはこの用途の鍵だけ。
 * - `usage` は nonce (query) と token (body) の両方に要る (`useManagerDeviceToken` と同じ作法)。
 * - 期限の `REFRESH_BEFORE_MS` 前に取り直して渡し直す。失敗したら `RETRY_MS` 後に試し直す。
 * - `chrome.runtime.sendMessage` が無いブラウザ (拡張が入っていない・Chrome 以外) では、
 *   鍵を取りにも行かず静かに何もしない。拡張が無いときの送信の失敗も握りつぶす。
 *
 * 動かすのは点呼の画面 (`pages/index.vue`。ロールタブに関わらず) で、上の機体のどれかが繋がっている間だけ。
 * storage には書かない (メモリと拡張への受け渡しだけ)。トークンはログに出さない。
 */
import { watch, type Ref } from 'vue'
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
type Request = (line: string, matchPrefix: string, timeoutMs: number) => Promise<string>

// --- module スコープ (PC に 1 つ) ---
let installed = false
let timer: ReturnType<typeof setTimeout> | null = null
/** 署名を頼む機体の世代。抜き差しのたびに増やし、古い世代の結果は捨てる */
let generation = 0
/** いま署名を頼んでいる機体 (どれも繋がっていなければ null) */
let current: CamHostSignerName | null = null

/** 署名を頼む機体の名前 (優先順は {@link CAM_HOST_SIGNERS}) */
export type CamHostSignerName = 'coreS3' | 'vein' | 'atom'
/** 繋がっている機体を探す順 (同時には挿さない前提なので、見つかった 1 台に頼む) */
export const CAM_HOST_SIGNERS: ReadonlyArray<CamHostSignerName> = ['vein', 'coreS3', 'atom']

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
  const { getDeviceJwt } = useDeviceToken()
  const { getBpStationJwt } = useBpStationDeviceToken()
  const coreS3 = useCoreS3Serial()
  const vein = useVeinSerial()
  const atom = useAtomS3Serial()
  const signers: Record<CamHostSignerName, {
    isConnected: Readonly<Ref<boolean>>
    request: Request
    /** その機体の鍵の取得 (署名要求がぶつからないよう先に済ませる) */
    settle: () => Promise<unknown>
  }> = {
    coreS3: { isConnected: coreS3.isConnected, request: coreS3.request, settle: getDeviceJwt },
    vein: { isConnected: vein.isConnected, request: vein.request, settle: getDeviceJwt },
    atom: { isConnected: atom.isConnected, request: atom.request, settle: getBpStationJwt },
  }

  /** cam-host の鍵を 1 本取る。取れなければ null。 */
  async function mint(request: Request): Promise<{ token: string, expMs: number } | null> {
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
      const signed = await signAlarmDeviceNonce(nonce, request)
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

  /** 取って渡し、次の取り直しを予約する。機体が抜けた (世代が変わった) 後の結果は捨てる。 */
  async function handOver(gen: number, name: CamHostSignerName, send: SendMessage): Promise<void> {
    const signer = signers[name]
    // 機体の鍵の取得 (接続時の先取り) とその機体への署名要求がぶつからないよう、先に済ませる
    try {
      await signer.settle()
    }
    catch { /* 機体の鍵の成否はこちらに関係ない */ }
    if (gen !== generation) return
    const minted = await mint(signer.request)
    if (gen !== generation) return
    if (!minted) {
      timer = setTimeout(() => start(gen, name, send), RETRY_MS)
      return
    }
    try {
      send(ALC_CAM_EXTENSION_ID, { type: 'cam_host_token', token: minted.token, exp: Math.floor(minted.expMs / 1000) }, swallowLastError)
    }
    catch { /* 拡張が無い */ }
    timer = setTimeout(() => start(gen, name, send), Math.max(minted.expMs - REFRESH_BEFORE_MS - Date.now(), 0))
  }

  function start(gen: number, name: CamHostSignerName, send: SendMessage): void {
    timer = null
    void handOver(gen, name, send)
  }

  /** 抜き差しのたびに、繋がっている機体に頼み直す (どれも無ければ止める) */
  function reselect(): void {
    const next = CAM_HOST_SIGNERS.find(name => signers[name].isConnected.value) ?? null
    if (next === current) return
    current = next
    generation += 1
    clearTimer()
    if (!next) return
    // 拡張に渡す口が無い端末では鍵を取りにも行かない
    const send = extensionSendMessage()
    if (!send) return
    start(generation, next, send)
  }

  // 抜き差しを取りこぼさないよう同期で見る (useDeviceToken の Vein Station の watch と同じ)
  watch(CAM_HOST_SIGNERS.map(name => signers[name].isConnected), reselect, { immediate: true, flush: 'sync' })
}
