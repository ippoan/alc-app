import { describe, it, expect } from 'vitest'
import { manifestRoleFromQuery, BP_TAB, BP_STATION, type ManifestRole } from '~/composables/useRoleManifest'

// 測定台の URL は `?station=bp` (manifest-bp.webmanifest の start_url は
// `/?role=driver&tab=bp&station=bp`)。以前は `?tab=bp` しか見ておらず、
// 測定台のインストール名が「点呼キオスク」になっていた (Refs ippoan/alc-app#353)。

describe('manifestRoleFromQuery — 測定台 (?station=bp)', () => {
  it('定数は index.vue の DriverSubTab / isBpStation と同じ値', () => {
    expect(BP_TAB).toBe('bp')
    expect(BP_STATION).toBe('bp')
  })

  it.each<[string, Record<string, unknown>, ManifestRole]>([
    // 修正の本体: station だけで bp になる
    ['?station=bp だけ', { station: 'bp' }, 'bp'],
    ['?role=driver&station=bp', { role: 'driver', station: 'bp' }, 'bp'],
    ['station が配列 (先頭を見る)', { station: ['bp', 'other'] }, 'bp'],
    // 従来どおり: 既にインストール済みの端末の start_url は tab=bp を持つ
    ['?tab=bp だけ (従来どおり)', { tab: 'bp' }, 'bp'],
    ['?role=driver&tab=bp (従来どおり)', { role: 'driver', tab: 'bp' }, 'bp'],
    ['start_url そのもの', { role: 'driver', tab: 'bp', station: 'bp' }, 'bp'],
    // station が bp でなければ従来の判定
    ['station が別の値', { station: 'other' }, 'driver'],
    ['station が空', { station: '' }, 'driver'],
    ['station が null (?station)', { station: null }, 'driver'],
    ['station が別の値でも tab=bp なら bp', { station: 'other', tab: 'bp' }, 'bp'],
    // 運行者以外は素通し (?tab=bp と同じ扱い)
    ['運行管理者の ?station=bp は素通し', { role: 'manager', station: 'bp' }, 'manager'],
    ['システム管理者の ?station=bp は素通し', { role: 'admin', station: 'bp' }, 'admin'],
    ['一般の ?station=bp は素通し', { role: 'general', station: 'bp' }, 'general'],
    ['運行管理者の ?tab=bp&station=bp も素通し', { role: 'manager', tab: 'bp', station: 'bp' }, 'manager'],
    ['着信通知は ?station=bp より優先', { mode: 'incoming_call', station: 'bp' }, 'manager'],
  ])('%s → %s', (_label, query, expected) => {
    expect(manifestRoleFromQuery(query)).toBe(expected)
  })
})
