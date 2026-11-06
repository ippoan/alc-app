import { describe, it, expect } from 'vitest'
import { nfcAliveState, NFC_ALIVE_STALE_MS } from '~/utils/nfc-alive'

describe('nfcAliveState (Refs ippoan/alc-app-s3#352)', () => {
  it('一度も来ていなければ判定しない (行を出さない古いファーム)', () => {
    expect(nfcAliveState(null, 1_000_000)).toBe('unknown')
  })

  it('閾値までは回っている、閾値からは止まった', () => {
    expect(nfcAliveState(1_000, 1_000 + NFC_ALIVE_STALE_MS - 1)).toBe('alive')
    expect(nfcAliveState(1_000, 1_000 + NFC_ALIVE_STALE_MS)).toBe('stale')
  })
})
