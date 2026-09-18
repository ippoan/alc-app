import type { TenkoSessionStatus } from '~/types'

/**
 * 点呼セッション status の表示名を 1 か所にまとめる (Refs ippoan/alc-app#343)。
 *
 * `TenkoRemoteAdminView.vue` と `TenkoSessionMonitor.vue` が**同じ表を 2 つ**持っていて、
 * キオスクの「続きから再開」で 3 つ目になるところだったので寄せた
 * (`tenko-type.ts` の `tenkoTypeLabel` と同じ流儀)。
 *
 * `carrying_items_pending` は 2 つの表のどちらにも無く、生の英字が出ていたのでここで足した。
 */
const TENKO_STATUS_LABELS: Record<TenkoSessionStatus, string> = {
  identity_verified: '本人確認済',
  alcohol_testing: 'アルコール検査中',
  medical_pending: '医療測定待ち',
  self_declaration_pending: '自己申告待ち',
  safety_judgment_pending: '安全判定中',
  daily_inspection_pending: '日常点検待ち',
  carrying_items_pending: '携行品確認待ち',
  instruction_pending: '指示確認待ち',
  report_pending: '報告待ち',
  interrupted: '中断',
  completed: '完了',
  cancelled: 'キャンセル',
}

/** 知らない値は生のまま返す (従来の `map[s] || s` と同じ) */
export function tenkoStatusLabel(s: string): string {
  return TENKO_STATUS_LABELS[s as TenkoSessionStatus] || s
}
