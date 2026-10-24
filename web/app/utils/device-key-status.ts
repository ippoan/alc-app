/**
 * 管理画面「端末の鍵の状態」タブの純関数 (Refs ippoan/alc-cam#2、設計書 §7.2)。
 * 応答は alc-cam ingest の `GET /device-key-status?days=N` (alc-app からは `/api/cam-clips/device-key-status`)。
 * 画面 (`DeviceKeyStatus.vue`) は表示だけで、文言と判定はここに集める。
 */

/** 鍵の種類。`machine_key` = 機体の鍵 (`alarm:`) / `hub_unlinked` = 結び付きの無い hub の ID / `credential` = それ以外の登録 / `browser` = ブラウザ打刻 */
export type DeviceKeyKind = 'machine_key' | 'hub_unlinked' | 'credential' | 'browser'

export interface DeviceKeyCounts {
  hub_measurements_via_key: number
  hub_measurements_hub_id: number
  measurements: number
  vein_enroll: number
  timecard: number
}

export interface DeviceKeyStatusRow {
  device_id: string
  kind: DeviceKeyKind
  counts: DeviceKeyCounts
  /** 既存の cam-clips の API と同じ時刻の形 (ISO)。`formatJst` で表示する */
  last_at: string | null
  is_dev?: boolean
}

export interface DeviceKeyStatus {
  days: number
  devices: DeviceKeyStatusRow[]
  /** 端末 ID の無い測定 (管理者ログイン・無認証の経路) */
  unattributed: { measurements: number, last_at: string | null }
}

/** 選べる期間 (日)。上限は API の 90 日 */
export const DEVICE_KEY_STATUS_DAYS = [7, 30, 90] as const
export const DEFAULT_DEVICE_KEY_STATUS_DAYS = 7

export const KIND_LABELS: Record<DeviceKeyKind, string> = {
  machine_key: '機体の鍵',
  hub_unlinked: 'ハブの ID (鍵に未結び付け)',
  credential: '端末の登録 (credential)',
  browser: 'ブラウザ打刻',
}

/** 鍵の種類の日本語。想定外の値はそのまま出す */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind as DeviceKeyKind] ?? kind
}

/** 件数の見出し (表の列の順) */
export const COUNT_LABELS: { key: keyof DeviceKeyCounts, label: string }[] = [
  { key: 'hub_measurements_via_key', label: 'ハブ測定 (鍵の ID)' },
  { key: 'hub_measurements_hub_id', label: 'ハブ測定 (ハブの ID)' },
  { key: 'measurements', label: '測定 (PC)' },
  { key: 'vein_enroll', label: '指静脈の登録' },
  { key: 'timecard', label: '打刻' },
]

/** 警告の文言 (設計書 §7.2 の 4 つ。現場の人が読む短い文) */
export const WARNING_HUB_UNLINKED
  = 'ファームを更新すると、機体の鍵の ID で記録されます。'
export const WARNING_CREDENTIAL
  = 'この PC は機体の鍵ではなく、端末の登録 (credential) で動いています。'
    + 'CoreS3 か Vein Station を挿し、機体の鍵を登録してください。'

export function warningHubIdOnKey(n: number): string {
  return `鍵の証明が取れていません。ハブの ID で記録された測定が ${n} 件あります。機体の鍵の登録を確認してください。`
}

export function warningUnattributed(n: number): string {
  return `端末の鍵の無い測定が ${n} 件あります (管理者ログインのまま測った・鍵が取れなかった)。`
}

/** 注記 (画面の下に常に出す) */
export const NOTE_BEFORE_RECORDING
  = '端末 ID を記録する仕組みを入れる前の記録は、どの端末か分かりません。'

/** 1 行ぶんの警告 (無ければ空)。`browser` は鍵を持たない打刻なので警告しない */
export function rowWarnings(row: DeviceKeyStatusRow): string[] {
  const out: string[] = []
  if (row.kind === 'hub_unlinked') out.push(WARNING_HUB_UNLINKED)
  if (row.kind === 'credential') out.push(WARNING_CREDENTIAL)
  if (row.kind === 'machine_key' && row.counts.hub_measurements_hub_id > 0) {
    out.push(warningHubIdOnKey(row.counts.hub_measurements_hub_id))
  }
  return out
}

/** 端末 ID の無い測定の警告 (0 件なら null) */
export function unattributedWarning(status: DeviceKeyStatus): string | null {
  const n = status.unattributed.measurements
  return n > 0 ? warningUnattributed(n) : null
}
