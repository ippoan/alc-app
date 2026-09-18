import { describe, it, expect, beforeEach } from 'vitest'
import { effectScope, ref } from 'vue'
import { readKioskScreen, resetKioskScreen, useKioskScreen } from '~/composables/useKioskScreen'
import { KIOSK_FIRST_STEP, type KioskScreen } from '~/utils/app-update-gate'

describe('composables/useKioskScreen', () => {
  beforeEach(() => {
    resetKioskScreen()
  })

  it('キオスクが載っていなければ null', () => {
    expect(readKioskScreen()).toBeNull()
  })

  it('track した現在地をすぐ読める (immediate)', () => {
    const scope = effectScope()
    const step = ref(KIOSK_FIRST_STEP)
    scope.run(() => {
      useKioskScreen().track(() => ({ step: step.value, busy: false }))
    })

    expect(readKioskScreen()).toEqual({ step: KIOSK_FIRST_STEP, busy: false })
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

    expect(readKioskScreen()).toEqual({ step: 'medical', busy: true })
    scope.stop()
  })

  it('画面を離れたら null に戻る (古い段を「最初の画面」と読ませない)', () => {
    const scope = effectScope()
    scope.run(() => {
      useKioskScreen().track(() => ({ step: KIOSK_FIRST_STEP, busy: false }))
    })
    expect(readKioskScreen()).not.toBeNull()

    scope.stop()
    expect(readKioskScreen()).toBeNull()
  })

  it('composable からも同じ読み口を返す', () => {
    expect(useKioskScreen().readKioskScreen()).toBeNull()
  })
})
