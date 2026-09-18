import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  APP_UPDATE_NOTICE_MESSAGE,
  APP_UPDATE_NOTICE_MS,
  APP_UPDATE_RELOAD_REASON,
  APP_UPDATE_TICK_MS,
  KIOSK_FIRST_STEP,
  createAppUpdateGate,
  isSafeToReload,
  type AppUpdateGateDeps,
  type KioskScreen,
} from '~/utils/app-update-gate'

describe('utils/app-update-gate', () => {
  let screen: KioskScreen | null
  let notice: ReturnType<typeof vi.fn>
  let beforeApply: ReturnType<typeof vi.fn>
  let apply: ReturnType<typeof vi.fn>
  let scheduled: Array<{ fn: () => void, ms: number }>

  function makeGate(overrides: Partial<AppUpdateGateDeps> = {}) {
    return createAppUpdateGate({
      screen: () => screen,
      noticeMs: APP_UPDATE_NOTICE_MS,
      notice,
      beforeApply,
      apply,
      schedule: (fn, ms) => { scheduled.push({ fn, ms }) },
      ...overrides,
    })
  }

  beforeEach(() => {
    screen = { step: KIOSK_FIRST_STEP, busy: false }
    notice = vi.fn()
    beforeApply = vi.fn()
    apply = vi.fn()
    scheduled = []
  })

  it('定数は仕様どおり', () => {
    expect(KIOSK_FIRST_STEP).toBe('nfc')
    expect(APP_UPDATE_TICK_MS).toBe(30_000)
    expect(APP_UPDATE_NOTICE_MS).toBe(4_000)
    expect(APP_UPDATE_NOTICE_MESSAGE).toBe('新しいバージョンがあります。読み込み直します')
    expect(APP_UPDATE_RELOAD_REASON).toBe('pwa-update')
  })

  describe('isSafeToReload', () => {
    it('最初の画面に居て、手が離せる状態なら安全', () => {
      expect(isSafeToReload({ step: KIOSK_FIRST_STEP, busy: false })).toBe(true)
    })

    it('キオスクが載っていない画面 (管理画面など) には広げない', () => {
      expect(isSafeToReload(null)).toBe(false)
    })

    it.each([
      'face_auth', 'alcohol', 'medical', 'self_declaration', 'safety_result',
      'daily_inspection', 'carrying_items', 'instruction', 'report',
      'completed', 'interrupted', 'cancelled', 'schedule_select',
    ])('点呼が始まっている段 (%s) では飛ばさない', (step) => {
      expect(isSafeToReload({ step, busy: false })).toBe(false)
    })

    it('最初の画面でも busy なら飛ばさない (入口で止まっている / 照会中)', () => {
      expect(isSafeToReload({ step: KIOSK_FIRST_STEP, busy: true })).toBe(false)
    })
  })

  it('新版が無ければ、最初の画面に居ても何もしない', () => {
    const gate = makeGate()

    expect(gate.tick()).toBe('no-update')
    expect(notice).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(0)
  })

  it('新版があっても、点呼が始まっている間は入れ替えない', () => {
    const gate = makeGate()
    gate.markUpdateAvailable()

    screen = { step: 'medical', busy: false }
    expect(gate.tick()).toBe('not-safe')

    // 入口で止まっている状態を「最初の画面」と誤認しない (#339 の blockedFaceAuthResult)
    screen = { step: 'face_auth', busy: true }
    expect(gate.tick()).toBe('not-safe')

    // 管理画面など、キオスクが載っていない画面も対象外
    screen = null
    expect(gate.tick()).toBe('not-safe')

    expect(notice).not.toHaveBeenCalled()
    expect(beforeApply).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(0)
  })

  it('新版があり最初の画面へ戻ってきたら、告知 → grace → 猶予後に入れ替える', () => {
    const gate = makeGate()
    gate.markUpdateAvailable()

    screen = { step: 'report', busy: false }
    expect(gate.tick()).toBe('not-safe')

    screen = { step: KIOSK_FIRST_STEP, busy: false }
    expect(gate.tick()).toBe('applying')
    expect(notice).toHaveBeenCalledWith(APP_UPDATE_NOTICE_MESSAGE)
    expect(beforeApply).toHaveBeenCalledTimes(1)
    expect(scheduled).toEqual([{ fn: expect.any(Function), ms: APP_UPDATE_NOTICE_MS }])

    // 告知だけでは入れ替わらない — 猶予が明けて初めて apply
    expect(apply).not.toHaveBeenCalled()
    scheduled[0]!.fn()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('一度予約したら、以後の tick は二重に告知も予約もしない', () => {
    const gate = makeGate()
    gate.markUpdateAvailable()
    expect(gate.tick()).toBe('applying')

    // 予約の直後に点呼が始まっても取り消さない (猶予は告知のためで、操作のためではない)
    screen = { step: 'face_auth', busy: false }
    expect(gate.tick()).toBe('already-applying')
    expect(gate.tick()).toBe('already-applying')
    expect(notice).toHaveBeenCalledTimes(1)
    expect(beforeApply).toHaveBeenCalledTimes(1)
    expect(scheduled).toHaveLength(1)
  })

  it('猶予は deps で差し替えられる', () => {
    const gate = makeGate({ noticeMs: 5 })
    gate.markUpdateAvailable()

    expect(gate.tick()).toBe('applying')
    expect(scheduled[0]!.ms).toBe(5)
  })
})
