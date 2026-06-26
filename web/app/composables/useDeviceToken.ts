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
 */
import { ref, computed, readonly } from 'vue'

const KIOSK_DEVICE_ID_KEY = 'alc_kiosk_device_id'
const KIOSK_DEVICE_SECRET_KEY = 'alc_kiosk_device_secret'

/** device JWT 再利用の手前マージン (ms)。expiry ギリギリの token を返さない。 */
const REFRESH_BEFORE_MS = 60_000
/** expires_in 欠落時の fallback TTL (秒、auth-worker DEVICE_JWT_TTL_SECONDS と同値)。 */
const DEFAULT_TTL_SECONDS = 3600

const isClient = typeof window !== 'undefined'

const kioskDeviceId = ref<string | null>(
  isClient ? localStorage.getItem(KIOSK_DEVICE_ID_KEY) : null,
)
const kioskDeviceSecret = ref<string | null>(
  isClient ? localStorage.getItem(KIOSK_DEVICE_SECRET_KEY) : null,
)

// 短命 device JWT の cache (module スコープ = 全 caller で共有)。
let cachedJwt: string | null = null
let cachedExpMs = 0

export function useDeviceToken() {
  const config = useRuntimeConfig()
  const authWorkerUrl = (config.public.authWorkerUrl as string) || 'https://auth.ippoan.org'

  const hasKioskCredential = computed(() => !!kioskDeviceId.value && !!kioskDeviceSecret.value)

  /** pairing で得た device credential を保存する (device JWT cache は破棄)。 */
  function storeKioskCredential(id: string, secret: string): void {
    kioskDeviceId.value = id
    kioskDeviceSecret.value = secret
    cachedJwt = null
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
    cachedJwt = null
    cachedExpMs = 0
    if (isClient) {
      localStorage.removeItem(KIOSK_DEVICE_ID_KEY)
      localStorage.removeItem(KIOSK_DEVICE_SECRET_KEY)
    }
  }

  /**
   * device JWT を返す。cache が有効ならそれ、無ければ `/device/token` で mint。
   * credential 未保存 / mint 失敗時は null (呼び出し側は X-Tenant-ID 経路に fallback)。
   */
  async function getDeviceJwt(): Promise<string | null> {
    const id = kioskDeviceId.value
    const secret = kioskDeviceSecret.value
    if (!id || !secret) return null

    const nowMs = Date.now()
    if (cachedJwt && cachedExpMs - REFRESH_BEFORE_MS > nowMs) return cachedJwt

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
      cachedJwt = data.access_token
      cachedExpMs = nowMs + ttl * 1000
      return cachedJwt
    } catch {
      return null
    }
  }

  return {
    hasKioskCredential,
    kioskDeviceId: readonly(kioskDeviceId),
    storeKioskCredential,
    clearKioskCredential,
    getDeviceJwt,
  }
}
