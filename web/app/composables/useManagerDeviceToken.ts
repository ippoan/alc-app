/**
 * 運行管理者席の警告デバイス (VoiceS3R) の鍵で、**運行管理者用**の短命 device JWT を取る
 * (Refs ippoan/alc-app#337、サーバ側は ippoan/auth-worker#573)。
 *
 * ## なぜ要るか
 *
 * 運行管理者タブは **NFC/社員番号 + 顔認証**で入る設計で、**admin browser JWT を持たない**
 * (`RoleAuthGate.vue` 冒頭:「Google ログイン単独では通過不可」「Google ログインリンクは
 * admin タブ専用 — manager タブでは表示しないこと (バイパス防止)」)。そのため予定管理の
 * API は端末の鍵の経路 (`/device-data-proxy`) を通るが、そこに載っていたのは
 * **キオスクの鍵 (`device-kiosk`)** で、その許可表 (`KIOSK_ROUTES`) に平の
 * `GET /api/tenko/schedules` が無いため 403 になっていた。
 *
 * **キオスクの鍵に予定 CRUD を与えるのは誤り** (端末の鍵が盗まれたら予定が触れてしまう)。
 * 正しくは**運行管理者席の鍵に専用の用途と role を立てる** — それが auth-worker#573:
 *
 * ```
 * GET  /device/alarm-nonce?usage=tenko-manager        → { nonce }
 * POST /device/alarm-token {nonce,pubkey,sig,usage}   → { access_token, expires_in }  (900s)
 * ```
 *
 * - **`usage` は nonce 側 (query) と token 側 (body) の両方に要る** (片方だけだと 401)。
 * - **署名対象は従来どおり** (`AUTH SIGN <nonce>` への ed25519 署名)。**firmware は無変更**。
 * - 出る JWT の role は `device-tenko-manager` で、`/device-data-proxy` で通せるのは
 *   **予定の口だけ**。**`usage` 省略時は従来どおり `kiosk`** に解決するので、
 *   **既存の CoreS3 (キオスク) 経路は 1 文字も変わらない**。
 *
 * ## 署名を頼む相手 — VoiceS3R は既に `AUTH SIGN` に答える
 *
 * #214 の管理者 device-login がまさに VoiceS3R で署名させている経路で、
 * `signAlarmDeviceNonce` (`useDeviceLogin.ts`) は **#234-2 で送り先が引数化済み**、
 * かつ**既定値が `useAlarmDevice().request` (= VoiceS3R)**。だからここは既定値のまま使う
 * — **新しいシリアル経路も firmware 変更も要らない**。
 *
 * `useDeviceToken.ts` 冒頭の「警告デバイス (VoiceS3R) は…認証には使わない (Refs #234)」は
 * 「**キオスクの短命 JWT** の署名相手を VoiceS3R ではなく CoreS3 にする」という決定であって、
 * 「VoiceS3R が署名できない」ではない (#214 は今も VoiceS3R で署名している)。ここは
 * **別の用途 (`tenko-manager`) の別のトークン**なので抵触しない。
 *
 * ## キオスクとは完全に別勘定
 *
 * cache・single-flight・抑止 (backoff)・失敗理由は**すべてこのモジュールに閉じる**。
 * `useDeviceToken.ts` は 1 文字も触らない — キオスクの点呼 (`useTenkoKiosk.ts`) が
 * 運行管理者トークンを掴むことは構造上ありえない (`api.ts` の `scope` も参照)。
 * storage には一切書かない (VoiceS3R を抜けば期限切れとともに消える)。
 */
import { ref, readonly } from 'vue'
import { signAlarmDeviceNonce } from '~/composables/useDeviceLogin'
import { withTimeout, AUTH_WORKER_FETCH_TIMEOUT_MS } from '~/utils/fetch-timeout'

/** auth-worker#573 が運行管理者席の鍵に割り当てた用途。nonce (query) と token (body) の両方で使う。 */
export const MANAGER_KEY_USAGE = 'tenko-manager'

/** `expires_in` 欠落時の fallback TTL (秒。auth-worker#573 の 900s と同値) */
const DEFAULT_TTL_SECONDS = 900
/** 期限ギリギリの token を返さないための手前マージン (ms) */
const REFRESH_BEFORE_MS = 60_000
/** 失敗してから、これだけ再試行しない (ms)。`useDeviceToken` の CoreS3 抑止と同じ長さ */
const BACKOFF_MS = 60_000

/**
 * どの段で落ちたか (`useDeviceToken.DeviceTokenFailureStage` と同じ流儀)。
 * - `no-alarm-device`: VoiceS3R が USB で繋がっていない (署名を頼む相手が居ない)
 * - `nonce`: `/device/alarm-nonce?usage=...` の取得
 * - `sign`: VoiceS3R への署名要求 (`AUTH SIGN`)
 * - `token-exchange`: `/device/alarm-token` の交換 (**鍵が用途「運行管理者席」で未登録なら 401 でここ**)
 */
export type ManagerTokenFailureStage = 'no-alarm-device' | 'nonce' | 'sign' | 'token-exchange'

// --- module スコープ (運行管理者席の PC に 1 つ。キオスクの cache とは別物) ---
const cachedJwt = ref<string | null>(null)
let cachedExpMs = 0
let inFlight: Promise<string | null> | null = null
const backoffUntil = ref(0)
const lastError = ref<string | null>(null)
const lastFailureStage = ref<ManagerTokenFailureStage | null>(null)
const lastFailureStatus = ref<number | null>(null)

