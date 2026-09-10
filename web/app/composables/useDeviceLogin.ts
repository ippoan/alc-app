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
 * ★ firmware の `ERR AUTH: no key` / `ERR AUTH: bad nonce` は、useSerialArbiter.request の
 * `errPrefix` (= 送った行そのものを echo し返した行だけを reject 対象にする、
 * `AUTH TICKET` の `ERR AUTH TICKET: <理由>` 用の仕組み) には一致しない可能性がある
 * (送った行は `AUTH SIGN <nonce>` だが ERR 行は `ERR AUTH: ...` で nonce を echo しない
 * ため)。firmware が実際に nonce を echo するかはここでは分からないので、
 * useAlarmDevice.request の reject 理由をメッセージの内容 (`no key` を含むか) で判定する
 * ことで、echo の有無どちらでも `no key` だけは拾えるようにしてある。echo が無い場合、
 * 実機では `no key` も `bad nonce` も 10 秒のタイムアウト経由でしか reject されず
 * (useSerialArbiter は matchPrefix/errPrefix どちらにも当てはまらない行を黙って捨てる)、
 * その場合は `deviceLoginTimeoutMessage` に落ちる。この点は親へ [質問] 済み。
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
function parseAuthSigLine(line: string): { pubkey: string, sig: string } | null {
  const parts = line.split(' ')
  if (parts.length !== 4 || parts[0] !== 'AUTH' || parts[1] !== 'SIG') return null
  return { pubkey: parts[2]!, sig: parts[3]! }
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

      let line: string
      try {
        line = await useAlarmDevice().request(`AUTH SIGN ${nonce}`, AUTH_SIGN_MATCH_PREFIX, AUTH_SIGN_TIMEOUT_MS)
      }
      catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        lastError.value = message.includes('no key') ? deviceLoginNoKeyMessage : deviceLoginTimeoutMessage
        return
      }

      const parsed = parseAuthSigLine(line)
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
