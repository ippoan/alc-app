import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Mock SerialPort (useAtomS3Serial.test.ts と同型) ---

interface MockPortHandle {
  port: any
  writes: string[]
  /** デバイスからの受信行を流す (未読なら queue に積まれる) */
  emit: (text: string) => void
}

function createMockPort(options?: { vid?: number }): MockPortHandle {
  const queue: Array<{ value?: Uint8Array; done: boolean }> = []
  let pending: ((chunk: { value?: Uint8Array; done: boolean }) => void) | null = null
  let cancelled = false

  const reader = {
    read: vi.fn(() => {
      const next = queue.shift()
      if (next) return Promise.resolve(next)
      if (cancelled) return Promise.resolve({ value: undefined, done: true })
      return new Promise<{ value?: Uint8Array; done: boolean }>((resolve) => {
        pending = resolve
      })
    }),
    cancel: vi.fn(async () => {
      cancelled = true
      if (pending) {
        pending({ value: undefined, done: true })
        pending = null
      }
    }),
    releaseLock: vi.fn(),
  }

  function push(chunk: { value?: Uint8Array; done: boolean }) {
    if (pending) {
      pending(chunk)
      pending = null
    }
    else {
      queue.push(chunk)
    }
  }

  const writes: string[] = []
  const writer = {
    write: vi.fn(async (data: Uint8Array) => {
      writes.push(new TextDecoder().decode(data))
    }),
    releaseLock: vi.fn(),
  }

  const port = {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    readable: { getReader: vi.fn(() => { cancelled = false; return reader }) },
    writable: { getWriter: vi.fn(() => writer) },
    getInfo: vi.fn(() => ({ usbVendorId: options?.vid ?? 0x303A, usbProductId: 0x1001 })),
  }

  return {
    port,
    writes,
    emit: (text: string) => push({ value: new TextEncoder().encode(text), done: false }),
  }
}

function installSerialMock(serialMock: {
  requestPort?: ReturnType<typeof vi.fn>
  getPorts?: ReturnType<typeof vi.fn>
}) {
  Object.defineProperty(navigator, 'serial', {
    value: {
      requestPort: serialMock.requestPort ?? vi.fn(),
      getPorts: serialMock.getPorts ?? vi.fn(async () => []),
    },
    configurable: true,
    writable: true,
  })
}

// --- Tests ---

/**
 * Vein Station (指静脈読み取り端末、`timecard` の vein build) の利用側。ポートの探索・
 * open・`DEVICE` プローブ・機種判定は useSerialArbiter が行う (#182, #353)。ここで見るのは
 * `VEIN CAPTURE` / `VEIN SAY <x>` の応答の読み方 (Refs ippoan/vein-match#20)。
 */
