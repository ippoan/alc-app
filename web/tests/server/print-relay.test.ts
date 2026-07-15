import { describe, it, expect } from 'vitest'
import {
  buildIntrospectForward,
  buildPrintCommands,
  buildRecorderCommandForward,
  buildRecorderDevicesForward,
  splitBase64,
  PRINT_CHUNK_B64_CHARS,
} from '../../server/utils/print-relay'

const SECRET = 'test-internal-shared-secret-32!!'

describe('splitBase64 (operator 印刷 #38、base64 を 4 文字境界で分割)', () => {
  it('chunkChars を 4 の倍数に丸めて分割し、各片の長さは 4 の倍数', () => {
    const chunks = splitBase64('AAAABBBBCCCC', 8)
    expect(chunks).toEqual(['AAAABBBB', 'CCCC'])
    for (const c of chunks) expect(c.length % 4).toBe(0)
  })

  it('chunkChars が 4 未満でも最小 4 に丸める', () => {
    expect(splitBase64('AAAABBBB', 2)).toEqual(['AAAA', 'BBBB'])
  })

  it('chunkChars を 4 の倍数へ切り捨てる (6 → 4)', () => {
    expect(splitBase64('AAAABBBB', 6)).toEqual(['AAAA', 'BBBB'])
  })

  it('空文字列は空配列', () => {
    expect(splitBase64('')).toEqual([])
  })

  it('既定 chunk サイズは 4 の倍数', () => {
    expect(PRINT_CHUNK_B64_CHARS % 4).toBe(0)
  })
})

describe('buildPrintCommands', () => {
  it('print_begin → print_data(seq,chunk)* → print_end を組む', () => {
    expect(buildPrintCommands(['x', 'y'])).toEqual([
      { action: 'print_begin' },
      { action: 'print_data', seq: 0, chunk: 'x' },
      { action: 'print_data', seq: 1, chunk: 'y' },
      { action: 'print_end' },
    ])
  })

  it('チャンク 0 件でも begin/end は出す', () => {
    expect(buildPrintCommands([])).toEqual([{ action: 'print_begin' }, { action: 'print_end' }])
  })
})

describe('buildRecorderCommandForward', () => {
  it('tenants/:t/devices/:d/command に POST、secret を Authorization に載せる', () => {
    const { url, init } = buildRecorderCommandForward({
      sharedSecret: SECRET,
      tenantId: 'tenant-1',
      deviceId: 'dev-9',
      payload: { action: 'print_data', seq: 3, chunk: 'SGk=' },
    })
    expect(url).toBe('https://alc-recorder.internal/tenants/tenant-1/devices/dev-9/command')
    const h = init.headers as Record<string, string>
    expect(h.Authorization).toBe(SECRET)
    expect(h['Content-Type']).toBe('application/json')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ payload: { action: 'print_data', seq: 3, chunk: 'SGk=' } }))
  })

  it('tenantId / deviceId を URL エンコードする', () => {
    const { url } = buildRecorderCommandForward({
      sharedSecret: SECRET,
      tenantId: 'a/b',
      deviceId: 'x y',
      payload: { action: 'print_begin' },
    })
    expect(url).toBe('https://alc-recorder.internal/tenants/a%2Fb/devices/x%20y/command')
  })
})

describe('buildRecorderDevicesForward', () => {
  it('tenants/:t/devices に GET、secret を Authorization に載せる', () => {
    const { url, init } = buildRecorderDevicesForward({ sharedSecret: SECRET, tenantId: 'tenant-1' })
    expect(url).toBe('https://alc-recorder.internal/tenants/tenant-1/devices')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>).Authorization).toBe(SECRET)
  })
})

describe('buildIntrospectForward', () => {
  it('auth-worker /auth/introspect に POST、token/origin を body に載せる', () => {
    const { url, init } = buildIntrospectForward({ sharedSecret: SECRET, token: 'jwt.abc', origin: 'https://alc.ippoan.org' })
    expect(url).toBe('https://auth-worker.internal/auth/introspect')
    const h = init.headers as Record<string, string>
    expect(h.Authorization).toBe(SECRET)
    expect(init.body).toBe(JSON.stringify({ token: 'jwt.abc', origin: 'https://alc.ippoan.org' }))
  })
})
