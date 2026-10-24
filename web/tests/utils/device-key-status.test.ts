import { describe, it, expect } from 'vitest'
import {
  kindLabel, rowWarnings, unattributedWarning, KIND_LABELS,
  WARNING_HUB_UNLINKED, WARNING_CREDENTIAL, warningHubIdOnKey, warningUnattributed,
  type DeviceKeyStatus, type DeviceKeyStatusRow, type DeviceKeyCounts,
} from '~/utils/device-key-status'

const ZERO: DeviceKeyCounts = {
  hub_measurements_via_key: 0, hub_measurements_hub_id: 0, measurements: 0, vein_enroll: 0, timecard: 0,
}
const row = (kind: DeviceKeyStatusRow['kind'], counts: Partial<DeviceKeyCounts> = {}): DeviceKeyStatusRow => ({
  device_id: 'x', kind, counts: { ...ZERO, ...counts }, last_at: null,
})

describe('kindLabel', () => {
  it('4 種類を日本語にする', () => {
    expect(kindLabel('machine_key')).toBe(KIND_LABELS.machine_key)
    expect(kindLabel('hub_unlinked')).toContain('ハブ')
    expect(kindLabel('credential')).toContain('credential')
    expect(kindLabel('browser')).toBe('ブラウザ打刻')
  })
  it('想定外の値はそのまま出す', () => {
    expect(kindLabel('new_kind')).toBe('new_kind')
  })
})

describe('rowWarnings', () => {
  it('hub_unlinked → ファーム更新の案内', () => {
    expect(rowWarnings(row('hub_unlinked'))).toEqual([WARNING_HUB_UNLINKED])
  })
  it('credential → 機体の鍵を登録する案内', () => {
    expect(rowWarnings(row('credential'))).toEqual([WARNING_CREDENTIAL])
  })
  it('鍵の行で hub の ID の件数が 0 より大きい → 鍵の証明が取れていない警告 (件数入り)', () => {
    expect(rowWarnings(row('machine_key', { hub_measurements_hub_id: 3 }))).toEqual([warningHubIdOnKey(3)])
    expect(warningHubIdOnKey(3)).toContain('3 件')
  })
  it('鍵の行で hub の ID の件数が 0 → 警告なし', () => {
    expect(rowWarnings(row('machine_key', { hub_measurements_via_key: 9 }))).toEqual([])
  })
  it('browser は警告しない', () => {
    expect(rowWarnings(row('browser', { timecard: 5 }))).toEqual([])
  })
})

describe('unattributedWarning', () => {
  const st = (n: number): DeviceKeyStatus => ({ days: 7, devices: [], unattributed: { measurements: n, last_at: null } })
  it('0 件なら null', () => {
    expect(unattributedWarning(st(0))).toBeNull()
  })
  it('1 件以上なら件数入りの警告', () => {
    expect(unattributedWarning(st(4))).toBe(warningUnattributed(4))
    expect(warningUnattributed(4)).toContain('4 件')
  })
})
