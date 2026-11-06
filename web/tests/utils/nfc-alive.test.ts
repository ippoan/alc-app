import { describe, it, expect } from 'vitest'
import { nfcAliveState, NFC_ALIVE_STALE_MS, NFC_INIT_NG_FRESH_MS } from '~/utils/nfc-alive'

describe('nfcAliveState (Refs ippoan/alc-app-s3#352)', () => {
  it('一度も来ていなければ判定しない (行を出さない古いファーム)', () => {
    expect(nfcAliveState(null, 1_000_000)).toBe('unknown')
  })

  it('閾値までは回っている、閾値からは止まった', () => {
    expect(nfcAliveState(1_000, 1_000 + NFC_ALIVE_STALE_MS - 1)).toBe('alive')
    expect(nfcAliveState(1_000, 1_000 + NFC_ALIVE_STALE_MS)).toBe('stale')
  })
  it('初期化の失敗が直近に来ていて、その後に生存が来ていなければ未検出', () => {
    expect(nfcAliveState(null, 1_000, 500)).toBe('missing')
    expect(nfcAliveState(400, 1_000, 500)).toBe('missing')
    // 見つかって回り始めた (生存の方が新しい)
    expect(nfcAliveState(600, 1_000, 500)).toBe('alive')
    // 初期化の失敗が古い (もう来ていない)
    expect(nfcAliveState(null, 500 + NFC_INIT_NG_FRESH_MS, 500)).toBe('unknown')
  })
})
