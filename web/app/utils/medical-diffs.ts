import type { MedicalDiffs } from '~/types'

/** 通常の値 (基準値) との差の 1 行 (画面の表示用) */
export interface MedicalDiffRow {
  label: string
  text: string
}

/** 符号付きの数 (0 は符号なし) */
function signed(n: number, digits: number): string {
  const v = n.toFixed(digits)
  return n > 0 ? `+${v}` : v
}

/**
 * 安全判定の `medical_diffs` を、体温・最高血圧・最低血圧の順の表示行にする (業務前 二十三 ヌ)。
 * 測っていない・基準値が無い項目 (null) は出さない。判定が無ければ空
 */
export function medicalDiffRows(diffs: MedicalDiffs | null | undefined): MedicalDiffRow[] {
  if (!diffs) return []
  const rows: MedicalDiffRow[] = []
  if (diffs.temperature_diff != null) rows.push({ label: '体温の差', text: `${signed(diffs.temperature_diff, 1)} ℃` })
  if (diffs.systolic_diff != null) rows.push({ label: '最高血圧の差', text: `${signed(diffs.systolic_diff, 0)} mmHg` })
  if (diffs.diastolic_diff != null) rows.push({ label: '最低血圧の差', text: `${signed(diffs.diastolic_diff, 0)} mmHg` })
  return rows
}
