import { describe, it, expect, vi, beforeEach } from 'vitest'

const envMock = vi.hoisted(() => ({
  isClient: true,
}))
vi.mock('~/utils/env', () => envMock)

import { useAlarmDeviceSetting } from '~/composables/useAlarmDeviceSetting'

const KEY = 'alc-alarm-device'

describe('useAlarmDeviceSetting', () => {
  beforeEach(() => {
    envMock.isClient = true
    localStorage.clear()
  })

  it('未設定なら null', () => {
    const { enabled } = useAlarmDeviceSetting()
    expect(enabled.value).toBeNull()
  })

  it("'on' / 'off' を true / false に読む (それ以外の値は未設定扱い)", () => {
    localStorage.setItem(KEY, 'on')
    expect(useAlarmDeviceSetting().enabled.value).toBe(true)

    localStorage.setItem(KEY, 'off')
    expect(useAlarmDeviceSetting().enabled.value).toBe(false)

    localStorage.setItem(KEY, 'yes')
    expect(useAlarmDeviceSetting().enabled.value).toBeNull()
  })

  it('setEnabled は値を即時に反映し、localStorage へ保存する', () => {
    const { enabled, setEnabled } = useAlarmDeviceSetting()

    setEnabled(true)
    expect(enabled.value).toBe(true)
    expect(localStorage.getItem(KEY)).toBe('on')

    setEnabled(false)
    expect(enabled.value).toBe(false)
    expect(localStorage.getItem(KEY)).toBe('off')
  })

  it('別の呼び出し元からも同じ値が見える (デバイス設定で変えた直後にバーへ反映)', () => {
    const a = useAlarmDeviceSetting()
    const b = useAlarmDeviceSetting()
    a.setEnabled(true)
    expect(b.enabled.value).toBe(true)
  })

  it('SSR (isClient=false) では読まず null のまま、setEnabled も保存しない', () => {
    localStorage.setItem(KEY, 'on')
    envMock.isClient = false
    const { enabled, setEnabled } = useAlarmDeviceSetting()
    expect(enabled.value).toBeNull()

    setEnabled(false)
    expect(enabled.value).toBe(false)
    expect(localStorage.getItem(KEY)).toBe('on')
  })

  it('localStorage が throw する環境 (private mode 等) では null 扱いで、setEnabled も落ちない', () => {
    // happy-dom の localStorage は prototype spy が効かないので、window のプロパティごと差し替える
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')!
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => { throw new Error('SecurityError') },
        setItem: () => { throw new Error('QuotaExceededError') },
      },
    })
    try {
      const { enabled, setEnabled } = useAlarmDeviceSetting()
      expect(enabled.value).toBeNull()

      expect(() => setEnabled(true)).not.toThrow()
      expect(enabled.value).toBe(true)
    } finally {
      Object.defineProperty(window, 'localStorage', original)
    }
  })
})
