import { describe, it, expect } from 'vitest'

import { normalizeCardId } from '~/utils/card-id'

// rust-alc-api の normalize_card_id (crates/alc-core/src/repository/timecard.rs)
// と同じ規則であることを固定する。ずれると「登録済みなのに未登録カードと出る」
// 形で壊れる (Refs ippoan/alc-app-s3#134)
describe('normalizeCardId', () => {
  it('端末が送る大文字 IDm を小文字にする', () => {
    expect(normalizeCardId('0123456789ABCDEF')).toBe('0123456789abcdef')
  })

  it('区切りと前後の空白を落とす', () => {
    expect(normalizeCardId('  AA:BB:CC:DD  ')).toBe('aabbccdd')
  })

  it('既に正規化済みの値はそのまま', () => {
    expect(normalizeCardId('0123456789abcdef')).toBe('0123456789abcdef')
  })

  it('免許証の nfc_id (16 桁の数字) には no-op', () => {
    expect(normalizeCardId('2023040120280331')).toBe('2023040120280331')
  })

  it('空白だけなら空文字', () => {
    expect(normalizeCardId('   ')).toBe('')
  })
})
