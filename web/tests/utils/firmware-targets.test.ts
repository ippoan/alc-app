import { describe, it, expect } from 'vitest'
import { FIRMWARE_TARGETS } from '~/utils/firmware-targets'

/** ファームの更新の対象の表 (Refs ippoan/alc-app#403)。URL はこの表にしか書かない */
describe('FIRMWARE_TARGETS', () => {
  const BASE = 'https://ippoan.github.io/alc-app-s3/'

  it('target は timecard-station と cores3 と alarm の 3 つ', () => {
    expect(Object.keys(FIRMWARE_TARGETS).sort()).toEqual(['alarm', 'cores3', 'timecard-station'])
  })

  it('timecard-station は flavor 1 件で、URL は今までと同じ 2 本 (BOARD は見ない)', () => {
    expect(FIRMWARE_TARGETS['timecard-station']).toEqual({
      installerUrl: BASE,
      flavors: {
        'timecard-station': {
          manifestUrl: `${BASE}manifest-timecard-station.json`,
          appUrl: `${BASE}firmware/alc-hub-atoms3-timecard-station-app.bin`,
        },
      },
    })
  })

  it('cores3 は flavor 3 件で、CoreS3 と CoreS3 SE の機体だけが対象', () => {
    expect(FIRMWARE_TARGETS.cores3).toEqual({
      boards: ['cores3', 'cores3se'],
      installerUrl: BASE,
      flavors: {
        'cores3': { manifestUrl: `${BASE}manifest.json`, appUrl: `${BASE}firmware/alc-hub-cores3-app.bin` },
        'cores3-wifi': { manifestUrl: `${BASE}manifest-wifi.json`, appUrl: `${BASE}firmware/alc-hub-cores3-wifi-app.bin` },
        'cores3-dev': { manifestUrl: `${BASE}manifest-dev.json`, appUrl: `${BASE}firmware/alc-hub-cores3-dev-app.bin` },
      },
    })
  })

  it('alarm (警告デバイス) は flavor 1 件で、書き直しのページは alarm.html (BOARD は見ない、Refs ippoan/alc-app#425)', () => {
    expect(FIRMWARE_TARGETS.alarm).toEqual({
      installerUrl: `${BASE}alarm.html`,
      flavors: {
        alarm: { manifestUrl: `${BASE}manifest-alarm.json`, appUrl: `${BASE}firmware/alc-hub-atoms3-alarm-app.bin` },
      },
    })
  })

  it('全 URL が配布ページで始まる', () => {
    const urls = Object.values(FIRMWARE_TARGETS)
      .flatMap(target => Object.values(target.flavors))
      .flatMap(image => [image.manifestUrl, image.appUrl])
    expect(urls).toHaveLength(10)
    for (const url of urls) expect(url.startsWith(BASE)).toBe(true)
    // 同じ URL を 2 つの flavor が指していない
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('書き直しのページ (installerUrl) も配布ページの中 (Refs ippoan/alc-app#425)', () => {
    for (const target of Object.values(FIRMWARE_TARGETS)) expect(target.installerUrl.startsWith(BASE)).toBe(true)
  })
})
