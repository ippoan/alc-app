/**
 * 免許証 IC チップ EF 2F01 (17 バイト) の有効期限パーサー
 *
 * EF 2F01 構造:
 *   Byte 0:    Tag (0x45)
 *   Byte 1:    Length (0x0B)
 *   Bytes 2-4: 仕様バージョン (JIS X 0201)
 *   Bytes 5-8: 交付年月日 (BCD YYYYMMDD)
 *   Bytes 9-12: 有効期限 (BCD YYYYMMDD) ← ターゲット
 *   Bytes 13-16: Tag 46 + データ
 *
 * Hex 文字列 (34 文字) の 18-25 文字目が有効期限
 * BCD の hex 表現がそのまま YYYYMMDD になる
 */

export type LicenseExpiryStatus = 'valid' | 'expiring_soon' | 'expired'

/** hex 文字列から交付年月日を抽出して Date に変換 (chars 10-17) */
export function parseLicenseIssueDate(hexString: string): Date | null {
  if (!hexString || hexString.length < 18) return null

  const dateStr = hexString.substring(10, 18)
  const year = parseInt(dateStr.substring(0, 4), 10)
  const month = parseInt(dateStr.substring(4, 6), 10)
  const day = parseInt(dateStr.substring(6, 8), 10)

  if (isNaN(year) || isNaN(month) || isNaN(day)) return null
  if (year < 1950 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null

  return new Date(year, month - 1, day)
}

/** hex 文字列から有効期限を抽出して Date に変換 */
export function parseLicenseExpiryDate(hexString: string): Date | null {
  if (!hexString || hexString.length < 26) return null

  const dateStr = hexString.substring(18, 26)
  const year = parseInt(dateStr.substring(0, 4), 10)
  const month = parseInt(dateStr.substring(4, 6), 10)
  const day = parseInt(dateStr.substring(6, 8), 10)

  if (isNaN(year) || isNaN(month) || isNaN(day)) return null
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null

  return new Date(year, month - 1, day)
}

/** 有効期限のステータスを判定 (30日以内 = expiring_soon) */
export function checkLicenseExpiry(expiryDate: Date, warningDays: number = 30): LicenseExpiryStatus {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  if (expiryDate < today) return 'expired'

  const warningDate = new Date(today)
  warningDate.setDate(warningDate.getDate() + warningDays)
  if (expiryDate <= warningDate) return 'expiring_soon'

  return 'valid'
}

/** Date を YYYY/MM/DD 形式にフォーマット */
export function formatExpiryDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}/${m}/${d}`
}

/** Date を YYYY-MM-DD 形式にフォーマット (input[type=date] 用) */
export function formatDateForInput(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** "YYYY-MM-DD" 文字列から有効期限ステータスを判定 */
export function checkLicenseExpiryFromString(dateStr: string, warningDays: number = 30): LicenseExpiryStatus {
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return 'expired'
  return checkLicenseExpiry(new Date(y, m - 1, d), warningDays)
}

/**
 * 期限ステータス → 色調・短い名札の対応 (免許証・車検で共有)。
 *
 * 免許証 3 か所 (LicenseRegistration.vue の一覧 pill / NfcStatus.vue の文 / NormalMeasurement.vue
 * の帯) と車検 2 か所 (NormalMeasurement.vue の vehicle 段の帯 / TenkoSessionMonitor.vue の
 * 一覧 pill) は見た目 (pill / 文 / 帯) が違うが、状態 → 色調の対応は同じなのでここに寄せる
 * (ユーザーの判断、Refs ippoan/alc-app-s3#110)。見た目ごとの文言・クラスは各画面に残し、
 * 状態 → tone だけをここで決める
 */
export interface ExpiryTone {
  tone: 'red' | 'yellow' | 'green' | 'gray'
  label: string
}

export function expiryTone(status: LicenseExpiryStatus | null): ExpiryTone {
  switch (status) {
    case 'expired': return { tone: 'red', label: '期限切れ' }
    case 'expiring_soon': return { tone: 'yellow', label: '期限間近' }
    case 'valid': return { tone: 'green', label: '有効' }
    default: return { tone: 'gray', label: '未登録' }
  }
}

/** tone → 見た目ごとの Tailwind クラス (各画面のクラスはこの表から選ぶだけにする) */
export const EXPIRY_TONE_CLASS: Record<'pill' | 'text' | 'banner', Record<ExpiryTone['tone'], string>> = {
  pill: {
    red: 'bg-red-100 text-red-800',
    yellow: 'bg-amber-100 text-amber-800',
    green: 'bg-green-100 text-green-800',
    gray: 'bg-gray-100 text-gray-500',
  },
  text: {
    red: 'bg-red-100 text-red-700 rounded-lg',
    yellow: 'bg-amber-100 text-amber-700 rounded-lg',
    green: 'bg-green-100 text-green-700 rounded-lg',
    gray: 'bg-gray-100 text-gray-700 rounded-lg',
  },
  banner: {
    red: 'bg-red-50 border-red-200 text-red-700',
    yellow: 'bg-amber-50 border-amber-200 text-amber-700',
    green: 'bg-green-50 border-green-200 text-green-700',
    gray: 'bg-gray-50 border-gray-200 text-gray-700',
  },
}

/**
 * "YYYY-MM-DD" の有効期限まで**あと何日**かを返す (過ぎていれば負、読めなければ null)。
 *
 * 帯に「あと N 日」「N 日前」を出すための純関数 (Refs ippoan/alc-app-s3#135)。
 * - **ローカル時刻の 0 時どうしの差**で数える (`checkLicenseExpiry` と同じ基準)。
 *   時刻を持ち込まないので切り上げ / 切り捨ての選択自体が発生せず、色 (status) と
 *   日数が食い違わない。DST で 1 日が 23/25 時間になる地域向けに `Math.round` で丸める
 * - **満了日当日は 0** =「あと 0 日」。車検は満了日当日まで有効なので「本日まで」ではなく
 *   0 日として残す (`checkLicenseExpiry` も当日を expired にしない)
 */
export function daysUntilExpiry(expiresOn: string | null | undefined, today: Date = new Date()): number | null {
  if (!expiresOn) return null
  const [y, m, d] = expiresOn.split('-').map(Number)
  if (!y || !m || !d) return null

  const expiry = new Date(y, m - 1, d)
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((expiry.getTime() - base.getTime()) / 86_400_000)
}
