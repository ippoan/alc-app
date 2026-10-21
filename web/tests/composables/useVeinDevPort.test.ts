import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const dev = vi.hoisted(() => ({ value: false }))
vi.mock('~/utils/token-selection', async importOriginal => ({
  ...await importOriginal<typeof import('~/utils/token-selection')>(),
  isDevDevice: () => dev.value,
}))

import { DEV_DEVICE_MARK_EVENT } from '~/utils/token-selection'
import { installVeinDevPort, isAllowedVeinDevLine, sendVeinDevLine, VEIN_DEV_SEND_TIMEOUT_MS } from '~/composables/useVeinDevPort'

let dispose: (() => void) | null = null

function install(request = vi.fn(async () => 'OK')) {
  dispose = installVeinDevPort(request)
  return request
}

beforeEach(() => {
  dev.value = false
  delete window.alcVein
})

afterEach(() => {
  dispose?.()
  dispose = null
})

describe('installVeinDevPort: 生やす/消す', () => {
  it('開発用の端末なら window.alcVein を生やす', () => {
    dev.value = true
    install()
    expect(typeof window.alcVein?.send).toBe('function')
  })

  it('開発用でない端末には生やさない', () => {
    install()
    expect(window.alcVein).toBeUndefined()
  })

  it('印が外れたら消し、付いたら生やす', () => {
    dev.value = true
    install()
    dev.value = false
    window.dispatchEvent(new Event(DEV_DEVICE_MARK_EVENT))
    expect(window.alcVein).toBeUndefined()
    dev.value = true
    window.dispatchEvent(new Event(DEV_DEVICE_MARK_EVENT))
    expect(window.alcVein).toBeDefined()
  })

  it('解除すると消え、以後のイベントでは生えない', () => {
    dev.value = true
    install()
    dispose!()
    dispose = null
    expect(window.alcVein).toBeUndefined()
    window.dispatchEvent(new Event(DEV_DEVICE_MARK_EVENT))
    expect(window.alcVein).toBeUndefined()
  })
})

describe('alcVein.send', () => {
  it('VEIN TEST VERIFY 2 は errPrefix 付きで request に渡る (既定 30 秒)', async () => {
    dev.value = true
    const request = install(vi.fn(async () => 'OK VEIN TEST VERIFY 2'))
    await expect(window.alcVein!.send('VEIN TEST VERIFY 2', 'OK VEIN TEST VERIFY')).resolves.toBe('OK VEIN TEST VERIFY 2')
    expect(request).toHaveBeenCalledWith('VEIN TEST VERIFY 2', 'OK VEIN TEST VERIFY', VEIN_DEV_SEND_TIMEOUT_MS, 'ERR ')
  })

  it('VEIN FINGER? は timeout を指定できる', async () => {
    dev.value = true
    const request = install()
    await window.alcVein!.send('VEIN FINGER?', 'VEIN FINGER', 5_000)
    expect(request).toHaveBeenCalledWith('VEIN FINGER?', 'VEIN FINGER', 5_000, 'ERR ')
  })

  it.each([
    'AUTH SIGN abc',
    'DEVICE',
    'VEIN FINGER? x',
    'VEIN TEST',
    '',
    'VEIN TEST VERIFY 2\nAUTH SIGN abc',
    'VEIN TEST VERIFY 2\r',
    'VEIN FINGER?\n',
  ])('%j は request を呼ばずに reject する', async (line) => {
    dev.value = true
    const request = install()
    await expect(window.alcVein!.send(line, 'OK')).rejects.toThrow('alcVein.send')
    expect(request).not.toHaveBeenCalled()
  })

  it('ERR の応答 (request の reject) はそのまま reject になる', async () => {
    dev.value = true
    install(vi.fn(async () => { throw new Error('ERR VEIN TEST: NO_FINGER') }))
    await expect(window.alcVein!.send('VEIN TEST VERIFY 2', 'OK')).rejects.toThrow('NO_FINGER')
  })
})

describe('isAllowedVeinDevLine', () => {
  it('試験コマンドと VEIN FINGER? だけ通す', () => {
    expect(isAllowedVeinDevLine('VEIN TEST CLEAR 2')).toBe(true)
    expect(isAllowedVeinDevLine('VEIN FINGER?')).toBe(true)
    expect(isAllowedVeinDevLine('VEIN CAPTURE')).toBe(false)
  })
})

describe('sendVeinDevLine (window.alcVein と試験タブが共有する送信関数)', () => {
  it('通る行は errPrefix 付きで request に渡る (timeout 省略は既定 30 秒)', async () => {
    const request = vi.fn(async () => 'OK')
    await expect(sendVeinDevLine(request, 'VEIN TEST CLEAR 2', 'VEIN TEST CLEARED 2')).resolves.toBe('OK')
    expect(request).toHaveBeenCalledWith('VEIN TEST CLEAR 2', 'VEIN TEST CLEARED 2', VEIN_DEV_SEND_TIMEOUT_MS, 'ERR ')
  })

  it('通らない行は request を呼ばずに reject する', async () => {
    const request = vi.fn(async () => 'OK')
    await expect(sendVeinDevLine(request, 'AUTH SIGN abc', 'OK', 1000)).rejects.toThrow('alcVein.send')
    expect(request).not.toHaveBeenCalled()
  })
})
