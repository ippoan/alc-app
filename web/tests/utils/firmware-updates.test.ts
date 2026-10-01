import { describe, it, expect, vi, afterEach } from 'vitest'
import type { FirmwareDevice } from '~/utils/api'
import { fetchLatestFirmwareVersions, hasFirmwareUpdate } from '~/utils/firmware-updates'

const dev = (over: Partial<FirmwareDevice> = {}): FirmwareDevice => ({
  device_id: 'devaaaaa-bbbb',
  label: null,
  kind: 'cores3',
  flavor: 'cores3',
  version: '1.0.0',
  phase: 'idle',
  reported_at_ms: 0,
  ...over,
})

describe('hasFirmwareUpdate', () => {
  const latest = { cores3: '1.2.0' }

  it('version が違えば真 (大小は比べない)', () => {
    expect(hasFirmwareUpdate(dev(), latest)).toBe(true)
    expect(hasFirmwareUpdate(dev({ version: '9.0.0' }), latest)).toBe(true)
  })

  it('同じなら偽', () => {
    expect(hasFirmwareUpdate(dev({ version: '1.2.0' }), latest)).toBe(false)
  })

  it('version 無し / flavor 無し / 最新が取れていない flavor は偽', () => {
    expect(hasFirmwareUpdate(dev({ version: undefined }), latest)).toBe(false)
    expect(hasFirmwareUpdate(dev({ flavor: undefined }), latest)).toBe(false)
    expect(hasFirmwareUpdate(dev({ flavor: 'cores3-dev' }), latest)).toBe(false)
    expect(hasFirmwareUpdate(dev(), {})).toBe(false)
  })

  it('応答なし・更新中などの状態は見ない', () => {
    expect(hasFirmwareUpdate(dev({ phase: 'writing', reported_at_ms: 1 }), latest)).toBe(true)
  })
})

describe('fetchLatestFirmwareVersions', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('3 本取れる (cache: no-store)', async () => {
    const f = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ version: url.endsWith('/manifest.json') ? '1.0.0' : url.endsWith('/manifest-wifi.json') ? '1.1.0' : '1.2.0' }),
    }))
    vi.stubGlobal('fetch', f)
    expect(await fetchLatestFirmwareVersions()).toEqual({ 'cores3': '1.0.0', 'cores3-wifi': '1.1.0', 'cores3-dev': '1.2.0' })
    expect(f).toHaveBeenCalledTimes(3)
    expect(f.mock.calls.every(c => (c[1] as RequestInit).cache === 'no-store')).toBe(true)
  })

  it('非 200 / 例外 / version が文字列でない flavor は key ごと無い', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({ version: '1.0.0' }) })
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ version: 3 }) }))
    expect(await fetchLatestFirmwareVersions()).toEqual({})
  })

  it('1 本だけ取れれば、その flavor だけ入る', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ version: '1.0.0' }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockRejectedValueOnce(new Error('x')))
    expect(await fetchLatestFirmwareVersions()).toEqual({ cores3: '1.0.0' })
  })
})
