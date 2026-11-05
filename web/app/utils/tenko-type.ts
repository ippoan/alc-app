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

/** 対面で受ける点呼の `tenko_method` (通常点呼 / 対面点呼。サーバの値の揺れを両方受ける) */
const IN_PERSON_TENKO_METHODS: readonly string[] = ['通常点呼', '対面点呼']
/** 血圧の記録不足で対面点呼にした理由の頭 (サーバが `remote_escalation_reason` に入れる) */
const BP_IN_PERSON_REASON_PREFIX = '血圧の記録が 10 日分'

/** 対面の `tenko_method` か */
export function isInPersonTenkoMethod(method: string | null | undefined): boolean {
  return !!method && IN_PERSON_TENKO_METHODS.includes(method)
}

/**
 * 自動点呼を、血圧の記録が 10 日分に満たないため対面点呼へ切り替えたセッションか。
 * 予定から始めた業務前で、方法が対面、理由が血圧の記録不足のものだけ。
 * 最後に運行管理者に会って確認を受け、判定で閉じる
 */
export function isBpInPersonSession(s: {
  schedule_id?: string | null
  tenko_type?: string
  tenko_method?: string | null
  remote_escalation_reason?: string | null
}): boolean {
  return !!s.schedule_id
    && s.tenko_type === 'pre_operation'
    && isInPersonTenkoMethod(s.tenko_method)
    && (s.remote_escalation_reason ?? '').startsWith(BP_IN_PERSON_REASON_PREFIX)
}
