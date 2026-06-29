import type { AuthUser } from '~/types'
import { isClient } from '~/utils/env'

/** Base64url → UTF-8 JSON デコード (マルチバイト文字対応) */
function decodeJwtPayload(base64url: string): any {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

const REFRESH_TOKEN_KEY = 'alc_refresh_token'
const DEVICE_TENANT_KEY = 'alc_device_tenant_id'
const DEVICE_ID_KEY = 'alc_device_id'
const DEVICE_SETTINGS_TOKEN_KEY = 'alc_device_settings_token'

// シングルトン state (composable の外で定義して複数コンポーネント間で共有)
const user = ref<AuthUser | null>(null)
const accessToken = ref<string | null>(null)
const isLoading = ref(true)
// モジュールロード時に即座に復元 (子コンポーネントの onMounted が app.vue の init() より先に走るため)
const deviceTenantId = ref<string | null>(
  isClient ? localStorage.getItem(DEVICE_TENANT_KEY) : null,
)
const deviceId = ref<string | null>(
  isClient ? localStorage.getItem(DEVICE_ID_KEY) : null,
)
// settings 取得用の device 保有 token (Refs rust-alc-api#388)。承認時に backend が発行
const deviceSettingsToken = ref<string | null>(
  isClient ? localStorage.getItem(DEVICE_SETTINGS_TOKEN_KEY) : null,
)

let initialized = false
let inactivityTimerId: ReturnType<typeof setTimeout> | null = null
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000 // 5分

export function useAuth() {
  const config = useRuntimeConfig()

  const isAuthenticated = computed(() => !!accessToken.value)
  const isDeviceActivated = computed(() => !!deviceTenantId.value)

  /** アプリ起動時に呼ぶ: cookie からログイン復元 + device 復元 + staging bypass */
  async function init() {
    if (initialized) return
    initialized = true

    // deviceTenantId はモジュールスコープで既に復元済み

    // #434: auth-worker が logi_auth_token cookie でログインを保持するので、cookie を
    // 消費してログイン状態を復元する (Google login 後の再訪・別タブ等)。cookie 無し /
    // SSR では no-op。cookie session モデルでは silent な token refresh は無く、cookie が
    // 唯一の真実 (失効時は再ログイン)。
    consumeAuthCookie()

    // Device Owner 自動アクティベーション
    if (!isDeviceActivated.value && isClient) {
      const android = (window as any).Android
      if (android?.getProvisioningInfo) {
        try {
          const info = JSON.parse(android.getProvisioningInfo())
          if (info.is_device_owner && info.device_id) {
            activateDevice(info.tenant_id || '', info.device_id)
          }
        }
        catch (e) {
          console.warn('Failed to read provisioning info:', e)
        }
      }
      // 非同期登録完了時のコールバック
      ;(window as any).__deviceOwnerActivated = (tenantId: string, devId: string) => {
        activateDevice(tenantId, devId)
      }
    }

    // Staging auth bypass
    applyStagingBypass(config.public.stagingTenantId as string)

    isLoading.value = false
  }

  /** staging 環境で NUXT_PUBLIC_STAGING_TENANT_ID が設定されていれば自動 activateDevice */
  function applyStagingBypass(stagingTenantId: string) {
    if (stagingTenantId && !isAuthenticated.value && !isDeviceActivated.value) {
      activateDevice(stagingTenantId)
    }
  }

  /** Google OAuth ログイン (Authorization Code Flow + prompt=login) */
  function loginWithGoogleRedirect(redirectAfterLogin?: string): void {
    if (!isClient) return
    const callbackUrl = `${window.location.origin}/auth/callback`
    if (redirectAfterLogin) {
      sessionStorage.setItem('oauth_redirect', redirectAfterLogin)
    }
    // #434: Google OAuth は auth-worker が orchestrate する (rust は dumb backend)。
    // auth-worker が Google と code 交換 → JWT 発行 → logi_auth_token cookie
    // (Domain=.ippoan.org) で配布し callbackUrl へ戻す。client_id / CSRF state / code
    // 交換は auth-worker が担う (HMAC state)。alc-app は戻ってきた cookie を読むだけ。
    const authWorker = (config.public.authWorkerUrl as string).replace(/\/$/, '')
    const params = new URLSearchParams({ redirect_uri: callbackUrl })
    window.location.href = `${authWorker}/oauth/google/redirect?${params.toString()}`
  }

  /**
   * auth-worker が配布した `logi_auth_token` cookie からログイン状態を確立する (#434)。
   * cookie は HttpOnly でない (Domain=.ippoan.org / Secure / SameSite=Lax) ため JS から
   * 読める。Google / auth-worker login 後の callback と init で呼ぶ。cookie 無しなら false。
   */
  function consumeAuthCookie(): boolean {
    if (!isClient) return false
    const raw = document.cookie.match(/(?:^|;\s*)logi_auth_token=([^;]+)/)?.[1]
    if (!raw) return false
    const token = decodeURIComponent(raw)
    accessToken.value = token
    try {
      const parts = token.split('.')
      if (!parts[1]) throw new Error('Invalid JWT')
      const payload = decodeJwtPayload(parts[1])
      const tenantId = payload.tenant_id || payload.org || ''
      user.value = {
        id: payload.sub || payload.user_id || '',
        email: payload.email || '',
        name: payload.name || '',
        tenant_id: tenantId,
        role: payload.role || 'viewer',
      }
      if (tenantId) activateDevice(tenantId)
    } catch { /* デコード失敗してもログイン状態は維持 */ }
    // ログイン確立 → 無操作 auto-logout の監視を開始
    startInactivityWatch()
    return true
  }

  /**
   * セッションを再確立する (#434)。cookie session モデルでは silent な token refresh は
   * 無く、auth-worker が配布した logi_auth_token cookie が唯一の真実。API 層の
   * 401→refresh→retry と各ページ mount 時の復元から呼ばれ、cookie を読み直す。cookie が
   * 無い (= 失効 / 未ログイン) 場合は reject し、呼び出し側はログイン画面へ誘導する
   * (rust の /api/auth/refresh は lockdown で到達不可になるため叩かない)。
   */
  function refreshAccessToken(): Promise<void> {
    if (!consumeAuthCookie()) {
      return Promise.reject(new Error('セッションがありません (再ログインが必要です)'))
    }
    return Promise.resolve()
  }

  /** 無操作タイマーをリセット (操作があるたびに呼ばれる)。
   *  startInactivityWatch (= ログイン確立後) 経由でのみ呼ばれるため accessToken は非 null。 */
  function resetInactivityTimer() {
    if (inactivityTimerId) {
      clearTimeout(inactivityTimerId)
    }
    inactivityTimerId = setTimeout(() => {
      console.log('[Auth] 5分間無操作のため自動ログアウト')
      logout()
    }, INACTIVITY_TIMEOUT_MS)
  }

  /** ユーザー操作イベントの監視を開始。
   *  consumeAuthCookie / handleLineworksHash (= isClient ガード済み) からのみ呼ばれる。 */
  function startInactivityWatch() {
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'] as const
    for (const event of events) {
      window.addEventListener(event, resetInactivityTimer, { passive: true })
    }
    resetInactivityTimer()
  }

  /** ユーザー操作イベントの監視を停止 */
  function stopInactivityWatch() {
    if (!isClient) return
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'] as const
    for (const event of events) {
      window.removeEventListener(event, resetInactivityTimer)
    }
    if (inactivityTimerId) {
      clearTimeout(inactivityTimerId)
      inactivityTimerId = null
    }
  }

  /** ログアウト (端末の tenant_id は保持) */
  function logout() {
    // 無操作タイマー停止 + ローカル state クリア
    stopInactivityWatch()
    accessToken.value = null
    user.value = null

    if (isClient) {
      localStorage.removeItem(REFRESH_TOKEN_KEY)
      // #434: logi_auth_token cookie (Domain=.ippoan.org) のクリアと Google セッション
      // 破棄は auth-worker /logout に委譲する (rust は dumb backend で logout endpoint を
      // 持たない)。/logout 後は ?redirect_uri のログイン画面へ戻る。
      const authWorker = (config.public.authWorkerUrl as string).replace(/\/$/, '')
      const redirectUri = `${window.location.origin}/login`
      window.location.href = `${authWorker}/logout?redirect_uri=${encodeURIComponent(redirectUri)}`
    }
    // deviceTenantId は意図的に保持 (キオスクモード継続)
  }

  /** 端末をテナントにアクティベート */
  function activateDevice(tenantId: string, devId?: string, settingsToken?: string) {
    deviceTenantId.value = tenantId
    if (devId) deviceId.value = devId
    if (settingsToken) deviceSettingsToken.value = settingsToken
    if (isClient) {
      localStorage.setItem(DEVICE_TENANT_KEY, tenantId)
      if (devId) {
        localStorage.setItem(DEVICE_ID_KEY, devId)
        // Android SharedPreferences にも保存 (アプリ起動時の自動接続判断用)
        const android = (window as any).Android
        if (android?.setDeviceId) {
          android.setDeviceId(devId)
        }
      }
      if (settingsToken) {
        localStorage.setItem(DEVICE_SETTINGS_TOKEN_KEY, settingsToken)
      }
    }
  }

  /** 端末のアクティベーションを解除 */
  function deactivateDevice() {
    deviceTenantId.value = null
    deviceId.value = null
    deviceSettingsToken.value = null
    if (isClient) {
      localStorage.removeItem(DEVICE_TENANT_KEY)
      localStorage.removeItem(DEVICE_ID_KEY)
      localStorage.removeItem(DEVICE_SETTINGS_TOKEN_KEY)
      const android = (window as any).Android
      if (android?.setDeviceId) {
        android.setDeviceId('')
      }
    }
  }

  /** LINE WORKS コールバックの hash fragment からトークンをセット (auth-worker 形式) */
  function handleLineworksHash(): boolean {
    if (!isClient) return false
    const hash = window.location.hash
    const search = window.location.search
    if (!hash.includes('token=')) return false

    const params = new URLSearchParams(hash.slice(1))
    // lw_callback=1 がハッシュまたはクエリに含まれる場合のみ処理
    if (!params.get('lw_callback') && !search.includes('lw_callback=1')) return false

    const token = params.get('token')
    const refreshToken = params.get('refresh_token')
    if (!token) return false

    // JWT payload からユーザー情報をデコード
    accessToken.value = token

    if (refreshToken) {
      localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken)
    }
    try {
      const parts = token.split('.')
      if (!parts[1]) throw new Error('Invalid JWT')
      const payload = decodeJwtPayload(parts[1])
      const tenantId = payload.tenant_id || payload.org || ''
      user.value = {
        id: payload.sub || payload.user_id || '',
        email: payload.email || '',
        name: payload.name || '',
        tenant_id: tenantId,
        role: payload.role || 'viewer',
      }
      // tenant_id があればデバイスをアクティベート (X-Tenant-ID ヘッダー用)
      if (tenantId) activateDevice(tenantId)
    } catch { /* デコード失敗してもログイン状態は維持 */ }
    // ログイン確立 → 無操作 auto-logout の監視を開始
    startInactivityWatch()

    // hash をクリア（lw_callback パラメータも除去）
    const cleanSearch = new URLSearchParams(search.slice(1))
    cleanSearch.delete('lw_callback')
    const qs = cleanSearch.toString()
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))

    return true
  }

  return {
    user: readonly(user),
    accessToken: readonly(accessToken),
    isAuthenticated,
    isLoading: readonly(isLoading),
    deviceTenantId: readonly(deviceTenantId),
    deviceId: readonly(deviceId),
    deviceSettingsToken: readonly(deviceSettingsToken),
    isDeviceActivated,
    init,
    loginWithGoogleRedirect,
    consumeAuthCookie,
    handleLineworksHash,
    refreshAccessToken,
    logout,
    activateDevice,
    deactivateDevice,
    applyStagingBypass,
  }
}
