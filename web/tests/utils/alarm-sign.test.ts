import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

/**
 * alarm-sign.ts (旧 useDeviceLogin.ts の signAlarmDeviceNonce/parseAuthSigLine、#353-8 で移設) のテスト。
 *
 * useAlarmDevice (既定の送り先) は mock する — 警告デバイスの接続そのものは
 * useAlarmDevice.test.ts が担保済みで、ここでは「AUTH SIGN → AUTH SIG の parse」だけを見る。
 */

const alarmDeviceMock = vi.hoisted(() => ({
  request: vi.fn(),
}))
mockNuxtImport('useAlarmDevice', () => () => alarmDeviceMock)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('signAlarmDeviceNonce (#231 useDeviceToken / #337 useManagerDeviceToken と共有する切り出し関数)', () => {
  it('AUTH SIGN <nonce> を送り、AUTH SIG <pubkey> <sig> を parse して返す', async () => {
    alarmDeviceMock.request.mockResolvedValue('AUTH SIG pub-9 sig-9')
    const { signAlarmDeviceNonce } = await import('~/utils/alarm-sign')

    await expect(signAlarmDeviceNonce('nonce-xyz')).resolves.toEqual({ pubkey: 'pub-9', sig: 'sig-9' })
    expect(alarmDeviceMock.request).toHaveBeenCalledWith('AUTH SIGN nonce-xyz', 'AUTH SIG ', 10_000)
  })

  it('parse できない応答は null (reject しない)', async () => {
    alarmDeviceMock.request.mockResolvedValue('garbled')
    const { signAlarmDeviceNonce } = await import('~/utils/alarm-sign')

    await expect(signAlarmDeviceNonce('nonce-xyz')).resolves.toBeNull()
  })

  it('firmware の `ERR AUTH: ...` はタイムアウトを待たず即 reject し、そのまま伝播する', async () => {
    alarmDeviceMock.request.mockRejectedValue(new Error('ERR AUTH: no key'))
    const { signAlarmDeviceNonce } = await import('~/utils/alarm-sign')

    // フェイクタイマーを使わず (= 10 秒のタイムアウトを一切待たず) 即座に reject する
    await expect(signAlarmDeviceNonce('nonce-xyz')).rejects.toThrow('ERR AUTH: no key')
  })

  it('request を明示指定すればそちら宛てに送る (#234-2、useDeviceToken.ts が CoreS3 の request を渡す想定)', async () => {
    const customRequest = vi.fn().mockResolvedValue('AUTH SIG pub-7 sig-7')
    const { signAlarmDeviceNonce } = await import('~/utils/alarm-sign')

    await expect(signAlarmDeviceNonce('nonce-xyz', customRequest)).resolves.toEqual({ pubkey: 'pub-7', sig: 'sig-7' })
    expect(customRequest).toHaveBeenCalledWith('AUTH SIGN nonce-xyz', 'AUTH SIG ', 10_000)
    // 警告デバイス (既定値) には送らない
    expect(alarmDeviceMock.request).not.toHaveBeenCalled()
  })
})

describe('parseAuthSigLine', () => {
  it('`AUTH SIG <pubkey> <sig>` を空白で分割して返す', async () => {
    const { parseAuthSigLine } = await import('~/utils/alarm-sign')

    expect(parseAuthSigLine('AUTH SIG pub-1 sig-1')).toEqual({ pubkey: 'pub-1', sig: 'sig-1' })
  })

  it('形式が合わなければ null', async () => {
    const { parseAuthSigLine } = await import('~/utils/alarm-sign')

    expect(parseAuthSigLine('garbled')).toBeNull()
    expect(parseAuthSigLine('AUTH SIGBP pub-1 sig-1 BP=0')).toBeNull()
    expect(parseAuthSigLine('AUTH SIG pub-1')).toBeNull()
  })
})
