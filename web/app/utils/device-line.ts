/**
 * 端末の名乗りの行 (`DEVICE <kind> VER=… BOARD=… FLAVOR=…`) の parse。
 *
 * 全機種が同じ形で名乗る (alc-app-s3 の `hub-drivers/src/console.rs` の `handle_common`)。
 * 欄は `key=value` を空白で並べたもので、順序も有無も機種とファームの版で変わる
 * (`BOARD=` は CoreS3 だけが出す) ので、欄ごとに拾う。
 */

/** 名乗りの行から拾った欄。行に無い欄は null */
export interface DeviceLine {
  ver: string | null
  board: string | null
  flavor: string | null
}

/** `DEVICE cores3 VER=… BOARD=… FLAVOR=…` から VER / BOARD / FLAVOR を取り出す (無ければ null) */
export function parseDeviceLine(line: string): DeviceLine {
  const field = (key: string): string | null => {
    const m = line.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`))
    return m ? m[1]! : null
  }
  return { ver: field('VER'), board: field('BOARD'), flavor: field('FLAVOR') }
}

/**
 * プローブ中に集まった行から機体の名乗りを拾う。`DEVICE ` は行頭とは限らない (直前のログ行が
 * 途中で切れて連結されうる。arbiter の機種判定と同じ見方) ので、見つけた位置から後ろを読む
 */
export function findDeviceLine(lines: string[]): DeviceLine | null {
  const line = lines.find(l => l.includes('DEVICE '))
  return line === undefined ? null : parseDeviceLine(line.slice(line.indexOf('DEVICE ')))
}

/**
 * 機体のうち、**自分で打刻をサーバーへ送る**ものの FLAVOR (Refs ippoan/alc-app#436)。
 * LAN を持つ打刻端末 (alc-app-s3 `crates/atoms3-timecard` の既定ビルド)。
 * Vein Station 版 (`timecard-station` / `timecard-vein` / `timecard-vein-gps`) は LAN が無く、読んだカードを
 * USB に流すだけで送らない
 */
const SELF_PUNCHING_TIMECARD_FLAVOR = 'timecard'

/**
 * USB でつないだ機体が、読んだカードの打刻を**自分で**サーバーへ送るか (Refs ippoan/alc-app#436)。
 * false なら画面が打刻を書く。免許証 (`NormalMeasurement` の `onNfcRead`) と IC カード
 * (`useHubTimecardPunch`) の両方がこれで決める — 判定はここ 1 か所。
 *
 * | 機体 | 送るか |
 * |---|---|
 * | CoreS3 | 送る |
 * | Vein Station で FLAVOR=timecard (LAN 版) | 送る |
 * | Vein Station のそれ以外 (timecard-station・timecard-vein・timecard-vein-gps・不明) | 送らない |
 * | 血圧測定台・NFC ブリッジ・不明 | 送らない |
 *
 * **分からないときは「送らない」(= 画面が書く)。** 消えた打刻は後から作れないが、重複は消せる。
 * `flavor` は Vein Station の名乗りの FLAVOR (他の機体では見ない)。
 * 機体の LAN が無くなれば、ここを「常に false」にするだけで打刻は全部画面が書く形になる。
 */
export function deviceSendsPunch(kind: string | undefined, flavor: string | null | undefined): boolean {
  if (kind === 'cores3') return true
  return kind === 'vein-station' && flavor === SELF_PUNCHING_TIMECARD_FLAVOR
}
