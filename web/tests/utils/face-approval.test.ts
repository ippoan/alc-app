import { describe, it, expect } from 'vitest'
import { checkFaceApproval } from '~/utils/face-approval'

// 乗務員名は合成値のみ (実在の名前・カード番号は書かない)
describe('checkFaceApproval — 顔が未登録の人だけスキップ可 (Refs ippoan/alc-app-s3#135)', () => {
  it('承認済みは従来どおり顔認証を要求する', () => {
    expect(checkFaceApproval({ name: 'テスト太郎', face_approval_status: 'approved' }))
      .toEqual({ kind: 'require_face' })
  })

  it('未登録はスキップできる', () => {
    const d = checkFaceApproval({ name: 'テスト太郎', face_approval_status: 'none' })
    expect(d.kind).toBe('skip_face')
    expect(d.kind === 'skip_face' && d.message).toContain('未登録')
    expect(d.kind === 'skip_face' && d.message).toContain('スキップ')
  })

  it('face_approval_status が未設定なら未登録扱いでスキップできる', () => {
    const d = checkFaceApproval({ name: 'テスト花子' })
    expect(d.kind).toBe('skip_face')
    expect(d.kind === 'skip_face' && d.message).toContain('テスト花子さん')
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
