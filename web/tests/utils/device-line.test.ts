import { describe, it, expect } from 'vitest'
import { parseDeviceLine } from '~/utils/device-line'

// 端末の名乗りの行 (`DEVICE <kind> VER=… BOARD=… FLAVOR=…`) の parse (Refs ippoan/alc-app#403)。
// 欄は順序も有無も機種とファームの版で変わるので、欄ごとに拾う。
describe('parseDeviceLine', () => {
  it('CoreS3 の行から VER / BOARD / FLAVOR を取り出す', () => {
    expect(parseDeviceLine('DEVICE cores3 VER=0.1.0+b61b2ca BOARD=cores3 FLAVOR=cores3'))
      .toEqual({ ver: '0.1.0+b61b2ca', board: 'cores3', flavor: 'cores3' })
  })

  it('BOARD は cores3se も拾う (FLAVOR とは別の欄)', () => {
    expect(parseDeviceLine('DEVICE cores3 VER=0.1.0 BOARD=cores3se FLAVOR=cores3-wifi'))
      .toEqual({ ver: '0.1.0', board: 'cores3se', flavor: 'cores3-wifi' })
  })

  it('BOARD= の無い行は board が null', () => {
    expect(parseDeviceLine('DEVICE cores3 VER=0.1.0 FLAVOR=cores3'))
      .toEqual({ ver: '0.1.0', board: null, flavor: 'cores3' })
  })

  it('欄の順序が違っても拾う', () => {
    expect(parseDeviceLine('DEVICE cores3 FLAVOR=cores3-dev BOARD=cores3 VER=0.2.0'))
      .toEqual({ ver: '0.2.0', board: 'cores3', flavor: 'cores3-dev' })
  })

  // useSerialOta.test.ts に在った検査をここへ移した (関数ごと utils へ移したため)
  it('既存の打刻端末の行 (BOARD を持たない) は今までどおり', () => {
    expect(parseDeviceLine('DEVICE timecard VER=0.1.0+abc FLAVOR=timecard-station'))
      .toEqual({ ver: '0.1.0+abc', board: null, flavor: 'timecard-station' })
    expect(parseDeviceLine('DEVICE timecard VER=0.1.0')).toEqual({ ver: '0.1.0', board: null, flavor: null })
    expect(parseDeviceLine('DEVICE timecard XVER=1')).toEqual({ ver: null, board: null, flavor: null })
  })

  it('他のトークンの一部 (XBOARD= / XVER=) は拾わず、欄が 1 つも無ければ全部 null', () => {
    expect(parseDeviceLine('DEVICE cores3 XVER=1 XBOARD=cores3 XFLAVOR=cores3'))
      .toEqual({ ver: null, board: null, flavor: null })
    expect(parseDeviceLine('DEVICE cores3')).toEqual({ ver: null, board: null, flavor: null })
  })
})
