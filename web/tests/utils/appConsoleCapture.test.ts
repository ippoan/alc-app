import { describe, it, expect, vi, beforeEach } from 'vitest'

// 画面のコンソールの診断の行を送り待ちへ写す (Refs ippoan/alc-app#558)
const appendAppLog = vi.hoisted(() => vi.fn())
vi.mock('~/utils/serialDiagLog', () => ({ appendAppLog }))

const { APP_LOG_TAGS, appLogLine, installAppConsoleCapture } = await import('~/utils/appConsoleCapture')

function fakeConsole() {
  return { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('appConsoleCapture', () => {
  beforeEach(() => appendAppLog.mockReset())

  it('タグで始まる行だけを写し、段の名前を頭に付ける', () => {
    for (const tag of APP_LOG_TAGS) expect(appLogLine('warn', [`${tag} x`])).toBe(`warn ${tag} x`)
    expect(appLogLine('log', ['[FaceSync] x'])).toBeNull()
    expect(appLogLine('log', [{ a: 1 }])).toBeNull()
    expect(appLogLine('log', [])).toBeNull()
  })

  it('Error は名前と文言だけ、オブジェクトは JSON (200 文字まで)、UUID は伏せる', () => {
    const big = { s: 'y'.repeat(300) }
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const line = appLogLine('error', ['[vein] 失敗:', new Error('この席の端末を確認できませんでした'), { n: 1 }, big, circular, 3])
    expect(line).toBe(`error [vein] 失敗: Error: この席の端末を確認できませんでした {"n":1} ${JSON.stringify(big).slice(0, 200)} [object Object] 3`)
    expect(appLogLine('log', ['[useManagerAuth] setManagerId: 878a50e3-8e91-46e3-9c0f-b4cceb19686b → null']))
      .toBe('log [useManagerAuth] setManagerId: <uuid> → null')
  })

  it('包んだ後もコンソールへはそのまま出し、写す行だけ送り待ちへ足す。2 回包まない', () => {
    const c = fakeConsole()
    const originalWarn = c.warn
    installAppConsoleCapture(c)
    const wrapped = c.warn
    installAppConsoleCapture(c)
    expect(c.warn).toBe(wrapped)

    c.warn('[useDeviceToken] 端末の署名に失敗 stage=vein-sign')
    c.log('ふつうの行')
    expect(originalWarn).toHaveBeenCalledWith('[useDeviceToken] 端末の署名に失敗 stage=vein-sign')
    expect(appendAppLog).toHaveBeenCalledTimes(1)
    expect(appendAppLog).toHaveBeenCalledWith('warn [useDeviceToken] 端末の署名に失敗 stage=vein-sign')
  })

  it('引数なしならグローバルの console を包む (plugin が先に包んでいれば何もしない)', () => {
    expect(() => installAppConsoleCapture()).not.toThrow()
    expect(() => installAppConsoleCapture()).not.toThrow()
  })
})
