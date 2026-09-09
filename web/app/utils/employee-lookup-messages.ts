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
