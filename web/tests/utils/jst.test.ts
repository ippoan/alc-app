import { describe, it, expect } from 'vitest'

import { jstTodayStartIso } from '~/utils/jst'

// サーバ側 (rust-alc-api の list_today_punches) と同じ境界であることを固定する。
// ずれると「今日の打刻」がクライアントとサーバで食い違う
// (Refs ippoan/alc-app-s3#134)
describe('jstTodayStartIso', () => {
  it('JST の日付が UTC より進んでいる時間帯 (JST 00:30)', () => {
    // 2026-09-04T15:30Z = JST 09-05 00:30 → JST 09-05 の 0 時
    expect(jstTodayStartIso(new Date('2026-09-04T15:30:00Z')))
      .toBe('2026-09-04T15:00:00.000Z')
  })

  it('同じ UTC 日でも JST では前日 (JST 23:30)', () => {
    // 2026-09-04T14:30Z = JST 09-04 23:30 → JST 09-04 の 0 時
    expect(jstTodayStartIso(new Date('2026-09-04T14:30:00Z')))
      .toBe('2026-09-03T15:00:00.000Z')
  })

  it('ちょうど JST 0 時', () => {
    expect(jstTodayStartIso(new Date('2026-09-04T15:00:00Z')))
      .toBe('2026-09-04T15:00:00.000Z')
  })

  it('JST 昼', () => {
    // 2026-09-05T03:00Z = JST 09-05 12:00
    expect(jstTodayStartIso(new Date('2026-09-05T03:00:00Z')))
      .toBe('2026-09-04T15:00:00.000Z')
  })
})
