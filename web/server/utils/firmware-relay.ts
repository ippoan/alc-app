/**
 * CoreS3 のファームを管理者の画面から 1 台ずつ更新する (Refs ippoan/alc-app#403) の
 * 純粋ロジック。副作用 (introspect / fetch) は server/api/firmware/* と
 * server/utils/introspect-route.ts。
 *
 * 登場する相手は 2 つ:
 * - cf-alc-recorder … キオスクからの報告の保存 (`ota-report`)・一覧 (`ota-status`)・
 *   キオスクへの更新の合図 (`serial-ota`)
 * - auth-worker … 端末の登録簿 (`/internal/device-labels`。未失効の端末とそのラベル)
 *
 * どちらも `Authorization: <INTERNAL_SHARED_SECRET>` の生の値で叩く (Bearer を付けない)。
 *
 * ★ tenant_id は auth-worker introspect の結果だけを使う。
 * ★ 報告の中身の検査 (key の選別・値の形) はここに写さない — recorder の
 *   `parseOtaReport` 1 か所が持つ。
 */
import type { Forward, IntrospectClaims } from './print-relay'
import { RECORDER_BASE } from './print-relay'
import { PUNCH_DEVICE_ROLES } from './timecard-relay'

const AUTH_WORKER_BASE = 'https://auth-worker.internal'

/** 一覧を見る・更新を指示してよい利用者の role。 */
const FIRMWARE_ADMIN_ROLE = 'admin'

/** 更新の合図の target。**呼び元から受け取らない** (この経路が更新するのは CoreS3 だけ)。 */
const FIRMWARE_TARGET = 'cores3'

/** 端末の id の形 (recorder の検査と同じ: 英数字 `-` `_` の 1〜64 文字)。 */
const FIRMWARE_DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export type FirmwareAccess =
  | { ok: true, tenantId: string }
  | { ok: false, status: 401 | 403, message: string }

/**
 * 報告を送ってよいか (pure)。**キオスクの端末の token だけ。**
 *
 * 利用者の token (admin / member / viewer) を通さないのは、報告が「この端末に
 * 繋がっている機体の状態」で、利用者の画面からは作れないものだから
 * (`decideTimecardPunchAccess` は利用者を通すので流用しない)。
 */
export function decideFirmwareReportAccess(claims: IntrospectClaims): FirmwareAccess {
  if (!claims.active || !claims.tenant_id) {
    return { ok: false, status: 401, message: 'token が無効です' }
  }
  if (typeof claims.role !== 'string' || !PUNCH_DEVICE_ROLES.has(claims.role)) {
    return { ok: false, status: 403, message: 'この端末からは報告できません' }
  }
  return { ok: true, tenantId: claims.tenant_id }
}

/** 一覧を見る・更新を指示してよいか (pure)。**利用者の admin だけ。** */
export function decideFirmwareAdminAccess(claims: IntrospectClaims): FirmwareAccess {
  if (!claims.active || !claims.tenant_id) {
    return { ok: false, status: 401, message: 'token が無効です' }
  }
  if (claims.role !== FIRMWARE_ADMIN_ROLE) {
    return { ok: false, status: 403, message: 'ファームの更新は管理者のみ実行できます' }
  }
  return { ok: true, tenantId: claims.tenant_id }
}

export function isFirmwareDeviceId(v: unknown): v is string {
  return typeof v === 'string' && FIRMWARE_DEVICE_ID_RE.test(v)
}

/** auth-worker の登録簿 (テナントの未失効の端末とラベル) への forward request を組む。 */
export function buildDeviceLabelsForward(input: { sharedSecret: string, tenantId: string }): Forward {
  return {
    url: `${AUTH_WORKER_BASE}/internal/device-labels?tenant_id=${encodeURIComponent(input.tenantId)}`,
    init: { method: 'GET', headers: { Authorization: input.sharedSecret } },
  }
}

/**
 * 登録簿の応答 `{devices:[{device_id, label}]}` を `device_id → label` にする。
 * 形が違えば null (呼び元が「取れなかった」と区別できるように、空の Map にしない)。
 */
export function parseDeviceLabels(json: unknown): Map<string, string | null> | null {
  const devices = (json as { devices?: unknown } | null | undefined)?.devices
  if (!Array.isArray(devices)) return null
  const labels = new Map<string, string | null>()
  for (const d of devices as Array<{ device_id?: unknown, label?: unknown } | null>) {
    if (typeof d?.device_id !== 'string') continue
    labels.set(d.device_id, typeof d.label === 'string' ? d.label : null)
  }
  return labels
}

/**
 * 登録簿を引く。**取れなかったら (非 200・形違い・例外) null** — どう倒すかは呼び元が決める
 * (報告は fail-closed で 503、一覧はラベル無しで出す)。
 */
export async function loadDeviceLabels(
  authWorker: { fetch: typeof fetch },
  input: { sharedSecret: string, tenantId: string },
): Promise<Map<string, string | null> | null> {
  const fwd = buildDeviceLabelsForward(input)
  try {
    const res = await authWorker.fetch(fwd.url, fwd.init)
    if (res.status !== 200) return null
    return parseDeviceLabels(await res.json())
  }
  catch {
    return null
  }
}

function recorderTenantUrl(tenantId: string, leaf: string): string {
  return `${RECORDER_BASE}/tenants/${encodeURIComponent(tenantId)}/${leaf}`
}

/**
 * recorder `POST /tenants/:t/ota-report` への forward request を組む。
 * body はキオスクが送ってきた object をそのまま (選別と検査は recorder)。
 */
export function buildOtaReportForward(input: { sharedSecret: string, tenantId: string, report: unknown }): Forward {
  return {
    url: recorderTenantUrl(input.tenantId, 'ota-report'),
    init: {
      method: 'POST',
      headers: { Authorization: input.sharedSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify(input.report),
    },
  }
}

/** recorder `GET /tenants/:t/ota-status` への forward request を組む。 */
export function buildOtaStatusForward(input: { sharedSecret: string, tenantId: string }): Forward {
  return {
    url: recorderTenantUrl(input.tenantId, 'ota-status'),
    init: { method: 'GET', headers: { Authorization: input.sharedSecret } },
  }
}

/**
 * recorder `POST /tenants/:t/serial-ota` への forward request を組む。
 *
 * **`device_id` は必須。** recorder は `cores3` で device_id 無しを弾かないので、
 * 無しで送ると合図が端末の指定なしで全キオスクへ出る。
 */
export function buildSerialOtaForward(input: { sharedSecret: string, tenantId: string, deviceId: string }): Forward {
  return {
    url: recorderTenantUrl(input.tenantId, 'serial-ota'),
    init: {
      method: 'POST',
      headers: { Authorization: input.sharedSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: FIRMWARE_TARGET, device_id: input.deviceId }),
    },
  }
}

/**
 * recorder の一覧 `{devices:[…]}` の各要素に `label` を足す。
 *
 * - `labels` が null (登録簿が取れなかった)、または Map に無い端末は `label: null`
 * - **recorder が省いた key は省いたまま** (null を足さない)
 * - `status` の形が違えば空の一覧
 */
export function mergeFirmwareDevices(
  status: unknown,
  labels: Map<string, string | null> | null,
): { devices: Array<Record<string, unknown>> } {
  const devices = (status as { devices?: unknown } | null | undefined)?.devices
  if (!Array.isArray(devices)) return { devices: [] }
  return {
    devices: devices
      .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object' && !Array.isArray(d))
      .map(d => ({ ...d, label: labels?.get(d.device_id as string) ?? null })),
  }
}
