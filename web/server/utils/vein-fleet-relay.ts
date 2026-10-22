/**
 * 全端末の指静脈の対応表 (モジュールの ID ↔ 乗務員) を管理者の画面に集める
 * (Refs ippoan/alc-app#436) の純粋ロジック。副作用 (introspect / fetch) は
 * server/api/vein-fleet/* と server/utils/introspect-route.ts。
 *
 * 流れ (ファームの更新の報告と同じ形。firmware-relay.ts):
 * 1. 管理者が `POST /api/vein-fleet/request` → recorder が購読中のキオスクへ
 *    `vein_list_request` の合図 (WebSocket)
 * 2. キオスクが自分の対応表を `POST /api/vein-fleet/report` → recorder の DO storage に保存し、
 *    管理者の購読へ `vein_list_updated` の合図 (WebSocket)
 * 3. 管理者の画面が合図を受けて `GET /api/vein-fleet` で引き直す
 *
 * ★ 報告の端末は **token の `sub` (端末の id) だけ**から決める。body の device_id は読まない。
 * ★ 対応表の中身の検査は recorder の `parseVeinListReport` 1 か所が持つ。ここに写さない。
 * ★ 生体データ (記録の中身) は通さない。どの ID に誰を置いたかだけ。
 */
import type { Forward, IntrospectClaims } from './print-relay'
import { RECORDER_BASE } from './print-relay'
import type { FirmwareAccess } from './firmware-relay'

/** 一覧を見る・合図を出してよい利用者の role。 */
const VEIN_FLEET_ADMIN_ROLE = 'admin'

/** 一覧を見る・合図を出してよいか (pure)。**利用者の admin だけ。** */
export function decideVeinFleetAdminAccess(claims: IntrospectClaims): FirmwareAccess {
  if (!claims.active || !claims.tenant_id) {
    return { ok: false, status: 401, message: 'token が無効です' }
  }
  if (claims.role !== VEIN_FLEET_ADMIN_ROLE) {
    return { ok: false, status: 403, message: '指静脈の一覧は管理者のみ見られます' }
  }
  return { ok: true, tenantId: claims.tenant_id }
}

/**
 * recorder `/tenants/:t/vein-list-{request,report,status}` への forward request を組む。
 * `report` を渡したときだけ POST の body に載せる (`request` は空の POST、`status` は GET)。
 */
export function buildVeinListForward(input: {
  sharedSecret: string
  tenantId: string
  leaf: 'request' | 'report' | 'status'
  report?: Record<string, unknown>
}): Forward {
  const url = `${RECORDER_BASE}/tenants/${encodeURIComponent(input.tenantId)}/vein-list-${input.leaf}`
  if (input.leaf === 'status') {
    return { url, init: { method: 'GET', headers: { Authorization: input.sharedSecret } } }
  }
  return {
    url,
    init: {
      method: 'POST',
      headers: { Authorization: input.sharedSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify(input.report ?? {}),
    },
  }
}
