import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, ref } from 'vue'
import { withSetup } from '../helpers/with-setup'
import {
  useSingleInstance,
  singleInstanceLockName,
  SINGLE_INSTANCE_MAX_TRIES,
  SINGLE_INSTANCE_RETRY_MS,
} from '~/composables/useSingleInstance'

type LockCallback = (lock: object | null) => unknown

/**
 * Web Locks の最小モック。`available` が true なら callback に lock を渡し、
 * false なら null を渡す (= `ifAvailable` で取れなかった)。
 * callback の戻り値 (握り続けるための resolve しない Promise) はそのまま返す。
 */
function installLocks(available: () => boolean, opts: { reject?: boolean } = {}) {
  const callbacks: Array<{ lock: object | null; returned: unknown }> = []
  const request = vi.fn(async (_name: string, _opts: unknown, cb: LockCallback) => {
    if (opts.reject) throw new DOMException('locks unavailable', 'InvalidStateError')
    const lock = available() ? { name: _name, mode: 'exclusive' } : null
    const returned = cb(lock)
    callbacks.push({ lock, returned })
    return returned
  })
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
  return { request, callbacks }
}

function installDisplayMode(standalone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({ matches: standalone, media: query })),
  })
}

function installHistoryLength(length: number) {
  Object.defineProperty(window, 'history', { configurable: true, value: { length } })
}

/** onMounted → 最初の request (同期) → microtask を流す */
async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

/** 再試行を全部使い切る (7 回分の待ち + 余裕) */
async function exhaustRetries() {
  await vi.advanceTimersByTimeAsync(SINGLE_INSTANCE_RETRY_MS * SINGLE_INSTANCE_MAX_TRIES)
}

describe('useSingleInstance', () => {
  let close: ReturnType<typeof vi.fn>
  const savedHistory = Object.getOwnPropertyDescriptor(window, 'history')

  beforeEach(() => {
    vi.useFakeTimers()
    close = vi.fn()
    Object.defineProperty(window, 'close', { configurable: true, writable: true, value: close })
    installDisplayMode(false)
    installHistoryLength(2)
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (navigator as { locks?: unknown }).locks
    if (savedHistory) Object.defineProperty(window, 'history', savedHistory)
    else delete (window as { history?: unknown }).history
  })

  it('ロック名は alc-pwa:<role>', () => {
    expect(singleInstanceLockName('driver')).toBe('alc-pwa:driver')
    expect(singleInstanceLockName('manager')).toBe('alc-pwa:manager')
  })

  it('navigator.locks が無い環境では何もしない (素通し)', async () => {
    const [result, app] = withSetup(() => useSingleInstance('driver'))
    await flush()
    await exhaustRetries()
    expect(result.duplicate.value).toBe(false)
    expect(close).not.toHaveBeenCalled()
    app.unmount()
  })

  it('取れる → duplicate=false。ifAvailable で 1 回だけ要求し、callback は resolve しない Promise を返して握り続ける', async () => {
    const { request, callbacks } = installLocks(() => true)
    const [result, app] = withSetup(() => useSingleInstance('driver'))
    await flush()
    await exhaustRetries()

    expect(result.duplicate.value).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('alc-pwa:driver', { ifAvailable: true }, expect.any(Function))
    expect(callbacks[0]!.lock).not.toBeNull()
    // 握り続ける = callback の戻りは pending の Promise
    let settled = false
    void (callbacks[0]!.returned as Promise<void>).then(() => { settled = true })
    await flush()
    expect(settled).toBe(false)
    expect(close).not.toHaveBeenCalled()
    app.unmount()
  })

  it('role は ref / computed でも受け、mount 時点の値でロック名を決める', async () => {
    const role = ref<'driver' | 'manager'>('manager')
    const { request } = installLocks(() => true)
    const [, app] = withSetup(() => useSingleInstance(computed(() => role.value)))
    await flush()
    expect(request).toHaveBeenCalledWith('alc-pwa:manager', { ifAvailable: true }, expect.any(Function))
    app.unmount()
  })

  it('8 回とも取れない → duplicate=true。通常タブでは close を自動では呼ばない', async () => {
    const { request, callbacks } = installLocks(() => false)
    const [result, app] = withSetup(() => useSingleInstance('driver'))
    await flush()
    expect(request).toHaveBeenCalledTimes(1)
    expect(result.duplicate.value).toBe(false)

    // 7 回目までは判定しない
    await vi.advanceTimersByTimeAsync(SINGLE_INSTANCE_RETRY_MS * (SINGLE_INSTANCE_MAX_TRIES - 2))
    expect(request).toHaveBeenCalledTimes(SINGLE_INSTANCE_MAX_TRIES - 1)
    expect(result.duplicate.value).toBe(false)

    await vi.advanceTimersByTimeAsync(SINGLE_INSTANCE_RETRY_MS)
    expect(request).toHaveBeenCalledTimes(SINGLE_INSTANCE_MAX_TRIES)
    expect(result.duplicate.value).toBe(true)
    expect(callbacks.every((c) => c.lock === null)).toBe(true)
    expect(close).not.toHaveBeenCalled()

    // ボタンを押したときだけ閉じる
    result.closeWindow()
    expect(close).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('8 回とも取れない + PWA ウィンドウ (standalone) + history.length===1 → 自動で close', async () => {
    installDisplayMode(true)
    installHistoryLength(1)
    installLocks(() => false)
    const [result, app] = withSetup(() => useSingleInstance('driver'))
    await flush()
    await exhaustRetries()
    expect(result.duplicate.value).toBe(true)
    expect(window.matchMedia).toHaveBeenCalledWith('(display-mode: standalone)')
    expect(close).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('standalone でも history.length が 2 以上なら自動では閉じない (window.close は無視される)', async () => {
    installDisplayMode(true)
    installHistoryLength(2)
    installLocks(() => false)
    const [result, app] = withSetup(() => useSingleInstance('driver'))
    await flush()
    await exhaustRetries()
    expect(result.duplicate.value).toBe(true)
    expect(close).not.toHaveBeenCalled()
    app.unmount()
  })

  it('3 回目で取れる → duplicate=false (reload で旧ページの解放が遅れる競合に耐える)', async () => {
    let calls = 0
    const { request } = installLocks(() => ++calls >= 3)
    const [result, app] = withSetup(() => useSingleInstance('driver'))
    await flush()
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SINGLE_INSTANCE_RETRY_MS)
    expect(request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(SINGLE_INSTANCE_RETRY_MS)
    expect(request).toHaveBeenCalledTimes(3)
    await exhaustRetries()
    expect(request).toHaveBeenCalledTimes(3)
    expect(result.duplicate.value).toBe(false)
    expect(close).not.toHaveBeenCalled()
    app.unmount()
  })

  it('request が reject する環境では判定不能なので案内を出さない (fail-open)', async () => {
    const { request } = installLocks(() => false, { reject: true })
    const [result, app] = withSetup(() => useSingleInstance('driver'))
    await flush()
    await exhaustRetries()
    expect(request).toHaveBeenCalledTimes(1)
    expect(result.duplicate.value).toBe(false)
    expect(close).not.toHaveBeenCalled()
    app.unmount()
  })
})
