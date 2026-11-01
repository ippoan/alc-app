import { isClient } from '~/utils/env'

/**
 * 指静脈モジュールの照合の厳しさ (安全レベル) の端末設定 (Refs ippoan/alc-app-s3#352)。端末ごとに
 * localStorage へ持つ (デバイス設定で切り替える)。
 *
 * - `'keep'` (既定) … モジュールの値を変えない (読んでログに残すだけ)
 * - `0`〜`2` … つながったときにモジュールがその値でなければ書く (`VEIN SECURITY <n>`、ファームは
 *   ippoan/alc-app-s3 の `VEIN SECURITY`)。0 が最も緩く、2 が最も厳しい。工場の既定は 1
 *
 * モジュールは照合ごとに `th[s0, s1, s2]` (レベル 0〜2 の閾値) を出し、合否は今のレベルの値で決まる。
 * 1 だと点数 80 が閾値 85 で落ちた回があった。
 */
export type VeinSecurityLevel = 0 | 1 | 2
export type VeinSecuritySetting = 'keep' | VeinSecurityLevel

const STORAGE_KEY = 'alc-vein-security-level'

/** 文字列 (select の値・保存した値) を設定に。読めなければ `'keep'` */
export function parseVeinSecuritySetting(v: string | null | undefined): VeinSecuritySetting {
  return v === '0' || v === '1' || v === '2' ? (Number(v) as VeinSecurityLevel) : 'keep'
}

/** 保存された値。未設定・壊れた値・localStorage が使えない環境は既定の `'keep'` */
export function readVeinSecuritySetting(): VeinSecuritySetting {
  if (!isClient) return 'keep'
  try {
    return parseVeinSecuritySetting(localStorage.getItem(STORAGE_KEY))
  }
  catch {
    return 'keep'
  }
}

/** 保存する。保存できない環境でも例外にしない */
export function writeVeinSecuritySetting(v: VeinSecuritySetting): void {
  if (!isClient) return
  try {
    localStorage.setItem(STORAGE_KEY, String(v))
  }
  catch {
    // 保存できなくても続ける
  }
}
