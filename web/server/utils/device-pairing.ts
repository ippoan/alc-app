/**
 * AlcoholChecker 端末登録 (claim) 時に device credential を provisioning する orchestration
 * (Refs ippoan/rust-alc-api#434 caller #5、Phase C 案B)。
 *
 * フロー:
 *   ① 端末 → alc-app /api/devices/register/claim (本 handler)
 *   ② alc-app → auth-worker /alc-internal-proxy/api/devices/register/claim → rust
 *        rust が device 登録し { success, tenant_id, device_id, settings_token } を返す
 *   ③ tenant_id が取れたら alc-app → auth-worker /device/pair-internal (server-to-server,
 *        X-Internal-Shared-Secret) で device credential (device_id + device_secret) を mint
 *   ④ claim レスポンスに { auth_device_id, device_secret } を merge して端末へ返す
 *
 * 端末はこの device_secret を保存し、以降 `/device/token` で短命 device JWT を取得して
 * device 経路 (report-version 等) を Authorization: Bearer で叩く。INTERNAL_SHARED_SECRET は
 * 端末に焼かない (alc-app Worker だけが保持)。
 *
 * tenant_id が取れない flow (qr_permanent = 管理者承認待ち) では pairing をスキップし、rust の
 * claim レスポンスをそのまま返す (credential は承認時に別途発行する想定)。
 */
import type { H3Event } from 'h3'
import { buildInternalProxyForward } from './internal-proxy'

/** auth-worker の device-uploader role (lib/device.ts DEVICE_ROLE と同値)。 */
const DEVICE_ROLE_UPLOADER = 'device-uploader'

export interface PairInternalForward {
  url: string
  init: RequestInit
}

/**
 * auth-worker `/device/pair-internal` への server-to-server forward request を構築する
 * (pure、テスト対象)。X-Internal-Shared-Secret で認証し tenant_id を明示渡しする。
 */
export function buildPairInternalForward(input: {
  sharedSecret: string
  tenantId: string
  label: string
  role?: string
}): PairInternalForward {
  return {
    url: 'https://auth-internal.internal/device/pair-internal',
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Shared-Secret': input.sharedSecret,
      },
      body: JSON.stringify({
        tenant_id: input.tenantId,
        label: input.label,
        role: input.role ?? DEVICE_ROLE_UPLOADER,
      }),
    },
  }
}

/** rust claim レスポンスの最小形 (provisioning に必要な field のみ)。 */
interface ClaimResponse {
  success?: boolean
  tenant_id?: string | null
  device_id?: string | null
  settings_token?: string | null
  [k: string]: unknown
}

interface PairInternalResponse {
  device_id?: string
  device_secret?: string
}

function cfEnv(event: H3Event): Record<string, unknown> {
  return (event.context.cloudflare as { env?: Record<string, unknown> } | undefined)?.env ?? {}
}

async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
}

/**
 * claim を rust に forward → 成功かつ tenant_id が取れたら device credential を mint して
 * レスポンスに merge する Nitro server route handler。
 */
export function createClaimWithPairingHandler() {
  return defineEventHandler(async (event): Promise<unknown> => {
    const env = cfEnv(event)
    const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
    if (!sharedSecret) {
      throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
    }
    const authWorker = env.AUTH_WORKER as { fetch: typeof fetch } | undefined
    if (!authWorker) {
      throw createError({ statusCode: 503, statusMessage: 'AUTH_WORKER service binding が未設定です' })
    }

    // ① claim を rust へ forward (public-ingest と同じ /alc-internal-proxy 経路)。
    const parsed = await readBody(event).catch(() => undefined)
    const { url, init } = buildInternalProxyForward({
      sharedSecret,
      rustPath: '/api/devices/register/claim',
      method: 'POST',
      contentType: parsed ? 'application/json' : undefined,
      body: parsed ? JSON.stringify(parsed) : undefined,
    })
    const claimRes = await authWorker.fetch(url, init)
    const claimText = await claimRes.text()
    let claim: ClaimResponse
    try {
      claim = JSON.parse(claimText) as ClaimResponse
    } catch {
      // rust が JSON 以外を返した時はそのまま透過。
      setResponseStatus(event, claimRes.status)
      return claimText
    }

    setResponseStatus(event, claimRes.status)

    // ② 即承認 flow (tenant_id あり) のみ device credential を mint して merge。
    if (claimRes.ok && claim.success && claim.tenant_id) {
      try {
        const pair = buildPairInternalForward({
          sharedSecret,
          tenantId: claim.tenant_id,
          label: (claim.device_id as string | undefined) || 'alc-device',
        })
        const pairRes = await authWorker.fetch(pair.url, pair.init)
        if (pairRes.ok) {
          const cred = (await pairRes.json()) as PairInternalResponse
          if (cred.device_id && cred.device_secret) {
            return { ...claim, auth_device_id: cred.device_id, device_secret: cred.device_secret }
          }
        }
        // pairing 失敗は claim 自体を壊さない (端末は従来 X-Device-Token 経路で動作継続)。
      } catch {
        // 同上: provisioning 失敗時も claim レスポンスは返す。
      }
    }

    return claim
  })
}
