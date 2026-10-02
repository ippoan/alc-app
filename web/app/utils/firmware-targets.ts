/**
 * ファームの更新の対象の表 (Refs ippoan/alc-app-s3#279, ippoan/alc-app#403)。
 *
 * 合図 (購読 WS のメッセージ) が運ぶのは `target` の語だけで、取りに行く先はこの表から引く。
 * **URL はここにしか書かない。** 合図から URL や版を受け取ると、recorder を経由して任意の
 * イメージを焼かせる口になるため。
 *
 * 1 つの target に複数の flavor (同じ機種のビルド違い) が在る。どれを取りに行くかは、
 * 機体が `DEVICE` で名乗った `FLAVOR=` で引く — 名乗った flavor が表に無い機体は対象外。
 */

/** 1 つの flavor のイメージの置き場 */
export interface FirmwareImage {
  manifestUrl: string
  appUrl: string
}

/** 対象の端末 1 種の固定情報 */
export interface FirmwareTarget {
  /** `DEVICE` 応答の `FLAVOR=` (= `OTA SERIAL` に載せる語) → イメージ */
  flavors: Readonly<Record<string, FirmwareImage>>
  /** この `BOARD=` の機体だけが対象。無ければ BOARD を見ない */
  boards?: readonly string[]
  /** 配布ページの書き直しのページ (画面の更新が繰り返し失敗したときの案内先) */
  installerUrl: string
}

/** 配布ページ (alc-app-s3 の GitHub Pages) */
const PAGES_BASE = 'https://ippoan.github.io/alc-app-s3/'

function image(manifest: string, app: string): FirmwareImage {
  return { manifestUrl: `${PAGES_BASE}${manifest}`, appUrl: `${PAGES_BASE}firmware/${app}` }
}

/** 合図の `target` → 対象の allowlist。表に無い target は無視する */
export const FIRMWARE_TARGETS: Readonly<Record<string, FirmwareTarget>> = {
  // Vein Station (タイムカード端末)
  'timecard-station': {
    // station ビルド専用の書き直しのページは無いので、配布ページの入口を指す
    installerUrl: PAGES_BASE,
    flavors: {
      'timecard-station': image('manifest-timecard-station.json', 'alc-hub-atoms3-timecard-station-app.bin'),
    },
  },
  // CoreS3 (統合ハブ)。CoreS3 SE も同じイメージで更新する
  'cores3': {
    boards: ['cores3', 'cores3se'],
    // CoreS3 の書き直しのページは配布ページの入口 (index.html)
    installerUrl: PAGES_BASE,
    flavors: {
      'cores3': image('manifest.json', 'alc-hub-cores3-app.bin'),
      'cores3-wifi': image('manifest-wifi.json', 'alc-hub-cores3-wifi-app.bin'),
      'cores3-dev': image('manifest-dev.json', 'alc-hub-cores3-dev-app.bin'),
    },
  },
  // 警告デバイス (Atom VoiceS3R、運行管理者の席の見張り)。名乗りに BOARD が無いので boards は置かない
  'alarm': {
    installerUrl: `${PAGES_BASE}alarm.html`,
    flavors: {
      alarm: image('manifest-alarm.json', 'alc-hub-atoms3-alarm-app.bin'),
    },
  },
}
