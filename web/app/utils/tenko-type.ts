/** 点呼種別の表示名を 1 か所にまとめる (Refs #238) */
export function tenkoTypeLabel(t: string | null | undefined): string {
  if (t === 'pre_operation') return '業務前'
  if (t === 'post_operation') return '業務後'
  if (t === 'normal') return '通常'
  return '—'
}

/**
 * 点呼の区分 (対面・IT・遠隔・自動) の表示名。backend の CSV (`csv_tenko_method`) と同じ読み替えで、
 * IT点呼 を運行管理者が対面で確認して確定した回は「対面点呼」と出す。値が無ければ '—'
 */
export function tenkoMethodLabel(
  method: string | null | undefined,
  judgmentMethod?: string | null,
): string {
  if (!method) return '—'
  if (method === 'IT点呼' && judgmentMethod === 'in_person') return '対面点呼'
  return method
}
