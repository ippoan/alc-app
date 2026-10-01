import { describe, it, expect } from 'vitest'
import {
  IT_TENKO_METHOD, IT_TENKO_ROOM_PREFIX, MANAGER_JUDGMENT_METHOD,
  defaultJudgmentMethod, isItTenkoRoom, itTenkoRoomId, itTenkoRoomOf, itTenkoSessionId, splitRooms,
} from '~/utils/it-tenko'

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

  // --- 運行管理者側 (受け画面・判定・遠隔点呼モニターの絞り込み) ---

  it('確認の方法の値は backend の method と同じ綴り', () => {
    expect(MANAGER_JUDGMENT_METHOD).toEqual({ IT: 'it', IN_PERSON: 'in_person' })
  })

  it('一覧を絞る tenko_method の値', () => {
    expect(IT_TENKO_METHOD).toBe('IT点呼')
  })

  it('defaultJudgmentMethod: 通話して開いたものは IT、通話なしで開いたものは対面', () => {
    expect(defaultJudgmentMethod(true)).toBe('it')
    expect(defaultJudgmentMethod(false)).toBe('in_person')
  })

  describe('splitRooms', () => {
    it('IT点呼 の部屋とそれ以外に分ける (順序は保つ)', () => {
      expect(splitRooms(['it-session-2', 'session-1', 'screen-abc', 'it-session-1', 'session-3'])).toEqual({
        it: ['it-session-2', 'it-session-1'],
        remote: ['session-1', 'screen-abc', 'session-3'],
      })
    })

    // ★ 遠隔点呼モニターは `remote` だけを見る。IT点呼 の部屋が無い席 (= 開発用の印が無い席。
    // `it-` の部屋は開発用のキオスクからしか作られない) では、一覧が今までと同じであること
    it('★ it- の部屋が無ければ、remote は入力と同じ並び・同じ要素', () => {
      const rooms = ['session-2', 'screen-abc', 'session-1', 'x-it-session-1', 'IT-session-1']
      const { it: itRooms, remote } = splitRooms(rooms)
      expect(remote).toEqual(rooms)
      expect(itRooms).toEqual([])
    })

    it('空の一覧', () => {
      expect(splitRooms([])).toEqual({ it: [], remote: [] })
    })

    it('接頭辞だけの部屋 (it-) は IT点呼 の部屋ではないので remote 側', () => {
      expect(splitRooms(['it-'])).toEqual({ it: [], remote: ['it-'] })
    })
  })

  describe('itTenkoRoomOf', () => {
    it('その記録の部屋が一覧に在れば部屋の id', () => {
      expect(itTenkoRoomOf('session-1', ['session-9', 'it-session-1'])).toBe('it-session-1')
    })

    it('無ければ null (遠隔点呼の部屋は同じ記録の id でも別物)', () => {
      expect(itTenkoRoomOf('session-1', ['session-1', 'it-session-2'])).toBeNull()
      expect(itTenkoRoomOf('session-1', [])).toBeNull()
    })
  })
})
