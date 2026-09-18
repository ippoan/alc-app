import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import plugin from '~/plugins/app-update.client'
import { APP_UPDATE_NOTICE_MESSAGE, APP_UPDATE_NOTICE_MS, APP_UPDATE_TICK_MS, KIOSK_FIRST_STEP, type KioskScreen } from '~/utils/app-update-gate'
import { RELOAD_REASON_KEY } from '~/utils/reload-reason'

const notifyIntentionalReload = vi.fn()
mockNuxtImport('useAlarmDevice', () => () => ({ notifyIntentionalReload }))

const screen = vi.fn<() => KioskScreen | null>()
vi.mock('~/composables/useKioskScreen', () => ({ readKioskScreen: () => screen() }))

/**
 * 本番 flip 後に開きっぱなしのキオスクを新版へ載せ替える plugin。
 * `setInterval` / `setTimeout` を spy して、登録されたものを直接呼ぶ。
 */
describe('plugins/app-update.client', () => {
  let tick: () => void
  let timers: Array<{ fn: () => void, ms: number }>
  let nuxtApp: { $pwa?: unknown, runWithContext: (fn: () => unknown) => unknown }
  let updateServiceWorker: ReturnType<typeof vi.fn>
  let needRefresh: { value: boolean }
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    document.getElementById('app-update-notice')?.remove()

    timers = []
    tick = () => {}
    screen.mockReturnValue({ step: KIOSK_FIRST_STEP, busy: false })
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.spyOn(window, 'setInterval').mockImplementation(((fn: () => void) => {
      tick = fn
      return 1
    }) as unknown as typeof window.setInterval)
    vi.spyOn(window, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
      timers.push({ fn, ms })
      return 1
    }) as unknown as typeof window.setTimeout)

    updateServiceWorker = vi.fn()
    needRefresh = { value: false }
    nuxtApp = {
      $pwa: { needRefresh, updateServiceWorker },
      runWithContext: (fn: () => unknown) => fn(),
    }
    ;(plugin as unknown as (app: typeof nuxtApp) => void)(nuxtApp)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('新版が出ていないかを定期的に見に行く', () => {
    expect(window.setInterval).toHaveBeenCalledWith(expect.any(Function), APP_UPDATE_TICK_MS)
  })

  it('新版が無ければ何も出さない', () => {
    tick()

    expect(document.getElementById('app-update-notice')).toBeNull()
    expect(timers).toHaveLength(0)
    expect(updateServiceWorker).not.toHaveBeenCalled()
  })

  it('新版があっても点呼が始まっていれば入れ替えない', () => {
    needRefresh.value = true
    screen.mockReturnValue({ step: 'medical', busy: false })
    tick()

    expect(document.getElementById('app-update-notice')).toBeNull()
    expect(updateServiceWorker).not.toHaveBeenCalled()
  })

  it('管理画面など、キオスクが載っていない画面には広げない', () => {
    needRefresh.value = true
    screen.mockReturnValue(null)
    tick()

    expect(document.getElementById('app-update-notice')).toBeNull()
    expect(timers).toHaveLength(0)
  })

  it('最初の画面へ戻ってきたら告知を出し、grace と理由を残してから入れ替える', () => {
    needRefresh.value = true
    screen.mockReturnValue({ step: 'report', busy: false })
    tick()
    expect(document.getElementById('app-update-notice')).toBeNull()

    screen.mockReturnValue({ step: KIOSK_FIRST_STEP, busy: false })
    tick()

    expect(document.getElementById('app-update-notice')?.textContent).toBe(APP_UPDATE_NOTICE_MESSAGE)
    expect(sessionStorage.getItem(RELOAD_REASON_KEY)).toMatch(/^pwa-update at \d/)
    expect(notifyIntentionalReload).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[RELOAD-DETECT]'))

    // 告知だけでは飛ばない — 猶予が明けて初めて skipWaiting を送る
    expect(updateServiceWorker).not.toHaveBeenCalled()
    expect(timers).toEqual([{ fn: expect.any(Function), ms: APP_UPDATE_NOTICE_MS }])
    timers[0]!.fn()
    expect(updateServiceWorker).toHaveBeenCalledTimes(1)
  })

  it('告知は二重に挿さず、以後の tick でも予約は増えない', () => {
    needRefresh.value = true
    tick()
    tick()

    expect(document.querySelectorAll('#app-update-notice')).toHaveLength(1)
    expect(timers).toHaveLength(1)
  })

  it('同じ id の告知が既にあれば二重に挿さない', () => {
    const existing = document.createElement('div')
    existing.id = 'app-update-notice'
    document.body.appendChild(existing)

    needRefresh.value = true
    tick()

    expect(document.querySelectorAll('#app-update-notice')).toHaveLength(1)
    expect(existing.textContent).toBe('')
  })

  it('PWA が無効な環境 ($pwa なし) では何もしない', () => {
    delete nuxtApp.$pwa
    tick()

    expect(document.getElementById('app-update-notice')).toBeNull()
    expect(timers).toHaveLength(0)
  })

  it('予約後に $pwa が消えても落ちない', () => {
    needRefresh.value = true
    tick()
    delete nuxtApp.$pwa

    expect(() => timers[0]!.fn()).not.toThrow()
    expect(updateServiceWorker).not.toHaveBeenCalled()
  })
})
