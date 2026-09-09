import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Mock SerialPort (useAlarmDevice.test.ts と同型) ---

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
 * CoreS3 の利用側。ポートの探索・open・`STATUS` プローブは useSerialArbiter が行う (#182)。
 * ここで見るのは「行の振り分け」と「claim / reject の述語」。
 */
describe('useCoreS3Serial', () => {
  let mod: typeof import('~/composables/useCoreS3Serial')
  let core: ReturnType<typeof mod.useCoreS3Serial>

  async function load() {
    vi.resetModules()
    mod = await import('~/composables/useCoreS3Serial')
    core = mod.useCoreS3Serial()
  }

  /** connect() は arbiter の setTimeout(0) 越しに走るのでタイマーを進めながら待つ */
  async function connect(delay = 0): Promise<boolean> {
    const p = core.connect(delay)
    await vi.advanceTimersByTimeAsync(delay)
    return await p
  }

  /** JSON 行を先着させて claim させる (実機の BLE ゲートウェイと同じ形) */
  async function connectWithJson(dev: MockPortHandle) {
    installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
    await load()
    dev.emit('{"type":"ready","version":"1.0.0"}\n')
    expect(await connect()).toBe(true)
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    // 見送ったポートの再訪判定が Date.now() を見るので Date も止める
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    delete (navigator as any).serial
  })

  afterEach(async () => {
    await core?.disconnect()
    delete (navigator as any).serial
    vi.useRealTimers()
  })

  // ---------- isSupported ----------

  describe('WebSerial 非対応', () => {
    it('isSupported=false / connect は false を返し探索しない', async () => {
      await load()
      expect(core.isSupported).toBe(false)
      await expect(core.connect(0)).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(20000)
      expect(core.isConnected.value).toBe(false)
    })
  })

  // ---------- claim / reject ----------

  describe('claim', () => {
    it('JSON 行が先着したら STATUS の応答を待たずに claim する', async () => {
      const dev = createMockPort()
      dev.emit('{"type":"ready","version":"1.0.0"}\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      expect(await connect()).toBe(true)
      expect(core.isConnected.value).toBe(true)
      // プローブの 8 秒窓を待っていない (`HB OK` は claim 直後の 1 本目)
      expect(dev.writes).toEqual(['STATUS\n', 'HB OK\n'])
    })

    it('STATUS に BOARD=cores3 が含まれれば claim する', async () => {
      const dev = createMockPort()
      dev.emit('STATUS BOARD=cores3 LAN=up VER=1.2.3\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      await expect(connect()).resolves.toBe(true)
    })

    it('BOARD= の無い STATUS では claim しない (8 秒で見送り)', async () => {
      const dev = createMockPort()
      dev.emit('STATUS LAN=up VER=1.2.3\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const p = core.connect(0)
      await vi.advanceTimersByTimeAsync(3000)
      await expect(p).resolves.toBe(false)

      // arbiter のプローブ窓 (8 秒) が切れて手放す
      await vi.advanceTimersByTimeAsync(5000)
      expect(core.isConnected.value).toBe(false)
      expect(dev.port.close).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['EVT ALARM state=alarming cause=silence\n', 'EVT ALARM'],
      ['STATUS alarm state=idle cause=none hb_age_ms=1200 VER=0.1.0\n', 'STATUS alarm'],
    ])('警告デバイスの行 (%s) は reject して即手放す', async (line) => {
      const dev = createMockPort()
      dev.emit(line)
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      void core.connect(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(core.isConnected.value).toBe(false)
      // 8 秒待たずに閉じている (reject が確定した時点で打ち切り)
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
      core.onJson(msg => seen.push(msg))

      dev.emit('{"type":"ready","version":"1.0.0"}\n')
      await connect()

      expect(seen).toEqual([{ type: 'ready', version: '1.0.0' }])
    })

    it('採用後の JSON 行も配る', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)
      const seen: unknown[] = []
      core.onJson(msg => seen.push(msg))

      dev.emit('{"type":"heartbeat","thermo":true,"bp":false}\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toEqual([{ type: 'heartbeat', thermo: true, bp: false }])
    })

    it('壊れた JSON は console.warn して捨てる', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const dev = createMockPort()
      await connectWithJson(dev)
      const seen: unknown[] = []
      core.onJson(msg => seen.push(msg))

      dev.emit('{not json\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toEqual([])
      expect(warn).toHaveBeenCalledWith('[CoreS3] Invalid JSON:', '{not json')
      warn.mockRestore()
    })
  })

  describe('onEvent', () => {
    it('EVT <NAME> <args...> を名前と引数に割る', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)
      const seen: Array<[string, string[]]> = []
      core.onEvent((name, args) => seen.push([name, args]))

      dev.emit('EVT NFC_LICENSE issue=20230401 expiry=20280401\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toEqual([['NFC_LICENSE', ['issue=20230401', 'expiry=20280401']]])
    })

    it('引数の無い EVT は args=[] で配る', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)
      const seen: Array<[string, string[]]> = []
      core.onEvent((name, args) => seen.push([name, args]))

      dev.emit('EVT NFC_REMOVED\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toEqual([['NFC_REMOVED', []]])
    })

    it('EVT ALARM は CoreS3 の EVT ではないので配らない', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)
      const seen: string[] = []
      core.onEvent(name => seen.push(name))

      dev.emit('EVT ALARM state=idle cause=none\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toEqual([])
    })
  })

  it.each([
    ['PONG\n', '既知の接頭辞に当てはまらない行'],
    ['STATUS BOARD=cores3 LAN=up\n', '名乗りの STATUS'],
  ])('%s は捨てる', async (line) => {
    const dev = createMockPort()
    await connectWithJson(dev)
    const json: unknown[] = []
    const events: string[] = []
    core.onJson(msg => json.push(msg))
    core.onEvent(name => events.push(name))

    dev.emit(line)
    await vi.advanceTimersByTimeAsync(0)

    expect(json).toEqual([])
    expect(events).toEqual([])
  })

  // ---------- write ----------

  describe('write', () => {
    it('預かった writer に 1 行書く', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)

      await expect(core.write('{"cmd":"reset"}')).resolves.toBe(true)
      expect(dev.writes).toEqual(['STATUS\n', 'HB OK\n', '{"cmd":"reset"}\n'])
    })

    it('未接続なら false (書きに行かない)', async () => {
      installSerialMock({ getPorts: vi.fn(async () => []) })
      await load()

      await expect(core.write('{"cmd":"reset"}')).resolves.toBe(false)
    })

    it('書けなくなったらポートを返して掴み直しへ', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)
      dev.setWriteError(true)

      await expect(core.write('{"cmd":"reset"}')).resolves.toBe(false)
      expect(core.isConnected.value).toBe(false)
      expect(dev.port.close).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- heartbeat ----------

  /**
   * CoreS3 は heartbeat が途切れたら自分の判断で鳴る。送るのは `HB OK` 固定で、
   * 着信や signaling の生死は警告デバイス側の役割 (Refs ippoan/alc-app-s3#187)。
   */
  describe('heartbeat', () => {
    it('接続直後に 1 本、以後 3 秒ごとに HB OK を送る', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)

      // claim 直後の 1 本目 (firmware の初回武装を早める)
      expect(dev.writes).toEqual(['STATUS\n', 'HB OK\n'])

      await vi.advanceTimersByTimeAsync(3000)
      expect(dev.writes).toEqual(['STATUS\n', 'HB OK\n', 'HB OK\n'])

      await vi.advanceTimersByTimeAsync(3000)
      expect(dev.writes.filter(line => line === 'HB OK\n')).toHaveLength(3)
    })

    it('ポートを返したら止まり、掴み直しても二重に走らない', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)

      await core.release()
      const afterRelease = dev.writes.length
      // 再スキャン (10 秒) の手前まで進めても沈黙している
      await vi.advanceTimersByTimeAsync(9000)
      expect(dev.writes.slice(afterRelease)).toEqual([])

      // 登録は残っているので 10 秒後の再スキャンで掴み直す
      dev.emit('{"type":"ready","version":"1.0.0"}\n')
      await vi.advanceTimersByTimeAsync(1000)
      expect(core.isConnected.value).toBe(true)

      const afterReclaim = dev.writes.length
      await vi.advanceTimersByTimeAsync(3000)
      // 走っている heartbeat は 1 本だけ (前回のタイマーが残っていれば 2 本届く)
      expect(dev.writes.slice(afterReclaim)).toEqual(['HB OK\n'])
    })
  })

  // ---------- connect / onOpen / onClose ----------

  describe('connect', () => {
    it('claim されるまで待ち、3 秒で諦めても登録は残る', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const first = core.connect(0)
      await vi.advanceTimersByTimeAsync(3000)
      await expect(first).resolves.toBe(false)
      expect(core.isConnected.value).toBe(false)

      // 諦めたあとでも、遅れて来た JSON で採用される
      dev.emit('{"type":"ready","version":"1.0.0"}\n')
      await vi.advanceTimersByTimeAsync(0)
      expect(core.isConnected.value).toBe(true)
    })

    it('接続済みなら待たずに true', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)

      await expect(connect()).resolves.toBe(true)
    })

    it('onOpen は transport を立てる利用側のために claim 直後・行の配布前に呼ばれる', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      const order: string[] = []
      core.onOpen(() => order.push('open'))
      core.onJson(() => order.push('json'))

      dev.emit('{"type":"ready","version":"1.0.0"}\n')
      await connect()

      expect(order).toEqual(['open', 'json'])
    })

    it('release でポートを返すと onClose が呼ばれ、登録は残るので掴み直す', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)
      const closed: number[] = []
      core.onClose(() => closed.push(1))

      await core.release()
      expect(closed).toEqual([1])
      expect(core.isConnected.value).toBe(false)

      // 登録は残っている → 10 秒後の再スキャンで開き直す
      await vi.advanceTimersByTimeAsync(10000)
      expect(dev.port.open).toHaveBeenCalledTimes(2)
    })

    it('disconnect は登録ごと降りるので探索しない', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)

      await core.disconnect()
      expect(core.isConnected.value).toBe(false)

      await vi.advanceTimersByTimeAsync(30000)
      expect(dev.port.open).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- requestPort ----------

  describe('requestPort', () => {
    it('許可されたら探索して claim を待つ', async () => {
      const dev = createMockPort()
      const requestPort = vi.fn(async () => dev.port)
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]), requestPort })
      await load()
      dev.emit('{"type":"ready","version":"1.0.0"}\n')

      const p = core.requestPort()
      await vi.advanceTimersByTimeAsync(0)
      await expect(p).resolves.toBe(true)
      expect(requestPort).toHaveBeenCalledTimes(1)
      expect(core.isConnected.value).toBe(true)
    })

    it('キャンセルされたら false (探索を始めない)', async () => {
      const getPorts = vi.fn(async () => [])
      const requestPort = vi.fn(async () => { throw new DOMException('cancel', 'NotFoundError') })
      installSerialMock({ getPorts, requestPort })
      await load()

      await expect(core.requestPort()).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(10000)
      expect(getPorts).not.toHaveBeenCalled()
    })
  })

  // ---------- 公開 API の形 ----------

  it('navigator.serial は直接触らない (列挙は arbiter 経由)', async () => {
    const dev = createMockPort()
    const getPorts = vi.fn(async () => [dev.port])
    installSerialMock({ getPorts })
    await load()
    dev.emit('{"type":"ready","version":"1.0.0"}\n')
    await connect()

    // 探索 1 回。プローブは arbiter が撃つ
    expect(getPorts).toHaveBeenCalledTimes(1)
    expect(dev.writes).toEqual(['STATUS\n', 'HB OK\n'])
  })
})
