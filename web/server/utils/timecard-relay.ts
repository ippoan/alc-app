/**
 * ブラウザ打刻の中継 (Refs ippoan/alc-app-s3#134) の純粋ロジック。
 * 副作用 (introspect / recorder への fetch) は server/api/timecard/punch.post.ts。
 *
 * # なぜ rust-alc-api を直に叩かないのか
 *
 * 打刻の更新通知 (`/watch-timecard` の `timecard_punch`) は cf-alc-recorder の
 * Durable Object が出している。ブラウザが rust-alc-api へ直行すると **その打刻
 * だけ合図が鳴らない** ので、「NFC 端末で打つと他の画面も更新されるのに、
 * ブラウザで打つと更新されない」という経路依存の挙動になる。
 * ⇒ ブラウザ → 同一オリジンの server route → RECORDER binding → DO、と通す。
 *
 * 同一オリジンにするのは CORS を増やさないため。recorder には
 * `Access-Control-*` も OPTIONS も無いので、ブラウザから直に叩くと
 * `Authorization` ヘッダーの preflight が通らない。
 *
 * ★ tenant_id / device_id は auth-worker introspect の結果だけを使う —
 * ブラウザからの body は `card_id` しか読まない。
 */
import type { Forward, IntrospectClaims } from './print-relay'
import { RECORDER_BASE } from './print-relay'

/**
 * 打刻を作ってよい **device** role の allowlist。キオスク端末だけ。
 *
 * `device-hub` / `device-print` / `device-gateway` を入れないのは、
 * それらの資格情報が盗まれても打刻を捏造できないようにするため
 * (cf-alc-recorder の `WATCHER_DEVICE_ROLES` と同じ範囲に揃えてある)。
 * **NFC タイムカード端末 (`device-timecard`) もここには要らない** — あちらは
 * WS の measurement 経路で打つ。
 */
export const PUNCH_DEVICE_ROLES: ReadonlySet<string> = new Set(['device-kiosk'])

/** device role の接頭辞 (auth-worker の role 命名規約)。 */
const DEVICE_ROLE_PREFIX = 'device-'

/**
 * ログイン利用者の打刻に使う device_id。
 *
 * 従来 rust 側 (`create_punch`) がキオスク UUID の無いブラウザ打刻に付けていた
 * 値と同じ文字列にしてある — 変えると打刻履歴の「端末」列が経路の切り替え前後で
 * 割れる。**端末 (auth-worker 発行の device_id) とは名前空間が衝突しない。**
 */
export const BROWSER_DEVICE_ID = 'browser'

export type TimecardPunchAccess =
  | { ok: true, tenantId: string, deviceId: string }
  | { ok: false, status: 401 | 403, message: string }

/**
 * introspect 結果から「打刻してよいか」と書き先 (tenant_id / device_id) を決める (pure)。
 *
 * - inactive / tenant_id 無し → 401
 * - device role で allowlist 外 (印刷ブリッジ / ハブ / GW) → 403
 * - キオスクの device JWT → device_id は `sub` (= auth-worker の device_id)。
 *   端末が打った打刻と同じ列に、どの端末で打ったかが残る
 * - 利用者の browser JWT → device_id は `browser` (従来と同じ)
 *
 * **role で user / device を見分けるだけで、user 側の role は問わない。**
 * 打刻は「自分のテナントに 1 行足す」だけの最小操作で、切り替え前は
 * `X-Tenant-ID` だけで通っていた経路 — ここで user role の allowlist を
 * 発明すると、名前を知らない role の利用者が現場で打てなくなる方が高くつく。
 */
export function decideTimecardPunchAccess(claims: IntrospectClaims): TimecardPunchAccess {
  if (!claims.active || !claims.tenant_id) {
    return { ok: false, status: 401, message: 'token が無効です' }
  }
  const role = typeof claims.role === 'string' ? claims.role : ''
  if (role.startsWith(DEVICE_ROLE_PREFIX)) {
    if (!PUNCH_DEVICE_ROLES.has(role)) {
      return { ok: false, status: 403, message: 'この端末では打刻できません' }
    }
    // device 経路は sub (device_id) が要る。欠けたら fail-closed
    if (!claims.sub) {
      return { ok: false, status: 401, message: 'token が無効です' }
    }
    return { ok: true, tenantId: claims.tenant_id, deviceId: claims.sub }
  }
  return { ok: true, tenantId: claims.tenant_id, deviceId: BROWSER_DEVICE_ID }
}

/**
 * recorder `POST /tenants/:t/devices/:d/timecard-punch` への forward request を組む。
 * 認証は `Authorization: <INTERNAL_SHARED_SECRET>` (生の値、recorder が定数時間比較)。
 *
 * body は `card_id` だけ。**`kind` も `seq` も送らない** — recorder 側が
 * `timecard` を立てて採番する (クライアントに kind を選ばせない)。
 */
export function buildRecorderTimecardPunchForward(input: {
  sharedSecret: string
  tenantId: string
  deviceId: string
  cardId: string
}): Forward {
  const url = `${RECORDER_BASE}/tenants/${encodeURIComponent(input.tenantId)}/devices/${encodeURIComponent(
    input.deviceId,
  )}/timecard-punch`
  return {
    url,
    init: {
      method: 'POST',
      headers: { Authorization: input.sharedSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_id: input.cardId }),
    },
  }
}
