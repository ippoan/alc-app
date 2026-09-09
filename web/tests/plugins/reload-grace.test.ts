import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import plugin, { isChunkLoadError } from '~/plugins/reload-grace.client'
import { RELOAD_REASON_KEY } from '~/utils/reload-reason'

const notifyIntentionalReload = vi.fn()
mockNuxtImport('useAlarmDevice', () => () => ({ notifyIntentionalReload }))

type Listener = (event: Event) => void

/**
 * chunk 読み込み失敗の自動復旧 reload の直前に走る plugin。
 * window へ実イベントを dispatch すると auth-client の chunkReload plugin (テスト環境の
 * Nuxt app にも載っている) まで発火して fetch + reload に行くので、addEventListener を
 * spy して登録された listener を直接呼ぶ。
 */
describe('plugins/reload-grace.client', () => {
  let hooks: Record<string, (payload: any) => void>
  let listeners: Record<string, Listener>
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    hooks = {}
    listeners = {}
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: Listener) => {
      listeners[type] = listener
    }) as typeof window.addEventListener)
    const nuxtApp = {
      hook: (name: string, fn: (payload: any) => void) => { hooks[name] = fn },
      runWithContext: (fn: () => unknown) => fn(),
    }
    ;(plugin as unknown as (app: typeof nuxtApp) => void)(nuxtApp)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('Nuxt の hook より先に走るよう enforce: pre で登録する', () => {
    expect((plugin as unknown as { enforce: string }).enforce).toBe('pre')
    expect(hooks['app:chunkError']).toBeTypeOf('function')
    expect(listeners['vite:preloadError']).toBeTypeOf('function')
    expect(listeners['unhandledrejection']).toBeTypeOf('function')
  })

  it('app:chunkError → 失敗した chunk の URL を理由として残し、grace を送る', () => {
    hooks['app:chunkError']!({
      error: new Error('Failed to fetch dynamically imported module: https://example.test/_nuxt/Abc.def.js'),
    })

    expect(sessionStorage.getItem(RELOAD_REASON_KEY)).toMatch(
      /^chunkError https:\/\/example\.test\/_nuxt\/Abc\.def\.js at \d/,
    )
    expect(notifyIntentionalReload).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[RELOAD-DETECT]'))
  })

  it('vite:preloadError → payload を理由として残す (URL が無ければ message の先頭)', () => {
    listeners['vite:preloadError']!(Object.assign(new Event('vite:preloadError'), {
      payload: 'Unable to preload CSS',
    }))

    expect(sessionStorage.getItem(RELOAD_REASON_KEY)).toMatch(/^vite:preloadError Unable to preload CSS at /)
    expect(notifyIntentionalReload).toHaveBeenCalledTimes(1)
  })

  it('payload が Error でも文字列でもなければ理由は種別だけ', () => {
    listeners['vite:preloadError']!(new Event('vite:preloadError'))

    expect(sessionStorage.getItem(RELOAD_REASON_KEY)).toMatch(/^vite:preloadError {2}at /)
    expect(notifyIntentionalReload).toHaveBeenCalledTimes(1)
  })

  it('unhandledrejection は chunk 読み込み失敗のときだけ拾う', () => {
    listeners['unhandledrejection']!(Object.assign(new Event('unhandledrejection'), {
      reason: new Error('something else failed'),
    }))
    expect(sessionStorage.getItem(RELOAD_REASON_KEY)).toBeNull()
    expect(notifyIntentionalReload).not.toHaveBeenCalled()

    listeners['unhandledrejection']!(Object.assign(new Event('unhandledrejection'), {
      reason: new Error('Loading chunk 12 failed. (https://example.test/_nuxt/x.js)'),
    }))
    expect(sessionStorage.getItem(RELOAD_REASON_KEY)).toMatch(/^unhandledrejection https:\/\/example\.test\/_nuxt\/x\.js at /)
    expect(notifyIntentionalReload).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Failed to fetch dynamically imported module: https://x/a.js', true],
    ['Importing a module script failed.', true],
    ['Loading chunk 3 failed', true],
    ['TypeError: foo is not a function', false],
    ['', false],
  ])('isChunkLoadError(%j) = %s', (message, expected) => {
    expect(isChunkLoadError(message)).toBe(expected)
  })
})
