import { describe, it, expect, beforeEach } from 'vitest'
import { effectScope, ref, type EffectScope } from 'vue'
import { readReloadContext, resetReloadContext, useKioskScreen } from '~/composables/useKioskScreen'
import { KIOSK_FIRST_STEP, isSafeToReload, type KioskScreen } from '~/utils/app-update-gate'

/** いま「新版へ載せ替えてよい」と読めるか (plugin と同じ経路で見る)。 */
function safeNow(): boolean {
  return isSafeToReload(readReloadContext())
}

describe('composables/useKioskScreen', () => {
  beforeEach(() => {
    resetReloadContext()
  })

  describe('track (キオスクの現在地)', () => {
    it('キオスクが載っていなければ null', () => {
      expect(readReloadContext().screen).toBeNull()
    })

    it('track した現在地をすぐ読める (immediate)', () => {
      const scope = effectScope()
      const step = ref(KIOSK_FIRST_STEP)
      scope.run(() => {
        useKioskScreen().track(() => ({ step: step.value, busy: false }))
      })

      expect(readReloadContext().screen).toEqual({ step: KIOSK_FIRST_STEP, busy: false })
      scope.stop()
    })

    it('段が変わると読める値も変わる', async () => {
      const scope = effectScope()
      const screen = ref<KioskScreen>({ step: KIOSK_FIRST_STEP, busy: false })
      scope.run(() => {
        useKioskScreen().track(screen)
      })

      screen.value = { step: 'medical', busy: true }
      await nextTick()

      expect(readReloadContext().screen).toEqual({ step: 'medical', busy: true })
      scope.stop()
    })

    it('画面を離れたら null に戻る (古い段を「最初の画面」と読ませない)', () => {
      const scope = effectScope()
      scope.run(() => {
        useKioskScreen().track(() => ({ step: KIOSK_FIRST_STEP, busy: false }))
      })
      expect(readReloadContext().screen).not.toBeNull()

      scope.stop()
      expect(readReloadContext().screen).toBeNull()
    })

    it('composable からも同じ読み口を返す', () => {
      expect(useKioskScreen().readReloadContext()).toEqual({ screen: null, safe: 0, blocked: 0 })
    })
  })

  describe('declareSafeToReload (キオスクの載っていない画面の申告)', () => {
    it('誰も申告しなければ安全ではない (システム管理画面は従来どおり)', () => {
      expect(readReloadContext()).toEqual({ screen: null, safe: 0, blocked: 0 })
      expect(safeNow()).toBe(false)
    })

    it('申告すれば安全になり、離れたら残らない', () => {
      const scope = effectScope()
      scope.run(() => {
        useKioskScreen().declareSafeToReload(() => true)
      })

      expect(readReloadContext().safe).toBe(1)
      expect(safeNow()).toBe(true)

      scope.stop()
      expect(readReloadContext().safe).toBe(0)
      expect(safeNow()).toBe(false)
    })

    it('申告は状態に追従し、下ろした瞬間に (次の tick を待たずに) 安全でなくなる', () => {
      const scope = effectScope()
      const waiting = ref(false)
      scope.run(() => {
        useKioskScreen().declareSafeToReload(waiting)
      })

      // 通話中など、待機していない状態で始まれば申告は出ない
      expect(safeNow()).toBe(false)

      waiting.value = true
      expect(readReloadContext().safe).toBe(1)
      expect(safeNow()).toBe(true)

      // flush: 'sync' なので nextTick を挟まずに取り下がる
      waiting.value = false
      expect(readReloadContext().safe).toBe(0)
      expect(safeNow()).toBe(false)

      scope.stop()
    })
  })

  describe('declareReloadBlocked (拒否)', () => {
    it('拒否が 1 件でもあれば、安全の申告があっても安全にならない', () => {
      const safeScope = effectScope()
      const blockedScope = effectScope()
      const editing = ref(false)
      safeScope.run(() => { useKioskScreen().declareSafeToReload(() => true) })
      blockedScope.run(() => { useKioskScreen().declareReloadBlocked(editing) })

      expect(safeNow()).toBe(true)

      editing.value = true
      expect(readReloadContext()).toEqual({ screen: null, safe: 1, blocked: 1 })
      expect(safeNow()).toBe(false)

      editing.value = false
      expect(safeNow()).toBe(true)

      safeScope.stop()
      blockedScope.stop()
    })

    it('拒否している component が離れたら拒否も残らない', () => {
      const scope = effectScope()
      scope.run(() => { useKioskScreen().declareReloadBlocked(() => true) })
      expect(readReloadContext().blocked).toBe(1)

      scope.stop()
      expect(readReloadContext().blocked).toBe(0)
    })
  })

  describe('再マウント (pages/index.vue の managerAuthKey / adminAuthKey)', () => {
    /** 運行管理タブ 1 枚ぶん: 待機中の申告 + フォームを開いている拒否。 */
    function mountManagerTab(blocked: boolean): EffectScope {
      const scope = effectScope()
      scope.run(() => {
        const { declareSafeToReload, declareReloadBlocked } = useKioskScreen()
        declareSafeToReload(() => true)
        declareReloadBlocked(() => blocked)
      })
      return scope
    }

    it('同じタブを再クリックしても申告・拒否が二重に残らない', () => {
      const first = mountManagerTab(false)
      expect(readReloadContext()).toEqual({ screen: null, safe: 1, blocked: 0 })

      // Vue は key の違う subtree を「古い方を unmount してから新しい方を mount」する
      first.stop()
      const second = mountManagerTab(false)
      expect(readReloadContext()).toEqual({ screen: null, safe: 1, blocked: 0 })

      second.stop()
      expect(readReloadContext()).toEqual({ screen: null, safe: 0, blocked: 0 })
    })

    it('拒否している画面の再マウント中に、一瞬でも「安全」に見える窓が開かない', () => {
      const first = mountManagerTab(true)
      expect(safeNow()).toBe(false)

      // 古い方を捨てた直後 — 申告も一緒に消えるので安全にはならない
      first.stop()
      expect(safeNow()).toBe(false)

      // 新しい方が載った直後 — こちらもフォームを開いた状態で復帰する
      const second = mountManagerTab(true)
      expect(safeNow()).toBe(false)

      second.stop()
      expect(safeNow()).toBe(false)
    })

    it('新しい方が先に載る順序でも、古い方の破棄が新しい申告を巻き添えにしない', () => {
      const first = mountManagerTab(false)
      const second = mountManagerTab(false)
      expect(readReloadContext()).toEqual({ screen: null, safe: 2, blocked: 0 })

      // 古い方だけが取り下がる (トークン単位なので残った方の申告は生きたまま)
      first.stop()
      expect(readReloadContext()).toEqual({ screen: null, safe: 1, blocked: 0 })
      expect(safeNow()).toBe(true)

      second.stop()
      expect(readReloadContext()).toEqual({ screen: null, safe: 0, blocked: 0 })
      expect(safeNow()).toBe(false)
    })
  })
})
