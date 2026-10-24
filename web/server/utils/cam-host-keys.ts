/**
 * 録画タブの端末候補に出す **CoreS3 の鍵** (拠点 PC の拡張に渡す cam-host の鍵の元)。
 *
 * auth-worker の `GET /device/setup/alarm-keys` (operator の tenant に登録済みの鍵の一覧。
 * `sub` = その鍵で出る端末 JWT の sub `alarm:<fingerprint>`) を、管理者の JWT で引く。
 * あの口は auth.ippoan.org の cookie session (`logi_auth_token`) で読むので、alc.ippoan.org の
 * ブラウザからは直接呼べない (別 origin)。server route が同じ JWT を cookie に載せて
 * service binding で中継する。
 *
 * cam-host の鍵は用途 `kiosk` の鍵 (CoreS3) の署名でだけ出るので、候補はその用途だけに絞る。
 */
import { AUTH_COOKIE_NAME } from './proxy-target'

const AUTH_WORKER_BASE = 'https://auth-worker.internal'

/** CoreS3 の鍵の用途 (auth-worker の `AlarmKeyUsage`) */
export const CAM_HOST_SIGNER_USAGE = 'kiosk'

export interface CamHostKey {
  /** cam_camera_devices.device_id に入れる値 (`alarm:<fingerprint>`) */
  device_id: string
  label: string | null
}

/** 名前を引くための鍵 (全用途・失効済みを含む) */
export interface AlarmKeyName extends CamHostKey {
  revoked: boolean
}

interface AlarmKey extends AlarmKeyName {
  usage: string
}

/** auth-worker `/device/setup/alarm-keys` への forward request を組む。 */
export function buildAlarmKeysForward(token: string): { url: string, init: RequestInit } {
  return {
    url: `${AUTH_WORKER_BASE}/device/setup/alarm-keys`,
    init: { method: 'GET', headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` } },
  }
}

/** 応答 `{keys:[{sub, label, usage, revoked_at}]}` の鍵を全用途・失効済みまで取り出す。形が違えば空。 */
function parseAlarmKeys(json: unknown): AlarmKey[] {
  const keys = (json as { keys?: unknown } | null | undefined)?.keys
  if (!Array.isArray(keys)) return []
  const out: AlarmKey[] = []
  for (const k of keys as Array<{ sub?: unknown, label?: unknown, usage?: unknown, revoked_at?: unknown } | null>) {
    if (typeof k?.sub !== 'string' || !k.sub) continue
    out.push({
      device_id: k.sub,
      label: typeof k.label === 'string' && k.label ? k.label : null,
      usage: typeof k.usage === 'string' ? k.usage : '',
      revoked: k.revoked_at != null,
    })
  }
  return out
}

/** 名前付け用: 全用途・失効済みの鍵 (`alarm:<fp>` の名前と失効の印) */
export function parseAlarmKeyNames(json: unknown): AlarmKeyName[] {
  return parseAlarmKeys(json).map(({ device_id, label, revoked }) => ({ device_id, label, revoked }))
}

/** 担当付け用: CoreS3 (kiosk) の鍵だけ。 */
export function parseCamHostKeys(json: unknown): CamHostKey[] {
  return parseAlarmKeys(json)
    .filter(k => k.usage === CAM_HOST_SIGNER_USAGE)
    .map(({ device_id, label }) => ({ device_id, label }))
}
