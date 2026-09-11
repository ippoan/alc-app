/**
 * キオスク端末用 device JWT の取得 (#434 step 3c の中核)。
 *
 * auth-worker の device pairing (`/device/pair`, role=device-kiosk) で発行された
 * **device credential** (`device_id` + `device_secret`) を localStorage に保持し、
 * runtime で auth-worker `/device/token` に提示して **短命 device JWT** (1h) を
 * mint する。キオスクはこの device JWT を `Authorization: Bearer` で alc-app の
 * server proxy (`/api/proxy/*`, #434 Option ①) に送る。
 *
 * - credential (device_id + device_secret) は pairing で 1 度だけ取得・保存する。
 *   device_secret は auth-worker 側では hash 保存・再取得不可。
 * - device JWT は 1h なので expiry の 60s 手前まで cache を再利用する。
 * - credential 無し / mint 失敗時は null を返す (呼び出し側は従来の X-Tenant-ID
 *   経路に fallback できる = 段階移行で非破壊)。
 *
 * NOTE: 既存の `useAuth` が持つ `alc_device_id` は **rust-alc-api の devices
 * テーブル id** であり、ここで扱う auth-worker の device credential とは別系統。
 * 混同を避けるため別 localStorage key (`alc_kiosk_device_*`) を使う。
 *
 * ## CoreS3 の署名による短命端末 JWT (#231 → #234-2 で署名の相手を CoreS3 に変更)
 *
 * 運行管理者の PC には credential を発行・保存しない (ログイン無しの共用 PC のため)。
 * 代わりに、CoreS3 (統合ハブ) が USB で挿さっている間だけ、その ed25519 鍵の署名で
 * auth-worker (ippoan/auth-worker#552) から `aud=device, role=device-kiosk` の
 * 短命 JWT (900 秒) を取り、**このモジュールと同じメモリ cache** に載せる
 * (storage には一切書かない — 抜線すれば次の getDeviceJwt() で消える。CoreS3 の
 * `onClose` でも即座にキャッシュを捨てる)。
 * `getDeviceJwt()` の優先順位は「cache → CoreS3 署名 → 既存 credential」。
 *
 * 警告デバイス (VoiceS3R) は運行管理者の機器で LAN が無く、認証には使わない
 * (ユーザー決定。Refs ippoan/alc-app#234)。
 *
 * - 署名の取り方 (`AUTH SIGN <nonce>` → `AUTH SIG <pubkey> <sig>` parse) は
 *   `useDeviceLogin.ts` の `signAlarmDeviceNonce` を共有する (#214 と同じ firmware I/F。
 *   送り先は `useCoreS3Serial().request` を渡す)。
 * - 同時呼び出しは 1 本にまとめる (`jwtInFlight`)。
 * - 失敗 (ERR / 401 `{error:"invalid_alarm_token"}` / 429 / タイムアウト / 通信エラー、
 *   いずれも HTTP status だけで判定する) したら `CORE_S3_BACKOFF_MS` の間 CoreS3 署名経路を
 *   試さず credential 経路へ落ちる。再接続での解除はしない (次に呼ばれたとき抑止期間が
 *   過ぎていれば自然に再試行する)。失敗理由は `lastError` に残し、成功したら null に戻す。
 * - `/device/alarm-token` の応答に載る `tenant_id` が `deviceTenantId` と食い違っても
 *   拒否しない (`console.warn` のみ — 発行元 auth-worker 側の判断を尊重する)。
 */
import { ref, computed, readonly } from 'vue'
import { signAlarmDeviceNonce } from '~/composables/useDeviceLogin'

const KIOSK_DEVICE_ID_KEY = 'alc_kiosk_device_id'
const KIOSK_DEVICE_SECRET_KEY = 'alc_kiosk_device_secret'

/** device JWT 再利用の手前マージン (ms)。expiry ギリギリの token を返さない。 */
const REFRESH_BEFORE_MS = 60_000
/** expires_in 欠落時の fallback TTL (秒、auth-worker DEVICE_JWT_TTL_SECONDS と同値)。 */
const DEFAULT_TTL_SECONDS = 3600
/** CoreS3 署名 JWT の expires_in 欠落時 fallback TTL (秒。auth-worker #552 と同値) */
const CORE_S3_DEFAULT_TTL_SECONDS = 900
/** CoreS3 署名経路が失敗してから、これだけ試さない (ms)。再接続での解除は無い。 */
const CORE_S3_BACKOFF_MS = 60_000

const isClient = typeof window !== 'undefined'

const kioskDeviceId = ref<string | null>(
  isClient ? localStorage.getItem(KIOSK_DEVICE_ID_KEY) : null,
)
const kioskDeviceSecret = ref<string | null>(
  isClient ? localStorage.getItem(KIOSK_DEVICE_SECRET_KEY) : null,
)

