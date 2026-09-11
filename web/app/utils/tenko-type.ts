/** 点呼種別の表示名を 1 か所にまとめる (Refs #238) */
export function tenkoTypeLabel(t: string | null | undefined): string {
  if (t === 'pre_operation') return '業務前'
  if (t === 'post_operation') return '業務後'
  if (t === 'normal') return '通常'
  return '—'
}
