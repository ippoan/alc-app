import type { H3Event } from 'h3'

/**
 * キオスク proxy (`server/api/proxy/[...path].ts`) のヘルパー群。
 *
 * #434 で確定した Option ① (proxy + service binding) / B案 の alc-app 側実装。
 * キオスク端末は device JWT (role=device-kiosk) を `Authorization: Bearer` で
 * 送り、proxy が auth-worker `/auth/introspect` で検証 (leg A、service binding)
 * してから rust-alc-api に検証済み `X-Tenant-ID` を注入して転送する (leg B)。
 * **device JWT 自体は rust-alc-api に転送しない** (検証は auth-worker に集約)。
 *
 * leg B には proxy 真正性の証明 (X-Tenant-Proxy-Secret) を **載せない** (B案)。
 * proxy 以外からの bare X-Tenant-ID 直叩き (= #434 の穴) は、rust-alc-api の
 * Cloud Run を網層でロックダウン (ingress 制限 + CF Worker / 内部のみ到達可) して
 * 塞ぐ方針 (issue #434 の "future" 前倒し)。網層ロックダウン完了までは X-Tenant-ID
 * 直叩きが残る点に注意。
 */

/** alc-app キオスク端末用 device role (auth-worker `DEVICE_ROLE_KIOSK` と一致)。 */
export const DEVICE_ROLE_KIOSK = 'device-kiosk'

/** Secrets Store binding (`.get()`) / 文字列 のいずれでも値を取り出す。 */
export async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
}

/** CF Worker の binding/env (service binding / secrets store / vars) を取り出す。 */
export function cfEnv(event: H3Event): Record<string, unknown> {
  return (event.context.cloudflare as { env?: Record<string, unknown> } | undefined)?.env ?? {}
}

/** `Authorization: Bearer <jwt>` から JWT を取り出す。無ければ空文字。 */
export function bearerToken(authHeader: string | undefined): string {
  if (!authHeader) return ''
  const m = /^Bearer\s+(.+)$/i.exec(authHeader)
  // noUncheckedIndexedAccess 下では m[1] は string | undefined なので ?? で string に固定。
  return m?.[1] ?? ''
}

/**
 * rust-alc-api への転送ヘッダーを組む。
 *
 * - `Authorization` は **転送しない** (device JWT は proxy で消費済み、Option ①)。
 * - `X-Tenant-ID` は introspect で得た verified tenant のみ (端末は詐称不能)。
 *
 * proxy 真正性の証明 (X-Tenant-Proxy-Secret) は **載せない** (B案)。bare X-Tenant-ID
 * 直叩きは rust-alc-api の Cloud Run 網層ロックダウンで塞ぐ。
 */
export function buildKioskForwardHeaders(input: {
  contentType?: string | null
  tenantId: string
}): Record<string, string> {
  const headers: Record<string, string> = {}
  if (input.contentType) headers['Content-Type'] = input.contentType
  headers['X-Tenant-ID'] = input.tenantId
  return headers
}