// 短命 device JWT の cache (module スコープ = 全 caller で共有。CoreS3 署名経路も
// credential 経路も同じ cache に書く — 呼び出し側からは出どころの違いを見せない)。
// ref にしてあるのは hasDeviceJwt (#234-2、兄弟 #p135-c234-3 が使う) から参照できるようにするため。
const cachedJwt = ref<string | null>(null)
let cachedExpMs = 0

// getDeviceJwt() の single-flight。同時に何回呼ばれても実際の取得は 1 本にまとめる。
let jwtInFlight: Promise<string | null> | null = null
// CoreS3 署名経路の直近の失敗時刻から CORE_S3_BACKOFF_MS 経つまでは試さない (ms epoch)。
let coreS3BackoffUntilMs = 0
// CoreS3 署名経路の直近の失敗理由 (画面表示用)。成功 / 未試行なら null
const lastError = ref<string | null>(null)
// CoreS3 の再接続監視 (キャッシュ破棄) を二重登録しないためのガード (useHubClaim と同じ流儀)
let closeListenerInstalled = false

export function useDeviceToken() {
  const config = useRuntimeConfig()
  const authWorkerUrl = (config.public.authWorkerUrl as string) || 'https://auth.ippoan.org'
  // tenant 食い違いの warn 用 (#231)。読むだけ — 購読はしない
  const { deviceTenantId } = useAuth()

  const hasKioskCredential = computed(() => !!kioskDeviceId.value && !!kioskDeviceSecret.value)
  /** 期限内の device JWT を cache に持っているか (#234-2、兄弟 #p135-c234-3 が使う) */
  const hasDeviceJwt = computed(() => !!cachedJwt.value && cachedExpMs > Date.now())

  const coreS3 = useCoreS3Serial()
  // CoreS3 を抜線したら短命 JWT も即座に捨てる (親の決定)。useHubClaim と同じ
  // listenerInstalled 流儀で、useDeviceToken() を複数回呼んでも二重登録しない。
  if (!closeListenerInstalled) {
    closeListenerInstalled = true
    coreS3.onClose(() => {
      cachedJwt.value = null
      cachedExpMs = 0
    })
  }

  /** pairing で得た device credential を保存する (device JWT cache は破棄)。 */
  function storeKioskCredential(id: string, secret: string): void {
    kioskDeviceId.value = id
    kioskDeviceSecret.value = secret
    cachedJwt.value = null
    cachedExpMs = 0
    if (isClient) {
      localStorage.setItem(KIOSK_DEVICE_ID_KEY, id)
      localStorage.setItem(KIOSK_DEVICE_SECRET_KEY, secret)
    }
  }

  /** device credential と device JWT cache を破棄する (端末退役・revoke 後)。 */
  function clearKioskCredential(): void {
    kioskDeviceId.value = null
    kioskDeviceSecret.value = null
    cachedJwt.value = null
    cachedExpMs = 0
    if (isClient) {
      localStorage.removeItem(KIOSK_DEVICE_ID_KEY)
      localStorage.removeItem(KIOSK_DEVICE_SECRET_KEY)
    }
  }

  /**
   * device JWT を返す。優先順位は cache → CoreS3 の署名 (#234-2) →
   * 既存 credential (`/device/token`)。全経路失敗時は null (呼び出し側は X-Tenant-ID
   * 経路に fallback)。同時呼び出しは 1 本にまとめる (`jwtInFlight`)。
   */
  async function getDeviceJwt(): Promise<string | null> {
    const nowMs = Date.now()
    if (cachedJwt.value && cachedExpMs - REFRESH_BEFORE_MS > nowMs) return cachedJwt.value

    if (!jwtInFlight) {
      jwtInFlight = mintDeviceJwt().finally(() => { jwtInFlight = null })
    }
    return jwtInFlight
  }

  /** cache 以外の 2 経路を順に試す (CoreS3 の署名 → credential)。 */
  async function mintDeviceJwt(): Promise<string | null> {
    const nowMs = Date.now()
    return (await tryCoreS3Jwt(nowMs)) ?? (await tryCredentialJwt(nowMs))
  }

  /**
   * CoreS3 が USB で繋がっていれば、その ed25519 鍵の署名で auth-worker
   * (#552) から短命 JWT を取りに行く。未接続なら起動時の探索 (`startupProbe`、
   * 起動から最大 3 秒で 1 回だけ) を待ち、それでも未接続なら null (以後は待たずに即 null)。
   * 抑止期間中 / いずれかの失敗
   * (401 `{error:"invalid_alarm_token"}` / 429 / タイムアウト / 通信エラー、
   * いずれも HTTP status だけで判定する) なら null を返し、CORE_S3_BACKOFF_MS の
   * 間この経路を抑止する (再接続での解除はしない)。失敗理由は `lastError` に残し、
   * 成功したら null に戻す。
   */
  async function tryCoreS3Jwt(nowMs: number): Promise<string | null> {
    if (nowMs < coreS3BackoffUntilMs) return null
    if (!coreS3.isConnected.value) {
      // 結果の真偽ではなく接続を見直す — 探索で繋がった後に抜かれていれば署名は頼めない
      await coreS3.startupProbe()
      if (!coreS3.isConnected.value) return null
    }

    lastError.value = null
    try {
      const nonceRes = await fetch(`${authWorkerUrl}/device/alarm-nonce`)
      if (!nonceRes.ok) throw new Error(`alarm-nonce http ${nonceRes.status}`)
      const nonceData = (await nonceRes.json()) as { nonce?: string }
      if (!nonceData.nonce) throw new Error('alarm-nonce: nonce 欠落')

      const signed = await signAlarmDeviceNonce(nonceData.nonce, coreS3.request)
      if (!signed) throw new Error('AUTH SIG の parse に失敗')

      const tokenRes = await fetch(`${authWorkerUrl}/device/alarm-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: nonceData.nonce, pubkey: signed.pubkey, sig: signed.sig }),
      })
      if (!tokenRes.ok) throw new Error(`alarm-token http ${tokenRes.status}`)
      const tokenData = (await tokenRes.json()) as {
        access_token?: string
        token_type?: string
        expires_in?: number
        tenant_id?: string
      }
      if (!tokenData.access_token) throw new Error('alarm-token: access_token 欠落')

      // tenant の食い違いは拒否しない (発行元 auth-worker の判断を尊重、warn のみ)
      if (typeof tokenData.tenant_id === 'string' && tokenData.tenant_id !== deviceTenantId.value) {
        console.warn(
          `[useDeviceToken] alarm-token の tenant_id (${tokenData.tenant_id}) が deviceTenantId (${deviceTenantId.value}) と食い違います`,
        )
      }

      const ttl = typeof tokenData.expires_in === 'number' ? tokenData.expires_in : CORE_S3_DEFAULT_TTL_SECONDS
      cachedJwt.value = tokenData.access_token
      cachedExpMs = nowMs + ttl * 1000
      return cachedJwt.value
    }
    catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
      coreS3BackoffUntilMs = nowMs + CORE_S3_BACKOFF_MS
      return null
    }
  }

  /** 既存の credential 経路 (`/device/token`)。挙動は変えない。 */
  async function tryCredentialJwt(nowMs: number): Promise<string | null> {
    const id = kioskDeviceId.value
    const secret = kioskDeviceSecret.value
    if (!id || !secret) return null

    try {
      const res = await fetch(`${authWorkerUrl}/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: id, device_secret: secret }),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { access_token?: string; expires_in?: number }
      if (!data.access_token) return null
      const ttl = typeof data.expires_in === 'number' ? data.expires_in : DEFAULT_TTL_SECONDS
      cachedJwt.value = data.access_token
      cachedExpMs = nowMs + ttl * 1000
      return cachedJwt.value
    } catch {
      return null
    }
  }

  /**
   * 管理者 (operator session) が auth-worker `/device/pair` で device-kiosk
   * credential を発行する (P1 pairing の管理者側)。返り値の credential を QR 等で
   * kiosk に渡し、kiosk 側で `storeKioskCredential` する想定。device_secret は
   * 1 回限り (auth-worker は hash のみ保持) なので呼び出し側で即配布する。
   *
   * @param adminToken 管理者の access token (rust-alc-api / auth-worker 共有 JWT_SECRET)
   * @param label      運用識別ラベル (端末名等)
   * @returns 失敗時は null
   */
  async function pairKioskDevice(
    adminToken: string,
    label: string,
  ): Promise<{ device_id: string; device_secret: string } | null> {
    if (!adminToken) return null
    try {
      const res = await fetch(`${authWorkerUrl}/device/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ label, role: 'device-kiosk' }),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { device_id?: string; device_secret?: string }
      if (!data.device_id || !data.device_secret) return null
      return { device_id: data.device_id, device_secret: data.device_secret }
    } catch {
      return null
    }
  }

  /**
   * この端末をキオスク化する (P1 / 方式1)。管理者がログイン済みの端末で 1 度だけ実行する。
   * 現在の access token で `/device/pair` を叩いて device-kiosk credential を発行し、
   * そのまま端末に保存する (self-pair)。以降この端末は (管理者ログアウト後) device JWT
   * 経由で通信する。通常の管理者セッションは self-pair しないので分離は保たれる。
   *
   * @returns 成功時 true (credential 発行・保存済み)、失敗時 false
   */
  async function setupAsKiosk(adminToken: string, label: string): Promise<boolean> {
    const cred = await pairKioskDevice(adminToken, label)
    if (!cred) return false
    storeKioskCredential(cred.device_id, cred.device_secret)
    return true
  }

  return {
    hasKioskCredential,
    hasDeviceJwt,
    kioskDeviceId: readonly(kioskDeviceId),
    storeKioskCredential,
    clearKioskCredential,
    getDeviceJwt,
    pairKioskDevice,
    setupAsKiosk,
    /** CoreS3 署名経路の直近の失敗理由。成功 / 未試行なら null */
    lastError: readonly(lastError),
  }
}