describe('useVeinSerial', () => {
  let mod: typeof import('~/composables/useVeinSerial')
  let vein: ReturnType<typeof mod.useVeinSerial>

  async function load() {
    vi.resetModules()
    mod = await import('~/composables/useVeinSerial')
    vein = mod.useVeinSerial()
  }

  /** connect() は arbiter の setTimeout(0) 越しに走るのでタイマーを進めながら待つ */
  async function connect(delay = 0): Promise<boolean> {
    const p = vein.connect(delay)
    await vi.advanceTimersByTimeAsync(delay)
    return await p
  }

  /** DEVICE timecard を先着させて claim させる (実機と同じ形) */
  async function connectDevice(dev: MockPortHandle) {
    installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
    await load()
    dev.emit('DEVICE timecard VER=0.1.0\n')
    expect(await connect()).toBe(true)
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    delete (navigator as any).serial
  })

  afterEach(async () => {
    await vein?.disconnect()
    delete (navigator as any).serial
    vi.useRealTimers()
  })

  // ---------- isSupported ----------

  describe('WebSerial 非対応', () => {
    it('isSupported=false / connect は false を返し探索しない', async () => {
      await load()
      expect(vein.isSupported).toBe(false)
      await expect(vein.connect(0)).resolves.toBe(false)
    })
  })

  // ---------- connect ----------

  describe('connect', () => {
    it('DEVICE timecard で claim されたら接続する', async () => {
      const dev = createMockPort()
      dev.emit('DEVICE timecard VER=0.1.0\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      expect(await connect()).toBe(true)
      expect(vein.isConnected.value).toBe(true)
    })

    it('接続済みなら待たずに true', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      await expect(connect()).resolves.toBe(true)
    })

    it('claim されるまで待ち、3 秒で諦めても登録は残る', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const first = vein.connect(0)
      await vi.advanceTimersByTimeAsync(3000)
      await expect(first).resolves.toBe(false)
      expect(vein.isConnected.value).toBe(false)

      // 諦めたあとでも、遅れて来た DEVICE timecard で採用される
      dev.emit('DEVICE timecard VER=0.1.0\n')
      await vi.advanceTimersByTimeAsync(0)
      expect(vein.isConnected.value).toBe(true)
    })

    it('disconnect は登録ごと降りるので探索しない', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      await vein.disconnect()
      expect(vein.isConnected.value).toBe(false)

      await vi.advanceTimersByTimeAsync(30000)
      expect(dev.port.open).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- capture ----------

  describe('capture', () => {
    it('VEIN CHARA <hex> で成功、hex 部分を返す', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      const p = vein.capture()
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes.at(-1)).toBe('VEIN CAPTURE\n')

      dev.emit('VEIN CHARA ABCDEF0123\n')
      await vi.advanceTimersByTimeAsync(0)
      await expect(p).resolves.toBe('ABCDEF0123')
    })

    it('ERR VEIN NO_FINGER で reason 付きの Error を投げる', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      const p = vein.capture()
      // reject より前に handler を付けておく (付ける前に settle すると vitest が
      // "Unhandled Rejection" として拾ってしまうため。useSerialArbiter.test.ts と同じ形)
      const assertion = expect(p).rejects.toThrow('NO_FINGER')
      await vi.advanceTimersByTimeAsync(0)
      dev.emit('ERR VEIN NO_FINGER\n')
      await vi.advanceTimersByTimeAsync(0)
      await assertion
    })

    it('ERR VEIN NO_MODULE で reason 付きの Error を投げる', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      const p = vein.capture()
      const assertion = expect(p).rejects.toThrow('NO_MODULE')
      await vi.advanceTimersByTimeAsync(0)
      dev.emit('ERR VEIN NO_MODULE\n')
      await vi.advanceTimersByTimeAsync(0)
      await assertion
    })

    it('ERR VEIN READ_FAIL で reason 付きの Error を投げる', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      const p = vein.capture()
      const assertion = expect(p).rejects.toThrow('READ_FAIL')
      await vi.advanceTimersByTimeAsync(0)
      dev.emit('ERR VEIN READ_FAIL\n')
      await vi.advanceTimersByTimeAsync(0)
      await assertion
    })

    it('ERR VEIN RC=xx で reason 付きの Error を投げる', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      const p = vein.capture()
      const assertion = expect(p).rejects.toThrow('RC=1a')
      await vi.advanceTimersByTimeAsync(0)
      dev.emit('ERR VEIN RC=1a\n')
      await vi.advanceTimersByTimeAsync(0)
      await assertion
    })

    it('vein 非対応機は ERR VEIN: unsupported → reason は unsupported', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      const p = vein.capture()
      const assertion = expect(p).rejects.toThrow('unsupported')
      await vi.advanceTimersByTimeAsync(0)
      dev.emit('ERR VEIN: unsupported\n')
      await vi.advanceTimersByTimeAsync(0)
      await assertion
    })

    it('応答が無ければ 20 秒でタイムアウトする', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      const p = vein.capture()
      const assertion = expect(p).rejects.toThrow(/timeout/)
      await vi.advanceTimersByTimeAsync(20000)
      await assertion
    })
  })

  // ---------- say ----------

  describe('say', () => {
    it('OK VEIN SAY <x> で成功する', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      const p = vein.say('PLACE')
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes.at(-1)).toBe('VEIN SAY PLACE\n')

      dev.emit('OK VEIN SAY PLACE\n')
      await vi.advanceTimersByTimeAsync(0)
      await expect(p).resolves.toBeUndefined()
    })

    it('ERR VEIN NO_SPEAKER は失敗にしない (登録の手順を止めない)', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      const p = vein.say('AGAIN')
      await vi.advanceTimersByTimeAsync(0)
      dev.emit('ERR VEIN NO_SPEAKER\n')
      await vi.advanceTimersByTimeAsync(0)
      await expect(p).resolves.toBeUndefined()
    })

    it('NO_SPEAKER 以外の失敗はそのまま投げる', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      const p = vein.say('ENROLLED')
      const assertion = expect(p).rejects.toThrow('unsupported')
      await vi.advanceTimersByTimeAsync(0)
      dev.emit('ERR VEIN: unsupported\n')
      await vi.advanceTimersByTimeAsync(0)
      await assertion
    })
  })
})
