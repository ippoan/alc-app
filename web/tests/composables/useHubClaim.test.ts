import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * useHubClaim (#213 CoreS3 経由の自動端末登録) のテスト。
 *
 * useCoreS3Serial / useSerialArbiter は実体を使う (mock しない) — CoreS3 の
 * 接続そのものは useCoreS3Serial.test.ts / useSerialArbiter.test.ts が担保済みなので、
 * ここでは「接続イベントを受けて何をするか」だけを見る。
 *
 * **navigator.serial は load() より前に installSerialMock で用意すること。**
 * `useCoreS3Serial()` (→ `useSerialArbiter()`) は呼ばれた瞬間に
 * `isWebSerialSupported()` を評価して `isSupported` に固定するため、後から
 * navigator.serial を生やしても遅い (useCoreS3Serial.test.ts と同じ制約)。
 */

// --- Mock SerialPort (useCoreS3Serial.test.ts と同型) ---
function createMockPort(options?: { vid?: number }) {
  const queue: Array<{ value?: Uint8Array; done: boolean }> = []
  let pending: ((chunk: { value?: Uint8Array; done: boolean }) => void) | null = null

  const reader = {
    read: vi.fn(() => {
      const next = queue.shift()
      if (next) return Promise.resolve(next)
      return new Promise<{ value?: Uint8Array; done: boolean }>((resolve) => { pending = resolve })
    }),
    cancel: vi.fn(async () => {
      if (pending) { pending({ value: undefined, done: true }); pending = null }
    }),
    releaseLock: vi.fn(),
  }

  function push(chunk: { value?: Uint8Array; done: boolean }) {
    if (pending) { pending(chunk); pending = null }
    else queue.push(chunk)
  }

  const writes: string[] = []
  const writer = {
    write: vi.fn(async (data: Uint8Array) => { writes.push(new TextDecoder().decode(data)) }),
    releaseLock: vi.fn(),
  }

  const port = {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    readable: { getReader: vi.fn(() => reader) },
    writable: { getWriter: vi.fn(() => writer) },
    getInfo: vi.fn(() => ({ usbVendorId: options?.vid ?? 0x303A, usbProductId: 0x1001 })),
  }

  return { port, writes, emit: (text: string) => push({ value: new TextEncoder().encode(text), done: false }) }
}

function installSerialMock(getPorts: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'serial', {
    value: { requestPort: vi.fn(), getPorts },
    configurable: true,
    writable: true,
  })
}

/** dev port を作り、CoreS3 として見つかるように navigator.serial へ仕込む (load() より前に呼ぶこと) */
function prepareSerial() {
  const dev = createMockPort()
  installSerialMock(vi.fn(async () => [dev.port]))
  return dev
}

