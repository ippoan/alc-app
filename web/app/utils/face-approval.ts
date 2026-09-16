/** 顔承認ステータスチェック (共通ユーティリティ) */

/**
 * 顔認証をどう扱うかの判定 (Refs ippoan/alc-app-s3#135)。
 *
 * - `require_face` … 顔が登録・承認済み。従来どおり顔認証を要求する
 * - `skip_face`    … 顔が未登録 (`none` / 未設定)。顔写真なしで先へ進める
 * - `blocked`      … 登録済みだが通せない (`pending` / `rejected` / 未知)
 *
 * **`pending` (審査中) と `rejected` (却下) は登録済みなので従来どおり弾く。**
 * 却下された人の迂回路を作らないため、スキップ可にするのは未登録だけ。
 */
export type FaceApprovalDecision =
  | { kind: 'require_face' }
  | { kind: 'skip_face'; message: string }
  | { kind: 'blocked'; message: string }

const blockedMessages: Record<string, string> = {
  pending: '顔データは承認待ちです。管理者に承認を依頼してください',
  rejected: '顔データが却下されています。再登録してください',
}

/** 顔が未登録とみなすステータス (未設定を含む) */
const UNREGISTERED = 'none'

/**
 * 従業員の顔承認ステータスから、顔認証の扱いを決める。
 * 呼び出し側 (RoleAuthGate / TenkoKiosk) はこの判定にだけ従う。
 */
export function checkFaceApproval(emp: { name: string; face_approval_status?: string }): FaceApprovalDecision {
  const status = emp.face_approval_status ?? UNREGISTERED
  if (status === 'approved') return { kind: 'require_face' }
  if (status === UNREGISTERED) {
    return { kind: 'skip_face', message: `${emp.name}さん: 顔データが未登録です。顔認証をスキップできます` }
  }
  const msg = blockedMessages[status] ?? '顔データが未承認です'
  return { kind: 'blocked', message: `${emp.name}さん: ${msg}` }
}
