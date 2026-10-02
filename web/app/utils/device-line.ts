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
