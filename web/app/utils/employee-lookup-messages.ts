/** 乗務員照会が失敗したときの文言 (理由 + 次の操作) を 1 か所にまとめる */

/** NFC (免許証) で引けなかったとき */
export function employeeNotFoundByNfc(nfcId: string): string {
  return `この免許証は乗務員に登録されていません (NFC ID: ${nfcId})。管理者画面の「免許証」で読み取り → 保存してください`
}

/**
 * 照会の失敗から HTTP の status を読む (読めなければ `null` = 通信の失敗として扱う)。
 *
 * 端末の鍵で送る経路 (`api.ts` の `bearerRequest`) の Error は `.status` を持つが、
 * **管理者のトークンで送る経路 (`@ippoan/auth-client` の `createAuthFetch`) の Error には
 * `.status` が無く**、message が `API エラー (<status>): <本文>` の形になるだけ。そちらは
 * message の**先頭の** `(<3 桁>): ` から読む (本文の中の `(404)` を拾わない)。
 * `createAuthFetch` の文言の形に依存している — 形が変わると読めなくなり、404・400 でも
 * 手元の写しへ倒れる。
 */
export function failureStatus(e: unknown): number | null {
  const status = (e as { status?: unknown } | null)?.status
  if (typeof status === 'number') return status
  const matched = e instanceof Error ? /^[^(]*\((\d{3})\): /.exec(e.message) : null
  return matched ? Number(matched[1]) : null
}

/**
 * 乗務員の照会が失敗したときに画面へ出す文言。**本当に 404 (未登録) のときだけ**
 * `notFoundMessage` を出し、それ以外 (端末の鍵が取れない・通信失敗・5xx 等) は
 * Error の message をそのまま出す — どの失敗も「未登録」と出すと、鍵の不調を
 * 免許証の未登録と取り違える (Refs ippoan/alc-app#436)。
 */
export function employeeLookupFailureMessage(e: unknown, notFoundMessage: string): string {
  if (failureStatus(e) === 404) return notFoundMessage
  return e instanceof Error && e.message ? e.message : '乗務員の照会に失敗しました'
}

/** 社員番号で引けなかったとき */
export function employeeNotFoundByCode(code: string): string {
  return `社員番号「${code}」の乗務員が見つかりません。社員番号を確認するか、管理者に乗務員登録を依頼してください`
}

/** 乗務員は引けたが未消費の点呼予定が無いとき */
export function noPendingSchedule(): string {
  return '未消費の点呼予定がありません。点呼予定を作成してから読み取り直してください'
}

/**
 * 端末登録も CoreS3 の短命 JWT も無く、まだキオスクとして動けないとき
 * (`useKioskAccess`)。今の運行者端末の手順に「ペアリング」という操作は無いので
 * 文言には含めない (Refs #238)。
 * 打刻の失敗表示 (通常点呼) と運行者タブの入口バナーで同じ文言を使う (Refs #206)
 */
export const deviceUnregisteredMessage = 'この端末はまだ使える状態になっていません'

/**
 * CoreS3 経由の短命端末 JWT 取得 (#234-2、`useDeviceToken` の署名経路) が失敗したとき。
 * firmware が `ERR AUTH: no key` (CoreS3 に鍵が登録されていない) を返したときは、
 * 管理者が鍵を登録する場所を明示する。それ以外の理由 (タイムアウト / auth-worker の
 * HTTP エラー等) はそのまま添えるだけ — 現地の人が次の一手を選べるようにする
 */
export function autoClaimFailedMessage(reason: string): string {
  if (reason.includes('no key')) {
    return `CoreS3 の鍵が未登録です。管理者が auth.ippoan.org/device/setup で登録してください (${reason})`
  }
  return `CoreS3 経由の端末認証に失敗しました: ${reason}`
}
