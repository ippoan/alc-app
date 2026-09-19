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
 * Atom S3 (血圧計用 PC の測定台) の利用側。ポートの探索・open・`STATUS` プローブは
 * useSerialArbiter が行う (#182)。ここで見るのは「行の振り分け」と「claim / reject の述語」。
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

  /** ERR UNSUPPORTED を先着させて claim させる (STATUS 未対応機の実機と同じ形) */
  async function connectUnsupported(dev: MockPortHandle) {
    installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
    await load()
    dev.emit('ERR UNSUPPORTED (atoms3-nfc)\n')
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

  // ---------- claim / reject ----------

  describe('claim', () => {
    it('STATUS に未対応 (ERR UNSUPPORTED) なら claim する', async () => {
      const dev = createMockPort()
      dev.emit('ERR UNSUPPORTED (atoms3-nfc)\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      expect(await connect()).toBe(true)
      expect(atom.isConnected.value).toBe(true)
    })

    it('JSON 行が先着したら STATUS の応答を待たずに claim する', async () => {
      const dev = createMockPort()
      dev.emit('{"type":"found","device":"blood_pressure"}\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      expect(await connect()).toBe(true)
    })

    it('STATUS BOARD=cores3 (CoreS3 の名乗り) では claim しない (8 秒で見送り)', async () => {
      const dev = createMockPort()
      dev.emit('STATUS BOARD=cores3 LAN=up VER=1.2.3\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const p = atom.connect(0)
      await vi.advanceTimersByTimeAsync(3000)
      await expect(p).resolves.toBe(false)

      // arbiter のプローブ窓 (8 秒) が切れて手放す
      await vi.advanceTimersByTimeAsync(5000)
      expect(atom.isConnected.value).toBe(false)
      expect(dev.port.close).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['EVT ALARM state=alarming cause=silence\n', 'EVT ALARM'],
      ['EVT ALARM\n', 'EVT ALARM (引数なし)'],
      ['STATUS alarm state=idle cause=none hb_age_ms=1200 VER=0.1.0\n', 'STATUS alarm'],
    ])('警告デバイスの行 (%s) は reject して即手放す', async (line) => {
      const dev = createMockPort()
      dev.emit(line)
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      void atom.connect(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(atom.isConnected.value).toBe(false)
      // 8 秒待たずに閉じている (reject が確定した時点で打ち切り)
      expect(dev.port.close).toHaveBeenCalledTimes(1)
    })

    it('CoreS3 の起動時の EVT ALARM_RESTORED では reject せず、続く ERR UNSUPPORTED で claim する (Refs #225)', async () => {
      const dev = createMockPort()
      dev.emit('EVT ALARM_RESTORED\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const p = atom.connect(0)
      await vi.advanceTimersByTimeAsync(0)
      // 警告デバイスと取り違えて見送っていない
      expect(dev.port.close).not.toHaveBeenCalled()

      dev.emit('ERR UNSUPPORTED (atoms3-nfc)\n')
      await vi.advanceTimersByTimeAsync(0)
      await expect(p).resolves.toBe(true)
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

      dev.emit('{"type":"blood_pressure","systolic":120,"diastolic":80,"pulse":72,"unit":"mmHg"}\n')
      await connect()

      expect(seen).toEqual([{ type: 'blood_pressure', systolic: 120, diastolic: 80, pulse: 72, unit: 'mmHg' }])
    })

    it('採用後の JSON 行も配る', async () => {
      const dev = createMockPort()
      await connectUnsupported(dev)
      const seen: unknown[] = []
      atom.onJson(msg => seen.push(msg))

      dev.emit('{"type":"bp_bond","bonded":true}\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toEqual([{ type: 'bp_bond', bonded: true }])
    })

    it('壊れた JSON は console.warn して捨てる', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const dev = createMockPort()
      await connectUnsupported(dev)
      const seen: unknown[] = []
      atom.onJson(msg => seen.push(msg))

      dev.emit('{not json\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toEqual([])
      expect(warn).toHaveBeenCalledWith('[ATOM-S3] Invalid JSON:', '{not json')
      warn.mockRestore()
    })

    it('ERR UNSUPPORTED や未知の行は JSON として配らない', async () => {
      const dev = createMockPort()
      await connectUnsupported(dev)
      const seen: unknown[] = []
      atom.onJson(msg => seen.push(msg))

      dev.emit('ERR UNSUPPORTED (atoms3-nfc)\n')
      dev.emit('PONG\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toEqual([])
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

      // 諦めたあとでも、遅れて来た ERR UNSUPPORTED で採用される
      dev.emit('ERR UNSUPPORTED (atoms3-nfc)\n')
      await vi.advanceTimersByTimeAsync(0)
      expect(atom.isConnected.value).toBe(true)
    })

    it('接続済みなら待たずに true', async () => {
      const dev = createMockPort()
      await connectUnsupported(dev)

      await expect(connect()).resolves.toBe(true)
    })

    it('onOpen は transport を立てる利用側のために claim 直後・行の配布前に呼ばれる', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      const order: string[] = []
      atom.onOpen(() => order.push('open'))
      atom.onJson(() => order.push('json'))

      dev.emit('{"type":"found","device":"blood_pressure"}\n')
      await connect()

      expect(order).toEqual(['open', 'json'])
    })

    it('onOpen: 接続済みで登録するとその場で 1 回だけ呼ぶ', async () => {
      const dev = createMockPort()
      await connectUnsupported(dev)
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

      dev.emit('ERR UNSUPPORTED (atoms3-nfc)\n')
      await connect()
      expect(opened).toEqual([1])
    })

    it('release でポートを返すと onClose が呼ばれ、登録は残るので掴み直す', async () => {
      const dev = createMockPort()
      await connectUnsupported(dev)
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
      await connectUnsupported(dev)

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
      await connectUnsupported(dev)

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
      await connectUnsupported(dev)
      dev.setWriteError(true)

      await expect(atom.write('{"cmd":"reset"}')).resolves.toBe(false)
      expect(atom.isConnected.value).toBe(false)
      expect(dev.port.close).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- 公開 API の形 ----------

  it('navigator.serial は直接触らない (列挙は arbiter 経由)', async () => {
    const dev = createMockPort()
    const getPorts = vi.fn(async () => [dev.port])
    installSerialMock({ getPorts })
    await load()
    dev.emit('ERR UNSUPPORTED (atoms3-nfc)\n')
    await connect()

    // 探索 1 回。プローブは arbiter が撃つ
    expect(getPorts).toHaveBeenCalledTimes(1)
    expect(dev.writes).toEqual(['STATUS\n'])
  })
})
