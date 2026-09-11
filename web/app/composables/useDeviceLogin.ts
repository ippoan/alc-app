/**
 * 警告デバイス (VoiceS3R) が USB で繋がっていることを根拠にした管理者ログイン (#214)。
 *
 * Google ログインと並ぶ 2 つ目の認証系統。firmware (ippoan/alc-app-s3#205) が
 * `AUTH SIGN <nonce>` に ed25519 署名で応え、auth-worker (ippoan/auth-worker#521/#522) が
 * 公開鍵の登録と nonce 発行・検証を持つ。ここはその間を繋ぐだけで、鍵も署名も検証しない。
 *
 * 手順:
 *   1. `redirect_uri` = `getAuthCallbackUrl()` (Google ログインと**同じ文字列**。
 *      auth-worker は nonce 取得時と device-login 時で完全一致を要求する)
 *   2. `GET <auth base>/auth/device-nonce?redirect_uri=...` (XHR、cookie 不要) → nonce
 *   3. `useAlarmDevice().request('AUTH SIGN ' + nonce, 'AUTH SIG ', 10_000)` で
 *      firmware に署名させる → `AUTH SIG <pubkey> <sig>` を parse
 *   4. `window.location.href = <auth base>/auth/device-login?...` (top-level navigation)。
 *      戻りは Google ログイン後と同じ経路 (cookie / lw_callback fragment) なので
 *      useAuth に新しい取り込みは作らない
 *
 * useHubClaim.ts (#213 CoreS3 自動端末登録) と同じ構造 (module-level state + 1 関数)。
 *
 * `AUTH SIGN <nonce>` を送って `AUTH SIG <pubkey> <sig>` を parse する部分は
 * `signAlarmDeviceNonce` に切り出してある (useDeviceToken.ts の短命端末 JWT #231 と共有。
 * #234-2 で送り先を引数化 — useDeviceToken.ts は CoreS3 (`useCoreS3Serial().request`) を渡し、
 * ここ (/login) は既定値のまま警告デバイス (`useAlarmDevice().request`) を使い続ける)。
 * firmware の `ERR AUTH: no key` / `ERR AUTH: bad nonce` は useSerialArbiter.request の
 * `errPrefix` (`ERR ${送った行の先頭トークン}` = `ERR AUTH`) に一致するため、nonce を
 * echo しなくても即 reject される (10 秒のタイムアウトを待たない)。
 */
import { getAuthCallbackUrl } from '~/composables/useAuth'
import {
  deviceLoginNoKeyMessage,
  deviceLoginNonceFailedMessage,
  deviceLoginParseFailedMessage,
  deviceLoginTimeoutMessage,
} from '~/utils/device-login-messages'

/** firmware への `AUTH SIGN <nonce>` 応答を待つ上限 (useHubClaim の AUTH TICKET と同じ 10 秒) */
const AUTH_SIGN_TIMEOUT_MS = 10_000
const AUTH_SIGN_MATCH_PREFIX = 'AUTH SIG '

/** 直近の失敗理由 (画面表示用)。成功 / 未実行なら null */
const lastError = ref<string | null>(null)
/** login() が進行中か (ボタンの disabled に使う) */
const busy = ref(false)
/** 二重起動防止 (同時に 1 回だけ) */
let loggingIn = false

/**
 * `GET <authWorkerUrl>/auth/device-nonce?redirect_uri=...` を XHR で叩き nonce を取る。
 * cookie は不要 (CORS `*`) なので withCredentials は既定の false のまま。
 */
function fetchNonce(authWorkerUrl: string, redirectUri: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const url = `${authWorkerUrl}/auth/device-nonce?redirect_uri=${encodeURIComponent(redirectUri)}`
    xhr.open('GET', url, true)
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`http ${xhr.status}`))
        return
      }
      let data: { nonce?: string }
      try {
        data = JSON.parse(xhr.responseText) as { nonce?: string }
      }
      catch {
        reject(new Error('応答をJSONとして解釈できません'))
        return
      }
      if (!data.nonce) {
        reject(new Error('応答にnonceが含まれていません'))
        return
      }
      resolve(data.nonce)
    }
    xhr.onerror = () => reject(new Error('通信エラー'))
    xhr.send()
  })
}

/** `AUTH SIG <pubkey> <sig>` を空白で分割して parse。形式が合わなければ null */
export function parseAuthSigLine(line: string): { pubkey: string, sig: string } | null {
  const parts = line.split(' ')
  if (parts.length !== 4 || parts[0] !== 'AUTH' || parts[1] !== 'SIG') return null
  return { pubkey: parts[2]!, sig: parts[3]! }
}

/**
 * `AUTH SIGN <nonce>` を送り、応答 `AUTH SIG <pubkey> <sig>` を parse して
 * 返す (#214 useDeviceLogin / #231 useDeviceToken 共通)。送り先は `request` (既定は
 * 警告デバイス `useAlarmDevice().request`、useDeviceToken.ts は CoreS3
 * `useCoreS3Serial().request` を渡す。#234-2)。firmware が `ERR AUTH: ...` を
 * 返せば request がそのまま reject するので、ここでは投げっぱなしにする
 * (呼び出し側でメッセージを出し分ける)。parse に失敗したときだけ null を返す。
 */
export async function signAlarmDeviceNonce(
  nonce: string,
  request: (line: string, matchPrefix: string, timeoutMs: number) => Promise<string> = useAlarmDevice().request,
): Promise<{ pubkey: string, sig: string } | null> {
  const line = await request(`AUTH SIGN ${nonce}`, AUTH_SIGN_MATCH_PREFIX, AUTH_SIGN_TIMEOUT_MS)
  return parseAuthSigLine(line)
}

export function useDeviceLogin() {
  const config = useRuntimeConfig()

  /** 警告デバイスに署名させ、成功すれば auth-worker の device-login へ top-level navigate する */
  async function login(): Promise<void> {
    if (loggingIn) return
    loggingIn = true
    busy.value = true
    lastError.value = null
    try {
      const authWorkerUrl = (config.public.authWorkerUrl as string).replace(/\/$/, '')
      // ★ nonce 取得と device-login で同じ変数を 2 回使う (1 文字でも変えると auth-worker が 401)
      const redirectUri = getAuthCallbackUrl()

      let nonce: string
      try {
        nonce = await fetchNonce(authWorkerUrl, redirectUri)
      }
      catch (e) {
        // fetchNonce は必ず Error で reject する (このファイル内で完結する私有関数)。
        // instanceof の分岐は到達不能になるため付けない (coverage 100% gate、Refs CLAUDE.md)
        lastError.value = deviceLoginNonceFailedMessage((e as Error).message)
        return
      }

      let parsed: { pubkey: string, sig: string } | null
      try {
        parsed = await signAlarmDeviceNonce(nonce)
      }
      catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        lastError.value = message.includes('no key') ? deviceLoginNoKeyMessage : deviceLoginTimeoutMessage
        return
      }

      if (!parsed) {
        lastError.value = deviceLoginParseFailedMessage
        return
      }

      const query = `pubkey=${encodeURIComponent(parsed.pubkey)}&nonce=${encodeURIComponent(nonce)}`
        + `&sig=${encodeURIComponent(parsed.sig)}&redirect_uri=${encodeURIComponent(redirectUri)}`
      window.location.href = `${authWorkerUrl}/auth/device-login?${query}`
    }
    finally {
      loggingIn = false
      busy.value = false
    }
  }

  return {
    /** 直近の失敗理由。成功 / 未実行なら null */
    lastError: readonly(lastError),
    /** login() が進行中か */
    busy: readonly(busy),
    login,
  }
}