/**
 * 失敗を 1 行だけコンソールに出す。**出すのは段と HTTP status だけ** —
 * token・nonce・署名・pubkey は先頭数文字でも出さない (`useDeviceToken` の
 * `warnCoreS3Failure` と同じ方針)。
 */
function warnFailure(stage: ManagerTokenFailureStage, status: number | null): void {
  console.warn(`[useManagerDeviceToken] 運行管理者トークンの取得に失敗 stage=${stage} status=${status ?? '-'}`)
}

export function useManagerDeviceToken() {
  const config = useRuntimeConfig()
  // nuxt.config が既定値を持つので fallback は置かない (useDeviceLogin.ts と同じ流儀)
  const authWorkerUrl = (config.public.authWorkerUrl as string).replace(/\/$/, '')
  const alarm = useAlarmDevice()

  /**
   * 実際に 1 本取りに行く。失敗したら null を返し、`BACKOFF_MS` の間は再試行しない
   * (呼び出し側 = `api.ts` は **キオスクの鍵へ落とさず**、理由を載せたエラーを投げる)。
   */
  async function mint(nowMs: number): Promise<string | null> {
    if (nowMs < backoffUntil.value) return null

    // ★ ここでは**抑止 (backoff) を立てない** — 「まだ挿していない」だけのことがあり、
    // 挿した直後の 1 回目で通ってほしいため (`useDeviceToken` の `no-core-s3` と同じ扱い)。
    if (!alarm.isConnected.value) {
      lastError.value = 'VoiceS3R が USB で繋がっていません'
      lastFailureStage.value = 'no-alarm-device'
      lastFailureStatus.value = null
      warnFailure('no-alarm-device', null)
      return null
    }

    lastError.value = null
    lastFailureStage.value = null
    lastFailureStatus.value = null
    // throw した時点の値がそのまま失敗の段になる
    let stage: ManagerTokenFailureStage = 'nonce'
    let status: number | null = null
    try {
      // ★ usage は query にも body にも要る (片方だけだと auth-worker が 401)
      // auth-worker への HTTP にも上限を載せる (Refs #338 / #340。キオスク経路と同値)
      const nonceRes = await fetch(
        `${authWorkerUrl}/device/alarm-nonce?usage=${MANAGER_KEY_USAGE}`,
        withTimeout({}, AUTH_WORKER_FETCH_TIMEOUT_MS),
      )
      if (!nonceRes.ok) {
        status = nonceRes.status
        throw new Error(`alarm-nonce http ${nonceRes.status}`)
      }
      const nonceData = (await nonceRes.json()) as { nonce?: string }
      if (!nonceData.nonce) throw new Error('alarm-nonce: nonce 欠落')

      stage = 'sign'
      // 送り先は既定値 = 警告デバイス (VoiceS3R)。署名対象は従来どおり nonce そのもの
      const signed = await signAlarmDeviceNonce(nonceData.nonce)
      if (!signed) throw new Error('AUTH SIG の parse に失敗')

      stage = 'token-exchange'
      const tokenRes = await fetch(`${authWorkerUrl}/device/alarm-token`, withTimeout({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nonce: nonceData.nonce,
          pubkey: signed.pubkey,
          sig: signed.sig,
          usage: MANAGER_KEY_USAGE,
        }),
      }, AUTH_WORKER_FETCH_TIMEOUT_MS))
      if (!tokenRes.ok) {
        status = tokenRes.status
        // 鍵が用途「運行管理者席」で未登録ならここに 401 で来る (`/device/setup` の登録待ち)
        throw new Error(`alarm-token http ${tokenRes.status}`)
      }
      const tokenData = (await tokenRes.json()) as { access_token?: string, expires_in?: number }
      if (!tokenData.access_token) throw new Error('alarm-token: access_token 欠落')

      const ttl = typeof tokenData.expires_in === 'number' ? tokenData.expires_in : DEFAULT_TTL_SECONDS
      cachedJwt.value = tokenData.access_token
      cachedExpMs = nowMs + ttl * 1000
      return cachedJwt.value
    }
    catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
      lastFailureStage.value = stage
      lastFailureStatus.value = status
      backoffUntil.value = nowMs + BACKOFF_MS
      warnFailure(stage, status)
      return null
    }
  }

  /**
   * 運行管理者用 device JWT を返す (cache → VoiceS3R の署名)。取れなければ null。
   * 同時呼び出しは 1 本にまとめる (画面が予定一覧と乗務員一覧を同時に読むため)。
   */
  async function getManagerJwt(): Promise<string | null> {
    const nowMs = Date.now()
    if (cachedJwt.value && cachedExpMs - REFRESH_BEFORE_MS > nowMs) return cachedJwt.value

    if (!inFlight) {
      inFlight = mint(nowMs).finally(() => { inFlight = null })
    }
    return inFlight
  }

  return {
    getManagerJwt,
    /** 直近の失敗理由。成功 / 未試行なら null */
    lastError: readonly(lastError),
    /** 直近の失敗がどの段で起きたか。成功 / 未試行なら null */
    lastFailureStage: readonly(lastFailureStage),
    /** 直近の失敗の HTTP status。HTTP を伴わない失敗 / 成功 / 未試行なら null */
    lastFailureStatus: readonly(lastFailureStatus),
    /** 再試行を抑止している期限 (ms epoch)。0 なら抑止していない */
    backoffUntil: readonly(backoffUntil),
  }
}
