import { describe, it, expect, afterEach } from 'vitest'

import { isWebSerialSupported } from '~/utils/webserial'

// 判定が複数の composable に複製されていたものを 1 本にまとめた関数
// (Refs ippoan/alc-app#182)。SSR (navigator 無し) を含めて挙動を固定する。
describe('isWebSerialSupported', () => {
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

  afterEach(() => {
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator)
    delete (navigator as any).serial
  })

  it('navigator が無い (SSR) → false', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: undefined,
      configurable: true,
      writable: true,
    })
    expect(isWebSerialSupported()).toBe(false)
  })

  it('navigator はあるが serial が無い → false', () => {
    delete (navigator as any).serial
    expect(isWebSerialSupported()).toBe(false)
  })

  it('navigator.serial がある → true', () => {
    Object.defineProperty(navigator, 'serial', {
      value: { requestPort: () => {}, getPorts: async () => [] },
      configurable: true,
      writable: true,
    })
    expect(isWebSerialSupported()).toBe(true)
  })
})
