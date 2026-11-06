/**
 * 指静脈の個体値の計測 (端末ごとの癖) の計算 (Refs ippoan/alc-app-s3#352)。
 *
 * 同じ人が同じ端末で何度か置き、1 回ごとに「モジュールの判定」「サーバーの本人との判定 (点数・規則・位置のずれ)」
 * 「撮れ方の明るさ (`VEIN CAPLOG`)」を並べて、端末の平均と散らばりを出す。ロジックだけ (画面は
 * `components/VeinDeviceProfilePanel.vue`、手順は `composables/useVeinDeviceProfile.ts`)。生体データは扱わない
 */

/** `VEIN CAPLOG` の 1 行から読む撮れ方 (記録用 = 1 枚目、照合用 = 2 枚目) */
export interface VeinCapLog {
  /** 記録用の撮影の最後の明るさ (読めなければ null) */
  recordGray: number | null
  /** 照合用の撮影の最後の明るさ */
  matchGray: number | null
  /** 記録用・照合用それぞれの撮り直しを含めた撮影の回数 */
  recordTries: number
  matchTries: number
  /** 線が途切れた印 (`&&&lineW`) が出たか */
  lineW: boolean
}

/**
 * `VEIN CAPLOG …` を読む。ファーム (ippoan/alc-app-s3#362) は 2 回の撮影の記録を ` | ` でつないで出し、撮影ごとに
 * `XG_Create:` で終わる。`Gray:<n>` が撮り直しのたびに 1 つ出るので、各撮影の最後の値を使う。CAPLOG でない行は null
 */
export function parseVeinCapLog(line: string): VeinCapLog | null {
  const at = line.indexOf('VEIN CAPLOG')
  if (at < 0) return null
  const body = line.slice(at + 'VEIN CAPLOG'.length)
  const grays = (seg: string | undefined) => [...(seg ?? '').matchAll(/Gray:(\d+)/g)].map(m => Number(m[1]))
  const [rec, match] = body.split(/XG_Create:[^|]*/)
  const r = grays(rec)
  const m = grays(match)
  return {
    recordGray: r.at(-1) ?? null,
    matchGray: m.at(-1) ?? null,
    recordTries: r.length,
    matchTries: m.length,
    lineW: body.includes('lineW'),
  }
}

/** 1 回置いた結果 */
export interface VeinProfileShot {
  /** 何回目か (1 から) */
  n: number
  /** モジュールの判定: `self` = 本人の枠 / `other` = 別の人の枠 / `none` = 不一致 */
  module: 'self' | 'other' | 'none'
  /** サーバーの本人との判定 (`match` 等。送れなかった・撮れなかったら null) */
  server: string | null
  scores: [number, number, number] | null
  rule: string | null
  dx: number | null
  dy: number | null
  /** 重なり (千分率) */
  overlap: number | null
  cap: VeinCapLog | null
  /** 送信・読み取りの失敗 (無ければ null) */
  error: string | null
}

/** 平均と散らばり (標本が無ければ null) */
export interface VeinStat {
  n: number
  mean: number
  sd: number
}

function stat(xs: Array<number | null | undefined>): VeinStat | null {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  if (v.length === 0) return null
  const mean = v.reduce((a, b) => a + b, 0) / v.length
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length)
  return { n: v.length, mean, sd }
}

/** 端末の個体値 (計測した回をまとめたもの) */
export interface VeinDeviceProfile {
  shots: number
  moduleSelf: number
  serverMatch: number
  dx: VeinStat | null
  dy: VeinStat | null
  overlap: VeinStat | null
  s0: VeinStat | null
  s1: VeinStat | null
  s2: VeinStat | null
  recordGray: VeinStat | null
  matchGray: VeinStat | null
}

export function summarizeVeinProfile(shots: readonly VeinProfileShot[]): VeinDeviceProfile {
  return {
    shots: shots.length,
    moduleSelf: shots.filter(s => s.module === 'self').length,
    serverMatch: shots.filter(s => s.server === 'match').length,
    dx: stat(shots.map(s => s.dx)),
    dy: stat(shots.map(s => s.dy)),
    overlap: stat(shots.map(s => s.overlap)),
    s0: stat(shots.map(s => s.scores?.[0])),
    s1: stat(shots.map(s => s.scores?.[1])),
    s2: stat(shots.map(s => s.scores?.[2])),
    recordGray: stat(shots.map(s => s.cap?.recordGray)),
    matchGray: stat(shots.map(s => s.cap?.matchGray)),
  }
}

/** 表示用: `平均 ± 散らばり (件数)`。無ければ `—` */
export function formatVeinStat(s: VeinStat | null, digits = 1): string {
  if (!s) return '—'
  return `${s.mean.toFixed(digits)} ± ${s.sd.toFixed(digits)} (${s.n})`
}
