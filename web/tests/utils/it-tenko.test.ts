import { describe, it, expect } from 'vitest'
import { IT_TENKO_ROOM_PREFIX, isItTenkoRoom, itTenkoRoomId, itTenkoSessionId } from '~/utils/it-tenko'

// IT点呼 の通話の部屋の id = `it-<点呼の記録の id>` (Refs ippoan/alc-app#387)。
// 端末側と運行管理者側が同じ関数を使う — 形をここで固定する

describe('utils/it-tenko', () => {
  it('接頭辞は it-', () => {
    expect(IT_TENKO_ROOM_PREFIX).toBe('it-')
  })

  it('itTenkoRoomId: 点呼の記録の id に接頭辞を付ける', () => {
    expect(itTenkoRoomId('session-1')).toBe('it-session-1')
  })

  it('作った部屋の id から、同じ点呼の記録の id が取り出せる', () => {
    expect(itTenkoSessionId(itTenkoRoomId('session-1'))).toBe('session-1')
    expect(isItTenkoRoom(itTenkoRoomId('session-1'))).toBe(true)
  })

  it.each([
    ['遠隔点呼の部屋 (点呼の記録の id そのまま)', 'session-1'],
    ['画面共有の部屋', 'screen-abc'],
    ['接頭辞だけ', 'it-'],
    ['空文字', ''],
    ['接頭辞が途中にある', 'x-it-session-1'],
    ['大文字', 'IT-session-1'],
  ])('%s は IT点呼 の部屋ではない', (_label, roomId) => {
    expect(isItTenkoRoom(roomId)).toBe(false)
    expect(itTenkoSessionId(roomId)).toBeNull()
  })

  it('点呼の記録の id が it- で始まっていても、剥がすのは先頭の 1 つだけ', () => {
    expect(itTenkoSessionId('it-it-1')).toBe('it-1')
  })
})
