/**
 * 端末の id の短縮形 (Refs ippoan/alc-app-s3#352)。先頭 12 文字、長ければ末尾に「…」。
 * 「端末のファーム」一覧 (`FirmwareManager`) と右下の版の表示 (`useBadgeDeviceName`) で同じ形にする
 */
const SHORT_ID_LEN = 12

export function shortDeviceId(id: string): string {
  return id.length > SHORT_ID_LEN ? `${id.slice(0, SHORT_ID_LEN)}…` : id
}
