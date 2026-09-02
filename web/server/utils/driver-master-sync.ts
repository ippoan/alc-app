/**
 * 免許証タブ「theearth から乗務員マスタを同期」(Refs ippoan/alc-app-s3#125) の
 * 純粋ロジック。副作用 (introspect / relay への fetch) は
 * server/api/driver-master/run.post.ts。
 *
 * 乗務員の免許 (交付日・有効期限 = nfc_id 16 桁) の正は theearth (web地球号) の
 * 乗務員マスタで、nuxt-dtako-admin の dtako-scraper-relay が cron で alc の
 * employees へ流している。管理者が「今すぐ同期」を押せるよう、relay の
 * `POST /kintai-relay/driver-master-run` を server-to-server で叩く。
 *
 * alc-app は theearth の comp_id を知らず tenant_id しか持たない。relay 側が
 * `{tenant_id}` を DTAKO_ACCOUNTS で comp_id 群に写し、comp ごとの結果
 * `{results:[{comp_id,status,created,updated,skipped,error?}]}` を返す。
 *
 * ★ tenant_id は auth-worker introspect の結果だけを使う — ブラウザからの
 * body / query は route で一切読まない (読むと任意テナントへ書ける、#434 の再現)。
 */
import type { Forward } from './print-relay'

const RELAY_BASE = 'https://scraper-relay.internal'

/**
 * 同期を起動できる role の allowlist。employees への書き込みを起こす操作なので
 * `admin` (auth-worker の user.role) だけ。`viewer` (閲覧者) は 403。
 */
export const DRIVER_MASTER_SYNC_ROLES: ReadonlySet<string> = new Set(['admin'])

/** auth-worker `/auth/introspect` 応答のうち、ここで見る field。 */
export interface IntrospectClaims {
  active?: boolean
  tenant_id?: string
  role?: string
}

export type DriverMasterAccess =
  | { ok: true; tenantId: string }
  | { ok: false; status: 401 | 403; message: string }

/**
 * introspect 結果から「同期を起動してよいか」と書き先 tenant_id を決める (pure)。
 * - inactive / tenant_id 無し → 401
 * - role が allowlist 外 → 403
 */
export function decideDriverMasterAccess(claims: IntrospectClaims): DriverMasterAccess {
  if (!claims.active || !claims.tenant_id) {
    return { ok: false, status: 401, message: 'token が無効です' }
  }
  if (typeof claims.role !== 'string' || !DRIVER_MASTER_SYNC_ROLES.has(claims.role)) {
    return { ok: false, status: 403, message: '乗務員マスタ同期は管理者のみ実行できます' }
  }
  return { ok: true, tenantId: claims.tenant_id }
}

/**
 * relay `POST /kintai-relay/driver-master-run` への forward request を組む。
 * 認証は `X-Alc-Proxy-Secret` (= INTERNAL_SHARED_SECRET、relay が constant-time 比較)。
 * body は `{tenant_id}` だけ (introspect 由来の値以外を運ばない)。
 */
export function buildDriverMasterRunForward(input: { sharedSecret: string; tenantId: string }): Forward {
  return {
    url: `${RELAY_BASE}/kintai-relay/driver-master-run`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Alc-Proxy-Secret': input.sharedSecret,
      },
      body: JSON.stringify({ tenant_id: input.tenantId }),
    },
  }
}
