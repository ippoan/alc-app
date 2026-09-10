import type { AuthUser } from '~/types'
import { isClient } from '~/utils/env'
import { rePairDevice } from '~/utils/api'
import { getOrCreateWebInstallId } from '~/utils/webInstallId'

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

/** 共用の運行者端末から Google のブラウザセッションを切るために開く URL (#193)。
 *  実測 (2026-09-09): `?continue=` で自ホストへ戻す経路は Google 所有ホスト以外 400、
 *  ログイン時の `prompt=login` は Google が守らない。このURLを開くだけならその場で
 *  サインアウトが成立するので、別タブで開いて戻りは期待しない。 */
const GOOGLE_LOGOUT_URL = 'https://accounts.google.com/Logout'

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

/**
 * Google ログイン (`loginWithGoogleRedirect`) が auth-worker に渡す `redirect_uri` の
 * 唯一の出どころ。警告デバイス認証 (#214) も同じ文字列を nonce 取得と device-login の
 * 両方で使う必要があるため、ここから呼ぶ (文字列リテラル `/auth/callback` はここ 1 か所)。
 */
export function getAuthCallbackUrl(): string {
  return `${window.location.origin}/auth/callback`
}

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

  /** staging 環境で NUXT_PUBLIC_STAGING_TENANT_ID が設定されていれば自動 activateDevice。
   *  ただし端末登録リセット直後 (sessionStorage フラグ) は 1 回だけスキップし、実登録
   *  (URL/QR claim で device_id を入れる) の導線を通す。バイパスは tenant のみで device_id
   *  を持たないため、これが残ると WS/FCM が繋がらないまま「登録済み」に見えてしまう。 */
  function applyStagingBypass(stagingTenantId: string) {
    if (isClient && sessionStorage.getItem('alc_skip_staging_bypass')) {
      sessionStorage.removeItem('alc_skip_staging_bypass')
      return
    }
    if (stagingTenantId && !isAuthenticated.value && !isDeviceActivated.value) {
      activateDevice(stagingTenantId)
    }
  }

  /** Google OAuth ログイン (Authorization Code Flow) */
  function loginWithGoogleRedirect(redirectAfterLogin?: string): void {
    if (!isClient) return
    const callbackUrl = getAuthCallbackUrl()
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
      // どのブラウザでもページを離れない (#195)。フルページ遷移すると WebSerial が
      // 閉じて警告デバイスへの heartbeat が切れ、沈黙として鳴ってしまう (Refs #189)。
      // 運行者端末が端末登録を通しているとは限らない (共用 PC は Google ログインのみ)
      // ため、端末登録の有無で分けない。
      void logoutInPlace()
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

  /** client 側のログイン状態だけを消す (無操作タイマー停止 + state + refresh token)。
   *  cookie とサーバ側セッションは触らない。logout / logoutInPlace の共通部分。 */
  function clearClientSession() {
    stopInactivityWatch()
    accessToken.value = null
    user.value = null
    if (isClient) {
      localStorage.removeItem(REFRESH_TOKEN_KEY)
    }
  }

  /**
   * ページを離れずにログアウトする (無操作 auto-logout、#189, #195)。
   * client 状態を消すだけでは logi_auth_token cookie が残り、次の 401 → refresh
   * (refreshAccessToken → consumeAuthCookie) でセッションが復活してしまうため、
   * cookie の失効まで行う。auth-worker /logout に Domain 付き / 無しの両 variant を
   * 消させ (Domain/Path を client で推測しない)、併せて client 側でも上書きする。
   * deviceId / deviceTenantId は保持する (端末登録は継続)。
   */
  async function logoutInPlace() {
    const authWorker = (config.public.authWorkerUrl as string).replace(/\/$/, '')
    try {
      // no-cors のためレスポンスは読めない。Set-Cookie は反映される。
      await fetch(`${authWorker}/logout`, {
        credentials: 'include',
        mode: 'no-cors',
        keepalive: true,
      })
    }
    catch { /* オフライン等。下の client 側上書きで cookie は落とす */ }
    clearAuthCookieClientSide()
    clearClientSession()
  }

  /** logi_auth_token を client 側でも失効させる。配布時の Domain (親ドメイン) 付きと
   *  Domain 無しの 2 通りを書く (どちらで配布されたかは client から分からない)。 */
  function clearAuthCookieClientSide() {
    const base = 'logi_auth_token=; Max-Age=0; Path=/; Secure; SameSite=Lax'
    document.cookie = base
    const parentDomain = window.location.hostname.split('.').slice(1).join('.')
    if (parentDomain) {
      document.cookie = `${base}; Domain=.${parentDomain}`
    }
  }

  /** ログアウト (端末の tenant_id は保持) */
  function logout() {
    // 無操作タイマー停止 + ローカル state クリア
    clearClientSession()

    if (isClient) {
      // どのブラウザでも Google のブラウザセッションを切る (#193, #195)。切らないと
      // 「アカウントを選択」に直前のユーザーが残り、1 クリックで戻れてしまう。共用の
      // 運行者端末が端末登録を通しているとは限らない (共用 PC は Google ログインのみ)
      // ため、端末登録の有無で分けない。管理者 PC でもサインアウトされる (許容)。
      // ★ await を挟まずクリックと同じ tick で呼ぶこと。ユーザー操作の中でしか
      //   window.open は popup blocker を通らない (呼び出し側も同期呼び出しのまま)。
      let opened: Window | null = null
      try {
        opened = window.open(GOOGLE_LOGOUT_URL, '_blank', 'noopener,noreferrer')
      }
      catch { /* WebView 等で window.open 自体が使えない場合。下の warn に落とす */ }
      if (!opened) {
        console.warn('[Auth] Google のログアウトタブを開けませんでした')
      }

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
        // setDeviceId は native の settings_token を remove するため、直後に必ず
        // setSettingsToken で再設定する (旧APK互換で guard。呼び忘れが settings_token=false
        // の直接原因だった、Refs rust-alc-api#480)。
        if (android?.setSettingsToken) {
          android.setSettingsToken(settingsToken ?? '')
        }
      }
      if (settingsToken) {
        localStorage.setItem(DEVICE_SETTINGS_TOKEN_KEY, settingsToken)
      }
    }
  }

  /**
   * device 登録 API (claim / status polling) のレスポンスを丸ごと受けて activate する
   * 漏斗関数。tenant/device/settings_token に加え、含まれていれば kiosk device
   * credential (auth_device_id/device_secret) も同時に保存する。
   *
   * activateDevice() を呼び出し箇所ごとに個別に呼ぶと credential 保存を忘れやすい
   * (実際に device-claim.vue で発生した、Refs rust-alc-api#480)。呼び出し箇所は
   * 必ずこちらを使うこと。credential が無ければ (旧 backend / qr_permanent 未承認等)
   * activate 自体は非破壊で続行する。
   */
  function activateFromRegistration(res: {
    tenant_id?: string
    device_id?: string
    settings_token?: string
    auth_device_id?: string
    device_secret?: string
  }) {
    if (!res.tenant_id) return
    activateDevice(res.tenant_id, res.device_id, res.settings_token)
    if (res.auth_device_id && res.device_secret) {
      useDeviceToken().storeKioskCredential(res.auth_device_id, res.device_secret)
      // native (Android) にも credential を渡す。DeviceToken が device JWT を mint
      // するのに必要 (無いと settings / register-fcm-token 等が 403、FCM 登録が通らない)。
      // activateDevice() が setDeviceId → setSettingsToken を済ませた後に呼ぶこと
      // (setDeviceCredential は最後、Refs rust-alc-api#480)。
      const android = (window as any).Android
      if (android?.setDeviceCredential) {
        android.setDeviceCredential(res.auth_device_id, res.device_secret)
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
      // web 側 kiosk credential も破棄 (localStorage)
      useDeviceToken().clearKioskCredential()
      const android = (window as any).Android
      // native も完全リセット (device_id / settings_token / auth_device_id /
      // device_secret クリア + RoomWatcher 停止)。旧APK は resetDeviceRegistration が
      // 無いので setDeviceId('') に degrade (Refs rust-alc-api#480)。
      if (android?.resetDeviceRegistration) {
        android.resetDeviceRegistration()
      } else if (android?.setDeviceId) {
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

  /**
   * 管理者が時限 window を開けた後、端末が device credential を再取得する
   * (再認証、Refs rust-alc-api#495)。deviceId 未登録なら何もせず false。
   * hardware_id は Android bridge (`getHardwareId`、PR4/任意) があればそれを、
   * 無ければ web install id (localStorage 永続の乱数) を送る。成功したら
   * activateFromRegistration と同じ保存先 (kiosk credential + Android native)
   * に反映して true を返す。失敗理由は呼び出し側に区別させない (window 外 /
   * cooldown / TOFU 不一致いずれも false、詳細は rust 側ログにのみ出る)。
   */
  async function reAuthenticateDevice(): Promise<boolean> {
    if (!deviceId.value) return false
    try {
      const android = (window as any).Android
      const hardwareId: string = android?.getHardwareId?.() || getOrCreateWebInstallId()
      const res = await rePairDevice({
        device_id: deviceId.value,
        hardware_id: hardwareId,
        ...(deviceSettingsToken.value ? { settings_token: deviceSettingsToken.value } : {}),
      })
      if (!res.auth_device_id || !res.device_secret) return false
      useDeviceToken().storeKioskCredential(res.auth_device_id, res.device_secret)
      if (android?.setDeviceCredential) {
        android.setDeviceCredential(res.auth_device_id, res.device_secret)
      }
      return true
    } catch {
      return false
    }
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
    activateFromRegistration,
    deactivateDevice,
    applyStagingBypass,
    reAuthenticateDevice,
  }
}
