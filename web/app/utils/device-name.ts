import { sameVeinDevice } from './vein-device-label'

/**
 * 人の目に触れる端末 ID を「名前」に揃える共通部品 (Refs ippoan/alc-cam#2)。
 * 名前の正本は auth-worker の機体の鍵のラベル (`GET /api/cam-host-keys` の `names`)。
 * 結び付きの無い hub の ID (= ファーム未更新の機体) だけ、端末の登録簿のラベル (`/api/device-labels`) で補う。
 * server route (`server/api/timecard/punches/csv.get.ts`) も同じ関数を使う (相対 import のみ・Vue / Nuxt に触れない)。
 */

/** 名前付け用の端末 (鍵 / 登録簿)。`label` が無ければ名前としては使わない */
export interface KnownDeviceName {
  device_id: string
  label: string | null
  /** 失効済みの鍵 (無ければ false) */
  revoked?: boolean
}

/** どの名前の表にも無い端末の表示名 */
export const UNNAMED_DEVICE = '名前未登録の端末'

/** ログイン利用者のブラウザ打刻の固定 ID (`server/utils/timecard-relay.ts` の `BROWSER_DEVICE_ID`)。鍵ではない */
export const BROWSER_DEVICE_ID = 'browser'
export const BROWSER_DEVICE_NAME = 'ブラウザ (ログイン利用者の打刻)'

/** 登録簿のラベルで名前を付けた端末 (機体の鍵に結び付いていない hub の ID) に添える印 */
export const KEY_UNREGISTERED_SUFFIX = '(鍵の ID 未登録)'

/** 機体の鍵の ID か (`alarm:<fp>`。recorder の字種に合わせた `alarm-<fp>` も同じ鍵) */
export function isKeyDeviceId(id: string): boolean {
  return /^alarm[:-]/.test(id)
}

/** 機体の鍵のラベル。失効済みは「 (失効)」付き。ラベルが引けなければ null */
export function keyDeviceLabel(deviceId: string, keyNames: KnownDeviceName[]): string | null {
  const hit = keyNames.find(k => k.label && sameVeinDevice(k.device_id, deviceId))
  if (!hit) return null
  return hit.revoked ? `${hit.label} (失効)` : hit.label!
}

/**
 * 端末の表示名。順序:
 * 1. `browser` → 固定名 (鍵ではないので、名前の表に何があっても固定)
 * 2. 機体の鍵 (`alarm:…`) → 鍵のラベル (失効は「(失効)」)。引けなければ `UNNAMED_DEVICE`
 * 3. それ以外 → 登録簿のラベル + 「(鍵の ID 未登録)」
 * 4. どれにも無い → `UNNAMED_DEVICE`
 * device_id は付けない (画面ではツールチップなどの別の場所に出す)
 */
export function deviceDisplayName(deviceId: string, keyNames: KnownDeviceName[], registry: KnownDeviceName[] = []): string {
  if (deviceId === BROWSER_DEVICE_ID) return BROWSER_DEVICE_NAME
  if (isKeyDeviceId(deviceId)) return keyDeviceLabel(deviceId, keyNames) ?? UNNAMED_DEVICE
  const hit = registry.find(r => r.label && r.device_id === deviceId)
  return hit ? `${hit.label} ${KEY_UNREGISTERED_SUFFIX}` : UNNAMED_DEVICE
}
