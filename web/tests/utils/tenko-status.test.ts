import { describe, it, expect } from 'vitest'
import { tenkoStatusLabel } from '~/utils/tenko-status'

describe('tenkoStatusLabel', () => {
  it('既知の status を日本語にする', () => {
    expect(tenkoStatusLabel('identity_verified')).toBe('本人確認済')
    expect(tenkoStatusLabel('medical_pending')).toBe('医療測定待ち')
    expect(tenkoStatusLabel('cancelled')).toBe('キャンセル')
  })

  it('2 つの管理画面に無かった carrying_items_pending も出る', () => {
    expect(tenkoStatusLabel('carrying_items_pending')).toBe('携行品確認待ち')
  })

  it('知らない値は生のまま返す (従来の map[s] || s と同じ)', () => {
    expect(tenkoStatusLabel('who_knows')).toBe('who_knows')
    expect(tenkoStatusLabel('')).toBe('')
  })
})
