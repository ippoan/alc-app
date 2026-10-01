import { describe, it, expect } from 'vitest'
import { checkFaceApproval, shouldSkipManagerFaceAuth } from '~/utils/face-approval'

// 乗務員名は合成値のみ (実在の名前・カード番号は書かない)
describe('checkFaceApproval — 未登録だけ別扱い、スキップ可否は入口が決める (Refs ippoan/alc-app-s3#135)', () => {
  it('承認済みは従来どおり顔認証を要求する', () => {
    expect(checkFaceApproval({ name: 'テスト太郎', face_approval_status: 'approved' }))
      .toEqual({ kind: 'require_face' })
  })

  it('未登録はスキップできる (入口が通す判断をするための unregistered)', () => {
    const d = checkFaceApproval({ name: 'テスト太郎', face_approval_status: 'none' })
    expect(d.kind).toBe('unregistered')
    expect(d.kind === 'unregistered' && d.message).toContain('未登録')
  })

  it('未登録のメッセージは事実だけを述べる (続く案内は入口ごとに変わる)', () => {
    const d = checkFaceApproval({ name: 'テスト太郎', face_approval_status: 'none' })
    expect(d).toEqual({ kind: 'unregistered', message: 'テスト太郎さん: 顔データが未登録です' })
  })

  it('face_approval_status が未設定なら未登録扱い', () => {
    const d = checkFaceApproval({ name: 'テスト花子' })
    expect(d.kind).toBe('unregistered')
    expect(d.kind === 'unregistered' && d.message).toContain('テスト花子さん')
  })

  it('審査中は弾く', () => {
    const d = checkFaceApproval({ name: 'テスト次郎', face_approval_status: 'pending' })
    expect(d.kind).toBe('blocked')
    expect(d.kind === 'blocked' && d.message).toContain('承認待ち')
  })

  it('却下は弾く (スキップの迂回路を作らない)', () => {
    const d = checkFaceApproval({ name: 'テスト三郎', face_approval_status: 'rejected' })
    expect(d.kind).toBe('blocked')
    expect(d.kind === 'blocked' && d.message).toContain('却下')
  })

  it('未知のステータスは弾く (既定メッセージ)', () => {
    const d = checkFaceApproval({ name: 'テスト四郎', face_approval_status: 'unknown_status' })
    expect(d).toEqual({ kind: 'blocked', message: 'テスト四郎さん: 顔データが未承認です' })
  })
})

describe('shouldSkipManagerFaceAuth — 飛ばすのは IT点呼・未判定の着信だけ (Refs ippoan/alc-app#387)', () => {
  it('IT点呼・未判定は飛ばす', () => {
    expect(shouldSkipManagerFaceAuth({ tenko_method: 'IT点呼', manager_judgment: null })).toBe(true)
  })

  it('IT点呼でも判定済みなら顔認証', () => {
    expect(shouldSkipManagerFaceAuth({ tenko_method: 'IT点呼', manager_judgment: 'ok' })).toBe(false)
    expect(shouldSkipManagerFaceAuth({ tenko_method: 'IT点呼', manager_judgment: 'ng' })).toBe(false)
  })

  it('遠隔点呼は未判定でも顔認証', () => {
    expect(shouldSkipManagerFaceAuth({ tenko_method: '遠隔点呼', manager_judgment: null })).toBe(false)
  })

  it('点呼方法が分からなければ顔認証', () => {
    expect(shouldSkipManagerFaceAuth({ manager_judgment: null })).toBe(false)
  })

  it('点呼の中身が無ければ顔認証 (null / undefined)', () => {
    expect(shouldSkipManagerFaceAuth(null)).toBe(false)
    expect(shouldSkipManagerFaceAuth(undefined)).toBe(false)
  })
})
