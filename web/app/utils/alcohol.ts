import type { AlcoholReading, TimePunchWithDevice } from '~/types'

/** アルコール測定 payload の解析結果 (形が違えば各フィールドは null)。 */
export interface AlcoholPayload {
  value: number | null
  result: string | null
  useCount: number | null
}

/**
 * アルコールの payload から値・判定・使用回数を取り出す (形が違えば null)。
 * CoreS3 は `{type:"alcohol",value:0.000,unit:"mg/L",result:"normal"|"over"|"error",use_count:N}`
 * を送る。`result:"error"` (吹込不良) のときの value は 0.000 固定で測定値ではない。
 *
 * HubMeasurementsViewer (DB の JSONB payload) と useBleGateway (受信直後の生 JSON) の
 * 両方が同じ CoreS3 の wire 形式を読むので、解釈をここに集約する (Refs ippoan/alc-app-s3#135)。
 */
export function readAlcohol(payload: unknown): AlcoholPayload | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as { value?: unknown, result?: unknown, use_count?: unknown }
  const value = typeof p.value === 'number' ? p.value : null
  const result = typeof p.result === 'string' ? p.result : null
  if (value === null && result === null) return null
  const useCount = typeof p.use_count === 'number' ? p.use_count : null
  return { value, result, useCount }
}

/**
 * `readAlcohol` の戻りから `AlcoholReading` を組む。CoreS3 の wire 形式の解釈を
 * ここに集約する方針 (このファイル冒頭の宣言) の延長。
 * 値の無い吹込不良は value 0、use_count 欠落は 0 に倒す。
 */
export function toAlcoholReading(raw: AlcoholPayload | null): AlcoholReading | null {
  if (!raw?.result) return null
  return {
    value: raw.value ?? 0,
    unit: 'mg/L',
    result: raw.result as 'normal' | 'over' | 'error',
    useCount: raw.useCount ?? 0,
    measuredAt: new Date(),
  }
}

/** アルコール判定の色調。表示名・バッジ色・カードの枠色はすべてこの 1 本から決める。 */
export type AlcoholTone = 'green' | 'yellow' | 'red'

/**
 * アルコール判定 (FC-1200 の result) と測定値から色調を決める判定の唯一の入口。
 * 正常 (normal) でも値が 0 より上なら赤 (検知)。サーバの検知メールの定義
 * (alc-measurements-worker の `should_alert` = 値 > 0) と揃える (Refs ippoan/alc-app#436)。
 * 吹込不良 (error) だけ黄に分けるのは、一覧で超過と見分けられるようにするため
 * (ユーザー判断)。超過 (over) と未知の値は赤。
 */
export function alcoholTone(result: string, value: number): AlcoholTone {
  if (result === 'normal') return value > 0 ? 'red' : 'green'
  if (result === 'error') return 'yellow'
  return 'red'
}

// Tailwind が拾えるよう、クラス名はリテラルで持つ (テンプレートで組み立てない)
const TONE_BADGE: Record<AlcoholTone, string> = {
  green: 'bg-green-100 text-green-800',
  yellow: 'bg-yellow-100 text-yellow-800',
  red: 'bg-red-100 text-red-800',
}

/** アルコール判定の表示名。未知の値はそのまま出す。normal でも値が 0 より上なら「検知」。 */
export function alcoholResultLabel(result: string, value: number): string {
  if (result === 'normal') return value > 0 ? '検知' : '正常'
  if (result === 'over') return '超過'
  if (result === 'error') return '測定エラー'
  return result
}

/** アルコール判定のバッジ色 (`bg-*-100 text-*-800`)。色調は `alcoholTone` で決める。 */
export function alcoholResultClass(result: string, value: number): string {
  return TONE_BADGE[alcoholTone(result, value)]
}

/** 打刻に結ばれた点呼の表示 (Refs ippoan/alc-app#436)。 */
export interface PunchTenko {
  /** 点呼が確定待ちか (結ばれた測定がまだ点呼として記録されていない) */
  pending: boolean
  /** アルコールの結果。測定がまだ結果を持たない (測定中・取り止め) ときは null */
  alcohol: { label: string, cls: string, value: string | null } | null
}

/**
 * 打刻一覧の行から、結ばれた点呼の表示を組む。**結ばれていない行は null** (今どおりの表示)。
 * 判定と色は `alcoholResultLabel` / `alcoholResultClass` をそのまま使う (0 より上は赤)。
 * 値は吹込不良 (error) では出さない — そのときの値は測定値ではないため (`readAlcohol` の doc)。
 */
export function punchTenkoOf(
  p: Pick<TimePunchWithDevice, 'measurement_id' | 'alcohol_level' | 'result' | 'tenko_recorded'>,
): PunchTenko | null {
  if (!p.measurement_id) return null
  const value = typeof p.alcohol_level === 'number' ? p.alcohol_level : null
  const alcohol = p.result
    ? {
        label: alcoholResultLabel(p.result, value ?? 0),
        cls: alcoholResultClass(p.result, value ?? 0),
        value: p.result !== 'error' && value !== null ? `${value.toFixed(3)} mg/L` : null,
      }
    : null
  // サーバが欄を返さない間 (null / 欠落) は確定待ちと言わない — 分からないものを待ちと見せない
  return { pending: p.tenko_recorded === false, alcohol }
}
