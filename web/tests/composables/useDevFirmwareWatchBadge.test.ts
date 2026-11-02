import { describe, it, expect } from 'vitest'
import { useDevFirmwareWatchBadge } from '~/composables/useDevFirmwareWatchBadge'

describe('useDevFirmwareWatchBadge', () => {
  it('既定は null で、書いた値を別の呼び出しからも読める (版の表示と共有する)', () => {
    const a = useDevFirmwareWatchBadge()
    expect(a.value).toBeNull()
    a.value = { on: true, text: '購読中', lastSignalAt: null }
    expect(useDevFirmwareWatchBadge().value).toEqual({ on: true, text: '購読中', lastSignalAt: null })
    a.value = null
  })
})
