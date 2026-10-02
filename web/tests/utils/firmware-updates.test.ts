import { describe, it, expect, vi, afterEach } from 'vitest'
import type { FirmwareDevice } from '~/utils/api'
import { fetchLatestFirmwareVersions, hasFirmwareUpdate, isFirmwareDifferent } from '~/utils/firmware-updates'

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

describe('isFirmwareDifferent (素の値で受ける判定。式はここ 1 か所)', () => {
  const latest = { cores3: '1.2.0' }

  it('版が違えば真 (大小は比べない)・同じなら偽', () => {
    expect(isFirmwareDifferent('1.0.0', 'cores3', latest)).toBe(true)
    expect(isFirmwareDifferent('9.0.0', 'cores3', latest)).toBe(true)
    expect(isFirmwareDifferent('1.2.0', 'cores3', latest)).toBe(false)
  })

  it('版・flavor が取れていない (null / undefined)・配布中の版が取れていない flavor は偽', () => {
    expect(isFirmwareDifferent(null, 'cores3', latest)).toBe(false)
    expect(isFirmwareDifferent(undefined, 'cores3', latest)).toBe(false)
    expect(isFirmwareDifferent('1.0.0', null, latest)).toBe(false)
    expect(isFirmwareDifferent('1.0.0', undefined, latest)).toBe(false)
    expect(isFirmwareDifferent('1.0.0', 'cores3-wifi', latest)).toBe(false)
    expect(isFirmwareDifferent('1.0.0', 'cores3', {})).toBe(false)
  })
})

describe('fetchLatestFirmwareVersions', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('対象を渡すと、その対象の flavor の manifest だけを取りに行く', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ version: '0.3.0' }) }))
    vi.stubGlobal('fetch', f)
    expect(await fetchLatestFirmwareVersions('timecard-station')).toEqual({ 'timecard-station': '0.3.0' })
    expect(f.mock.calls.map(c => (c as unknown[])[0])).toEqual(['https://ippoan.github.io/alc-app-s3/manifest-timecard-station.json'])
  })

  it('警告デバイス (alarm) は表に在る: flavor 1 件の manifest だけを取りに行く (Refs ippoan/alc-app#425)', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ version: '0.1.0' }) }))
    vi.stubGlobal('fetch', f)
    expect(await fetchLatestFirmwareVersions('alarm')).toEqual({ alarm: '0.1.0' })
    expect(f.mock.calls.map(c => (c as unknown[])[0])).toEqual(['https://ippoan.github.io/alc-app-s3/manifest-alarm.json'])
  })

  it('表に無い対象は空の結果 (どこにも取りに行かない)', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    for (const target of ['vein', 'https://evil.example/manifest.json', '__proto__', 'toString', '']) {
      expect(await fetchLatestFirmwareVersions(target)).toEqual({})
    }
    expect(f).not.toHaveBeenCalled()
  })

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
