import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Mock SerialPort (useCoreS3Serial.test.ts と同型) ---

interface MockPortHandle {
  port: any
  writes: string[]
  /** デバイスからの受信行を流す (未読なら queue に積まれる) */
  emit: (text: string) => void
  setWriteError: (v: boolean) => void
}

function createMockPort(options?: {
  vid?: number
  writeError?: boolean
}): MockPortHandle {
  const queue: Array<{ value?: Uint8Array; done: boolean }> = []
  let pending: ((chunk: { value?: Uint8Array; done: boolean }) => void) | null = null
  let cancelled = false
  let writeError = options?.writeError ?? false

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
      if (writeError) throw new Error('write failed')
      writes.push(new TextDecoder().decode(data))
    }),
    releaseLock: vi.fn(),
  }

  const port = {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    // 掴み直しでも同じ reader を使い回す (前回の cancel を持ち越さない)
    readable: { getReader: vi.fn(() => { cancelled = false; return reader }) },
    writable: { getWriter: vi.fn(() => writer) },
    getInfo: vi.fn(() => ({ usbVendorId: options?.vid ?? 0x303A, usbProductId: 0x1001 })),
  }

  return {
    port,
    writes,
    emit: (text: string) => push({ value: new TextEncoder().encode(text), done: false }),
    setWriteError: (v: boolean) => { writeError = v },
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
 * Atom S3 (血圧計用 PC の測定台) の利用側。ポートの探索・open・`DEVICE` プローブ・
 * 機種判定は useSerialArbiter が行う (#182, #353)。ここで見るのは「行の振り分け」と
 * 「預かったポートの使い方」。名乗りの kind は `bp-station` (auth-worker の
 * `DEVICE_KINDS` に揃えた語彙)。
 */
describe('useAtomS3Serial', () => {
  let mod: typeof import('~/composables/useAtomS3Serial')
  let atom: ReturnType<typeof mod.useAtomS3Serial>

  async function load() {
    vi.resetModules()
    mod = await import('~/composables/useAtomS3Serial')
    atom = mod.useAtomS3Serial()
  }

  /** connect() は arbiter の setTimeout(0) 越しに走るのでタイマーを進めながら待つ */
  async function connect(delay = 0): Promise<boolean> {
    const p = atom.connect(delay)
    await vi.advanceTimersByTimeAsync(delay)
    return await p
  }

  /** DEVICE bp-station を先着させて claim させる (実機と同じ形) */
  async function connectDevice(dev: MockPortHandle) {
    installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
    await load()
    dev.emit('DEVICE bp-station VER=0.1.0\n')
    expect(await connect()).toBe(true)
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    // 見送ったポートの再訪判定が Date.now() を見るので Date も止める
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    delete (navigator as any).serial
  })

  afterEach(async () => {
    await atom?.disconnect()
    delete (navigator as any).serial
    vi.useRealTimers()
  })

  // ---------- isSupported ----------

  describe('WebSerial 非対応', () => {
    it('isSupported=false / connect は false を返し探索しない', async () => {
      await load()
      expect(atom.isSupported).toBe(false)
      await expect(atom.connect(0)).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(20000)
      expect(atom.isConnected.value).toBe(false)
    })
  })

  // ---------- claim (機種識別は arbiter が DEVICE bp-station で行う。網羅的な
  // claim/reject の検証は useSerialArbiter.test.ts 側にある) ----------

  describe('claim', () => {
    it('DEVICE bp-station で claim されたら接続する', async () => {
      const dev = createMockPort()
      dev.emit('DEVICE bp-station VER=0.1.0\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      expect(await connect()).toBe(true)
      expect(atom.isConnected.value).toBe(true)
    })

    it('JSON だけが先着しても claim しない (DEVICE を待つ)', async () => {
      const dev = createMockPort()
      dev.emit('{"type":"found","device":"blood_pressure"}\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const p = atom.connect(0)
      await vi.advanceTimersByTimeAsync(8000)
      await expect(p).resolves.toBe(false)
    })

    it('DEVICE cores3 (CoreS3 の名乗り) では claim しない (8 秒で見送り)', async () => {
      const dev = createMockPort()
      dev.emit('DEVICE cores3 VER=1.2.3\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const p = atom.connect(0)
      await vi.advanceTimersByTimeAsync(8000)
      await expect(p).resolves.toBe(false)
      expect(atom.isConnected.value).toBe(false)
      expect(dev.port.close).toHaveBeenCalledTimes(1)
    })

    it('DEVICE alarm (警告デバイスの名乗り) では claim しない (8 秒で見送り)', async () => {
      const dev = createMockPort()
      dev.emit('DEVICE alarm VER=0.1.0\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const p = atom.connect(0)
      await vi.advanceTimersByTimeAsync(8000)
      await expect(p).resolves.toBe(false)
      expect(atom.isConnected.value).toBe(false)
      expect(dev.port.close).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- 行の振り分け ----------

  describe('onJson', () => {
    it('プローブ中に来ていた行も採用時に配る', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      const seen: unknown[] = []
      atom.onJson(msg => seen.push(msg))

      dev.emit('DEVICE bp-station VER=0.1.0\n{"type":"blood_pressure","systolic":120,"diastolic":80,"pulse":72,"unit":"mmHg"}\n')
      await connect()

      expect(seen).toEqual([{ type: 'blood_pressure', systolic: 120, diastolic: 80, pulse: 72, unit: 'mmHg' }])
    })

    it('採用後の JSON 行も配る', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const seen: unknown[] = []
      atom.onJson(msg => seen.push(msg))

      dev.emit('{"type":"bp_bond","bonded":true}\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toEqual([{ type: 'bp_bond', bonded: true }])
    })

    it('壊れた JSON は console.warn して捨てる', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const dev = createMockPort()
      await connectDevice(dev)
      const seen: unknown[] = []
      atom.onJson(msg => seen.push(msg))

      dev.emit('{not json\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toEqual([])
      expect(warn).toHaveBeenCalledWith('[ATOM-S3] Invalid JSON:', '{not json')
      warn.mockRestore()
    })

    it('DEVICE や未知の行は JSON として配らない', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const seen: unknown[] = []
      atom.onJson(msg => seen.push(msg))

      dev.emit('DEVICE bp-station VER=0.1.0\n')
      dev.emit('PONG\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toEqual([])
    })
  })

  // ---------- onEvent (NFC など。useCoreS3Serial と同形) ----------

  describe('onEvent', () => {
    it('EVT NFC_LICENSE を名前と引数に割って配る', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const seen: Array<[string, string[]]> = []
      atom.onEvent((name, args) => seen.push([name, args]))

      dev.emit('EVT NFC_LICENSE issue=20230401 expiry=20280401\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toEqual([['NFC_LICENSE', ['issue=20230401', 'expiry=20280401']]])
    })

    it('引数の無い EVT は args が空配列', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const seen: Array<[string, string[]]> = []
      atom.onEvent((name, args) => seen.push([name, args]))

      dev.emit('EVT NFC_READY\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toEqual([['NFC_READY', []]])
    })

    it('プローブ中に来ていた EVT も採用時に配る', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      const seen: Array<[string, string[]]> = []
      atom.onEvent((name, args) => seen.push([name, args]))

      dev.emit('DEVICE bp-station VER=0.1.0\nEVT NFC_LICENSE issue=20230401 expiry=20280401\n')
      await connect()

      expect(seen).toEqual([['NFC_LICENSE', ['issue=20230401', 'expiry=20280401']]])
    })

    it('返り値を呼ぶと解除できる', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const seen: string[] = []
      const off = atom.onEvent(name => seen.push(name))

      off()
      dev.emit('EVT NFC_LICENSE issue=20230401 expiry=20280401\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toEqual([])
    })

    it('EVT は JSON として配らず、JSON は EVT として配らない', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const json: unknown[] = []
      const events: string[] = []
      atom.onJson(msg => json.push(msg))
      atom.onEvent(name => events.push(name))

      dev.emit('EVT NFC_LICENSE issue=20230401 expiry=20280401\n')
      dev.emit('{"type":"bp_bond","bonded":true}\n')
      dev.emit('PONG\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(json).toEqual([{ type: 'bp_bond', bonded: true }])
      expect(events).toEqual(['NFC_LICENSE'])
    })
  })

  // ---------- connect / onOpen / onClose ----------

  describe('connect', () => {
    it('claim されるまで待ち、3 秒で諦めても登録は残る', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const first = atom.connect(0)
      await vi.advanceTimersByTimeAsync(3000)
      await expect(first).resolves.toBe(false)
      expect(atom.isConnected.value).toBe(false)

      // 諦めたあとでも、遅れて来た DEVICE bp-station で採用される
      dev.emit('DEVICE bp-station VER=0.1.0\n')
      await vi.advanceTimersByTimeAsync(0)
      expect(atom.isConnected.value).toBe(true)
    })

    it('接続済みなら待たずに true', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      await expect(connect()).resolves.toBe(true)
    })

    it('onOpen は transport を立てる利用側のために claim 直後・行の配布前に呼ばれる', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      const order: string[] = []
      atom.onOpen(() => order.push('open'))
      atom.onJson(() => order.push('json'))

      dev.emit('DEVICE bp-station VER=0.1.0\n{"type":"found","device":"blood_pressure"}\n')
      await connect()

      expect(order).toEqual(['open', 'json'])
    })

    it('onOpen: 接続済みで登録するとその場で 1 回だけ呼ぶ', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const opened: number[] = []

      atom.onOpen(() => opened.push(1))
      expect(opened).toEqual([1])
      await vi.advanceTimersByTimeAsync(3000)
      expect(opened).toEqual([1])
    })

    it('onOpen: 未接続で登録すると、接続したときに 1 回だけ呼ぶ', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      const opened: number[] = []

      atom.onOpen(() => opened.push(1))
      expect(opened).toEqual([])

      dev.emit('DEVICE bp-station VER=0.1.0\n')
      await connect()
      expect(opened).toEqual([1])
    })

    it('release でポートを返すと onClose が呼ばれ、登録は残るので掴み直す', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const closed: number[] = []
      atom.onClose(() => closed.push(1))

      await atom.release()
      expect(closed).toEqual([1])
      expect(atom.isConnected.value).toBe(false)

      // 登録は残っている → 10 秒後の再スキャンで開き直す
      await vi.advanceTimersByTimeAsync(10000)
      expect(dev.port.open).toHaveBeenCalledTimes(2)
    })

    it('disconnect は登録ごと降りるので探索しない', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      await atom.disconnect()
      expect(atom.isConnected.value).toBe(false)

      await vi.advanceTimersByTimeAsync(30000)
      expect(dev.port.open).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- write ----------

  describe('write', () => {
    it('預かった writer に 1 行書く', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      await expect(atom.write('{"cmd":"reset"}')).resolves.toBe(true)
      expect(dev.writes.at(-1)).toBe('{"cmd":"reset"}\n')
    })

    it('未接続なら false (書きに行かない)', async () => {
      installSerialMock({ getPorts: vi.fn(async () => []) })
      await load()

      await expect(atom.write('{"cmd":"reset"}')).resolves.toBe(false)
    })

    it('書けなくなったらポートを返して掴み直しへ', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      dev.setWriteError(true)

      await expect(atom.write('{"cmd":"reset"}')).resolves.toBe(false)
      expect(atom.isConnected.value).toBe(false)
      expect(dev.port.close).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- request (#353 後続の VoiceS3R 署名要求で使う口) ----------

  describe('request', () => {
    it('行を書いて matchPrefix の応答で resolve する (arbiter.request を CLAIMANT_NAME で呼ぶ)', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      const p = atom.request('AUTH SIGNBP nonce-1', 'AUTH SIGBP ', 10_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes.at(-1)).toBe('AUTH SIGNBP nonce-1\n')

      dev.emit('AUTH SIGBP pk-1 sig-1 BP=1\n')
      await vi.advanceTimersByTimeAsync(0)
      await expect(p).resolves.toBe('AUTH SIGBP pk-1 sig-1 BP=1')
    })

    it('未接続なら reject する (ポートを預かっていない)', async () => {
      installSerialMock({ getPorts: vi.fn(async () => []) })
      await load()

      await expect(atom.request('AUTH SIGNBP nonce-1', 'AUTH SIGBP ', 10_000)).rejects.toThrow()
    })
  })

  // ---------- 公開 API の形 ----------

  it('navigator.serial は直接触らない (列挙は arbiter 経由)', async () => {
    const dev = createMockPort()
    const getPorts = vi.fn(async () => [dev.port])
    installSerialMock({ getPorts })
    await load()
    dev.emit('DEVICE bp-station VER=0.1.0\n')
    await connect()

    // 探索 1 回。プローブは arbiter が撃つ
    expect(getPorts).toHaveBeenCalledTimes(1)
    expect(dev.writes).toEqual(['DEVICE\n', 'STATUS\n'])
  })
})