describe('useHubClaim', () => {
  let hubMod: typeof import('~/composables/useHubClaim')
  let authMod: typeof import('~/composables/useAuth')
  let coreMod: typeof import('~/composables/useCoreS3Serial')
  let hub: ReturnType<typeof hubMod.useHubClaim>
  let auth: ReturnType<typeof authMod.useAuth>
  let core: ReturnType<typeof coreMod.useCoreS3Serial>
  let fetchMock: ReturnType<typeof vi.fn>

  /** 3 つのモジュールを新しい singleton state で読み込む。navigator.serial は先に用意しておくこと */
  async function load() {
    vi.resetModules()
    authMod = await import('~/composables/useAuth')
    coreMod = await import('~/composables/useCoreS3Serial')
    hubMod = await import('~/composables/useHubClaim')
    auth = authMod.useAuth()
    core = coreMod.useCoreS3Serial()
    hub = hubMod.useHubClaim()
  }

  /** JSON ready 行を先着させて claim させる (onOpen が発火し、登録済みリスナーが attemptClaim を走らせる) */
  async function claim(dev: ReturnType<typeof createMockPort>) {
    dev.emit('{"type":"ready"}\n')
    const p = core.connect(0)
    await vi.advanceTimersByTimeAsync(0)
    await p
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    delete (navigator as any).serial
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    await core?.disconnect()
    delete (navigator as any).serial
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('未登録 + CoreS3 接続 → AUTH TICKET → pair/token 成功で端末登録される (device-claim と同じ保存関数)', async () => {
    const dev = prepareSerial()
    await load()
    expect(auth.isDeviceActivated.value).toBe(false)

    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ device_id: 'dev-1', device_secret: 'sec-1', tenant_id: 'tenant-1', label: 'CoreS3' }),
    })

    await claim(dev)
    await vi.advanceTimersByTimeAsync(0)
    expect(dev.writes).toContain('AUTH TICKET\n')

    dev.emit('AUTH TICKET tkt-xyz EXPIRES=300\n')
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/device/pair/token'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ device_code: 'tkt-xyz' }) }),
    )
    expect(auth.isDeviceActivated.value).toBe(true)
    expect(localStorage.getItem('alc_kiosk_device_id')).toBe('dev-1')
    expect(localStorage.getItem('alc_kiosk_device_secret')).toBe('sec-1')
    expect(hub.lastError.value).toBeNull()
  })

  it('既に端末登録済みなら CoreS3 が繋がっても何もしない (fetch しない)', async () => {
    const dev = prepareSerial()
    localStorage.setItem('alc_device_tenant_id', 'existing-tenant')
    await load()
    expect(auth.isDeviceActivated.value).toBe(true)

    await claim(dev)
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('CoreS3 未接続なら attemptClaim は何もしない', async () => {
    await load()
    await hub.attemptClaim()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('同時に 2 回走らせても 1 回しか実行しない (claiming ガード)', async () => {
    const dev = prepareSerial()
    await load()
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ device_id: 'dev-1', device_secret: 'sec-1', tenant_id: 'tenant-1' }),
    })
    await claim(dev)
    await vi.advanceTimersByTimeAsync(0)

    // 1 本目の request() が pending (ticket 未応答) のうちにもう一度呼ぶ
    void hub.attemptClaim()
    await vi.advanceTimersByTimeAsync(0)

    // AUTH TICKET は 1 回しか送られない
    expect(dev.writes.filter(w => w === 'AUTH TICKET\n')).toHaveLength(1)
  })

  it('リスナーは二重登録されない (useHubClaim を複数回呼んでも接続ごとに 1 回)', async () => {
    const dev = prepareSerial()
    await load()
    hubMod.useHubClaim()
    hubMod.useHubClaim()
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ device_id: 'dev-1', device_secret: 'sec-1', tenant_id: 'tenant-1' }),
    })

    await claim(dev)
    await vi.advanceTimersByTimeAsync(0)

    expect(dev.writes.filter(w => w === 'AUTH TICKET\n')).toHaveLength(1)
  })

  it('AUTH TICKET の応答が予期しない形なら lastError に出す', async () => {
    const dev = prepareSerial()
    await load()
    await claim(dev)
    await vi.advanceTimersByTimeAsync(0)

    dev.emit('AUTH TICKET malformed\n')
    await vi.advanceTimersByTimeAsync(0)

    expect(hub.lastError.value).toContain('CoreS3')
    expect(hub.lastError.value).toContain('予期しない応答')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('pair/token が非 2xx なら http status を lastError に出す', async () => {
    const dev = prepareSerial()
    await load()
    fetchMock.mockResolvedValue({ ok: false, status: 404 })
    await claim(dev)
    await vi.advanceTimersByTimeAsync(0)

    dev.emit('AUTH TICKET tkt-1 EXPIRES=300\n')
    await vi.advanceTimersByTimeAsync(0)

    expect(hub.lastError.value).toContain('http 404')
    expect(auth.isDeviceActivated.value).toBe(false)
  })

  it('pair/token の応答が不完全なら lastError に出す', async () => {
    const dev = prepareSerial()
    await load()
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ tenant_id: 'tenant-1' }) })
    await claim(dev)
    await vi.advanceTimersByTimeAsync(0)

    dev.emit('AUTH TICKET tkt-1 EXPIRES=300\n')
    await vi.advanceTimersByTimeAsync(0)

    expect(hub.lastError.value).toContain('応答が不完全です')
    expect(auth.isDeviceActivated.value).toBe(false)
  })

  it('ERR AUTH TICKET は理由を lastError に出す (Error 経由の catch)', async () => {
    const dev = prepareSerial()
    await load()
    await claim(dev)
    await vi.advanceTimersByTimeAsync(0)

    dev.emit('ERR AUTH TICKET: not ready\n')
    await vi.advanceTimersByTimeAsync(0)

    expect(hub.lastError.value).toContain('ERR AUTH TICKET: not ready')
  })

  it('タイムアウトは理由を lastError に出す', async () => {
    const dev = prepareSerial()
    await load()
    await claim(dev)
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(10_000)

    expect(hub.lastError.value).toContain('timeout')
  })

  it('fetch が Error でない値で reject しても lastError に出す (String(e) 経由の catch)', async () => {
    const dev = prepareSerial()
    await load()
    fetchMock.mockRejectedValue('boom')
    await claim(dev)
    await vi.advanceTimersByTimeAsync(0)

    dev.emit('AUTH TICKET tkt-1 EXPIRES=300\n')
    await vi.advanceTimersByTimeAsync(0)

    expect(hub.lastError.value).toContain('boom')
  })

  it('CoreS3 再接続のたびに 1 回試す', async () => {
    const dev = prepareSerial()
    await load()
    fetchMock.mockResolvedValue({ ok: false, status: 500 })
    await claim(dev)
    await vi.advanceTimersByTimeAsync(0)
    dev.emit('AUTH TICKET tkt-1 EXPIRES=300\n')
    await vi.advanceTimersByTimeAsync(0)
    expect(hub.lastError.value).toContain('http 500')

    await core.disconnect()
    const dev2 = createMockPort()
    installSerialMock(vi.fn(async () => [dev2.port]))
    await claim(dev2)
    await vi.advanceTimersByTimeAsync(0)
    expect(dev2.writes).toContain('AUTH TICKET\n')
  })
})
