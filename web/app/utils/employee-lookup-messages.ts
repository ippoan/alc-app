/** 乗務員照会が失敗したときの文言 (理由 + 次の操作) を 1 か所にまとめる */

/** NFC (免許証) で引けなかったとき */
export function employeeNotFoundByNfc(nfcId: string): string {
  return `この免許証は乗務員に登録されていません (NFC ID: ${nfcId})。管理者画面の「免許証」で読み取り → 保存してください`
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
 * 端末がペアリングされていない (device JWT が無い) とき。
 * 打刻の失敗表示 (TimePunchKiosk) と運行者タブの入口バナーで同じ文言を使う (Refs #206)
 */
export const deviceUnregisteredMessage = 'この端末は登録されていません (ペアリングが必要です)'

/**
 * CoreS3 経由の自動端末登録 (#213) が失敗したとき。理由 (AUTH TICKET の ERR / タイムアウト /
 * auth-worker の HTTP エラー) を添えて、現地の人が次の一手 (管理者に連絡する等) を選べるように
 * する。文言だけを出す — 端末登録は依然として管理者の Google ログイン (device-claim) で可能
 */
export function autoClaimFailedMessage(reason: string): string {
  return `CoreS3 経由の端末登録に失敗しました: ${reason}`
}
