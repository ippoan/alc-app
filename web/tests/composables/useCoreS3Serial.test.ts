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

  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vi.clearAllMocks()
    // arbiter の診断ログ ([SERIAL]) はテスト出力に流さない
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    // 見送ったポートの再訪判定が Date.now() を見るので Date も止める
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    delete (navigator as any).serial
  })

  afterEach(async () => {
    await core?.disconnect()
    delete (navigator as any).serial
    vi.useRealTimers()
    logSpy.mockRestore()
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
      ['EVT ALARM\n', 'EVT ALARM (引数なし)'],
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

    it('CoreS3 の起動時の EVT ALARM_RESTORED では reject せず、続く JSON で claim する (Refs #225)', async () => {
      const dev = createMockPort()
      dev.emit('EVT ALARM_RESTORED\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      const events: string[] = []
      core.onEvent(name => events.push(name))

      const p = core.connect(0)
      await vi.advanceTimersByTimeAsync(0)
      // 警告デバイスと取り違えて見送っていない
      expect(dev.port.close).not.toHaveBeenCalled()

      dev.emit('{"type":"ready","version":"1.0.0"}\n')
      await vi.advanceTimersByTimeAsync(0)
      await expect(p).resolves.toBe(true)
      // プローブ中の EVT も CoreS3 のものとして配る
      expect(events).toEqual(['ALARM_RESTORED'])
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

  // ---------- CoreS3 の EVT を置き場に残す (Refs ippoan/alc-app#225) ----------

  describe('診断ログの置き場に EVT を残す', () => {
    const DIAG_KEY = 'alc_serial_diag'

    /** 置き場の行 (先頭の `HH:MM:SS.mmm ` を落とした本文) */
    async function diag(): Promise<string[]> {
      const { readDiag } = await import('~/utils/serialDiagLog')
      return readDiag().map(line => line.replace(/^\d\d:\d\d:\d\d\.\d{3} /, ''))
    }

    beforeEach(() => {
      localStorage.removeItem(DIAG_KEY)
    })

    afterEach(() => {
      localStorage.removeItem(DIAG_KEY)
    })

    it.each([
      'EVT BOOT reset=poweron ver=0.3.1',
      'EVT CRASH reason=panic',
      'EVT USB_HOST=1',
      'EVT BUS5V on',
      'EVT ETH_PROBE_OK',
      'EVT ETH_CONNECTED ip=192.0.2.10',
      'EVT ETH_DISCONNECTED',
      'EVT ETH NG code=3',
      'EVT WS_CONNECTED',
      'EVT WS_DISCONNECTED',
      'EVT WS_STALE_RESTART',
      'EVT WS_DROPPED code=1006',
      'EVT WS_REBOOT_CMD',
      'EVT NFC_INIT_NG',
      'EVT NFC_READY',
      'EVT ALARM_RESTORED',
      'EVT OTA OK ver=0.3.2',
      'EVT OTA NG reason=hash',
    ])('許可リストの行 (%s) は `dev <行>` で残し、配送も続ける', async (line) => {
      const dev = createMockPort()
      await connectWithJson(dev)
      const events: string[] = []
      core.onEvent(name => events.push(name))

      dev.emit(`${line}\n`)
      await vi.advanceTimersByTimeAsync(0)

      expect(await diag()).toContain(`dev ${line}`)
      expect(events).toHaveLength(1)
    })

    it.each([
      'EVT TENKO_SESSION abc',
      'EVT NFC_LICENSE issue=20230401 expiry=20280401',
      'EVT BATT 87',
      'EVT WS_COMMAND 1 {"action":"get_log"}',
      'EVT ALARM idle none',
    ])('許可リスト外の行 (%s) は残さない', async (line) => {
      const dev = createMockPort()
      await connectWithJson(dev)

      dev.emit(`${line}\n`)
      await vi.advanceTimersByTimeAsync(100)

      expect((await diag()).filter(l => l.startsWith('dev '))).toEqual([])
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

  // ---------- 意図した reload (alc-app-s3#192) ----------

  describe('sendGrace', () => {
    it('接続中なら HB OK grace=45 を 1 行書く (周期の HB OK はそのまま)', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)

      core.sendGrace()
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes).toEqual(['STATUS\n', 'HB OK\n', 'HB OK grace=45\n'])

      await vi.advanceTimersByTimeAsync(3000)
      expect(dev.writes.at(-1)).toBe('HB OK\n')
    })

    it('未接続なら何も書かない (落ちない)', async () => {
      installSerialMock({ getPorts: vi.fn(async () => []) })
      await load()

      core.sendGrace()
      await vi.advanceTimersByTimeAsync(0)
      expect(core.isConnected.value).toBe(false)
    })
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

    it('書き込み失敗で返したときは診断ログに reason=write_failed を残す', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)
      dev.setWriteError(true)

      await core.write('{"cmd":"reset"}')

      const { readDiag } = await import('~/utils/serialDiagLog')
      expect(readDiag().some(line => line.endsWith('close port of cores3: release(cores3) reason=write_failed'))).toBe(true)
    })
  })

  // ---------- get_log の問い合わせ (Refs ippoan/alc-app#223) ----------

  /**
   * CoreS3 は遠隔の `get_log` を `EVT WS_COMMAND <id> <payload>` で PWA に問い合わせる。
   * PWA は置き場 (alc_serial_diag) の行を `PWALOG <id> <行>` で返し `PWALOG END <id> <n>` で閉じる。
   */
  describe('get_log', () => {
    const DIAG_KEY = 'alc_serial_diag'

    function setDiag(lines: string[]): void {
      localStorage.setItem(DIAG_KEY, JSON.stringify(lines))
    }

    function getLog(id: string): string {
      return `EVT WS_COMMAND ${id} {"action":"get_log","lines":40}\n`
    }

    function replies(dev: MockPortHandle): string[] {
      return dev.writes.filter(line => line.startsWith('PWALOG '))
    }

    beforeEach(() => {
      localStorage.removeItem(DIAG_KEY)
    })

    afterEach(() => {
      localStorage.removeItem(DIAG_KEY)
    })

    it('PWALOG <id> <行> を古い順に 10 ms 間隔で送り、PWALOG END <id> <n> で閉じる', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)
      const events: string[] = []
      core.onEvent(name => events.push(name))
      setDiag(['a', 'b', 'c'])

      dev.emit(getLog('42'))
      await vi.advanceTimersByTimeAsync(0)
      expect(replies(dev)).toEqual(['PWALOG 42 a\n'])

      await vi.advanceTimersByTimeAsync(10)
      expect(replies(dev)).toEqual(['PWALOG 42 a\n', 'PWALOG 42 b\n'])

      await vi.advanceTimersByTimeAsync(20)
      expect(replies(dev)).toEqual(['PWALOG 42 a\n', 'PWALOG 42 b\n', 'PWALOG 42 c\n', 'PWALOG END 42 3\n'])
      // 既存の EVT の配送は変えない
      expect(events).toEqual(['WS_COMMAND'])
    })

    it('置き場が空なら PWALOG END <id> 0 だけ', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)
      localStorage.removeItem(DIAG_KEY)

      dev.emit(getLog('7'))
      await vi.advanceTimersByTimeAsync(100)

      expect(replies(dev)).toEqual(['PWALOG END 7 0\n'])
    })

    it('最大 40 行 (新しい行を優先し、送る順は古い順)', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)
      setDiag(Array.from({ length: 50 }, (_, i) => `l${i}`))

      dev.emit(getLog('1'))
      await vi.advanceTimersByTimeAsync(1000)

      const sent = replies(dev)
      expect(sent).toHaveLength(41)
      expect(sent[0]).toBe('PWALOG 1 l10\n')
      expect(sent[39]).toBe('PWALOG 1 l49\n')
      expect(sent[40]).toBe('PWALOG END 1 40\n')
    })

    it('合計 1200 バイト (UTF-8) に収まる分だけ (新しい行を優先)', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)
      // 1 行 = 3 + 3×49 = 150 バイト (52 文字)。8 行でちょうど 1200 バイト
      setDiag(Array.from({ length: 10 }, (_, i) => `${String(i).padStart(3, '0')}${'あ'.repeat(49)}`))

      dev.emit(getLog('9'))
      await vi.advanceTimersByTimeAsync(1000)

      const sent = replies(dev)
      expect(sent).toHaveLength(9)
      expect(sent[0]!.startsWith('PWALOG 9 002')).toBe(true)
      expect(sent[7]!.startsWith('PWALOG 9 009')).toBe(true)
      expect(sent[8]).toBe('PWALOG END 9 8\n')
    })

    it.each([
      ['他の action', 'EVT WS_COMMAND 1 {"action":"measure"}\n'],
      ['JSON でない payload', 'EVT WS_COMMAND 1 get_log\n'],
      ['payload が null', 'EVT WS_COMMAND 1 null\n'],
      ['payload が無い', 'EVT WS_COMMAND 1\n'],
      ['id が空', 'EVT WS_COMMAND  {"action":"get_log"}\n'],
      ['WS_COMMAND 以外の EVT', 'EVT OTHER 1 {"action":"get_log"}\n'],
    ])('%s では何も送らない', async (_label, line) => {
      const dev = createMockPort()
      await connectWithJson(dev)
      setDiag(['a'])

      dev.emit(line)
      await vi.advanceTimersByTimeAsync(100)

      expect(dev.writes).toEqual(['STATUS\n', 'HB OK\n'])
    })

    it('送信に失敗したら残りを打ち切り、ポートは返さない (release しない)', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)
      setDiag(['a', 'b', 'c'])
      dev.port.writable.getWriter().write.mockRejectedValueOnce(new Error('write failed'))

      dev.emit(getLog('5'))
      await vi.advanceTimersByTimeAsync(100)

      // 1 行目で失敗 → 残り (b, c, END) は送らない
      expect(replies(dev)).toEqual([])
      expect(core.isConnected.value).toBe(true)
      expect(dev.port.close).not.toHaveBeenCalled()

      // 接続は生きている (heartbeat が続く)
      await vi.advanceTimersByTimeAsync(3000)
      expect(dev.writes.at(-1)).toBe('HB OK\n')
    })

    it('返信の途中で別の id が来たら、古い返信を打ち切って新しい方に答える', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)
      setDiag(['a', 'b', 'c'])

      dev.emit(getLog('1'))
      await vi.advanceTimersByTimeAsync(0)
      dev.emit(getLog('2'))
      await vi.advanceTimersByTimeAsync(100)

      expect(replies(dev)).toEqual([
        'PWALOG 1 a\n',
        'PWALOG 2 a\n',
        'PWALOG 2 b\n',
        'PWALOG 2 c\n',
        'PWALOG END 2 3\n',
      ])
    })

    it('返信の途中でポートを失ったら止める', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)
      setDiag(['a', 'b', 'c'])

      dev.emit(getLog('3'))
      await vi.advanceTimersByTimeAsync(0)
      await core.release()
      await vi.advanceTimersByTimeAsync(100)

      expect(replies(dev)).toEqual(['PWALOG 3 a\n'])
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

    it('onOpen: 接続済みで登録するとその場で 1 回だけ呼び、掴み直したらまた 1 回 (Refs #238)', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)
      const opened: number[] = []

      core.onOpen(() => opened.push(1))
      expect(opened).toEqual([1])
      await vi.advanceTimersByTimeAsync(3000)
      expect(opened).toEqual([1])

      await core.release()
      dev.emit('{"type":"ready","version":"1.0.0"}\n')
      await vi.advanceTimersByTimeAsync(10000)
      expect(core.isConnected.value).toBe(true)
      expect(opened).toEqual([1, 1])
    })

    it('onOpen: 未接続で登録すると、接続したときに 1 回だけ呼ぶ', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      const opened: number[] = []

      core.onOpen(() => opened.push(1))
      expect(opened).toEqual([])

      dev.emit('{"type":"ready","version":"1.0.0"}\n')
      await connect()
      expect(opened).toEqual([1])
    })

    it('onOpen: 接続時の配布の中で登録した cb も 1 回だけ (登録時と接続時で 2 回にならない)', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      const inner: number[] = []
      core.onOpen(() => core.onOpen(() => inner.push(1)))

      dev.emit('{"type":"ready","version":"1.0.0"}\n')
      await connect()
      expect(inner).toEqual([1])
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

  // ---------- startupProbe (Refs ippoan/alc-app#238) ----------

  describe('startupProbe', () => {
    it('何度呼んでも 1 本で、claim されたら true', async () => {
      const dev = createMockPort()
      const getPorts = vi.fn(async () => [dev.port])
      installSerialMock({ getPorts })
      await load()
      dev.emit('{"type":"ready","version":"1.0.0"}\n')

      const first = core.startupProbe()
      expect(core.startupProbe()).toBe(first)
      // 別の呼び出し元 (別の useCoreS3Serial()) からも同じ 1 本
      expect(mod.useCoreS3Serial().startupProbe()).toBe(first)

      await vi.advanceTimersByTimeAsync(0)
      await expect(first).resolves.toBe(true)
      expect(core.isConnected.value).toBe(true)
      expect(getPorts).toHaveBeenCalledTimes(1)
    })

    it('claim されなければ 3 秒で false、以後は同じ 1 本を返して待たない', async () => {
      installSerialMock({ getPorts: vi.fn(async () => []) })
      await load()

      const first = core.startupProbe()
      let settled = false
      void first.then(() => { settled = true })

      await vi.advanceTimersByTimeAsync(2999)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(first).resolves.toBe(false)

      expect(core.startupProbe()).toBe(first)
    })

    it('接続済みなら待たずに true', async () => {
      const dev = createMockPort()
      await connectWithJson(dev)

      await expect(core.startupProbe()).resolves.toBe(true)
    })

    it('WebSerial 非対応なら探索せず即 false', async () => {
      await load()

      await expect(core.startupProbe()).resolves.toBe(false)
      expect(core.isConnected.value).toBe(false)
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

  // ---------- request (#213 CoreS3 自動端末登録) ----------

  describe('request', () => {
    it('行を書いて matchPrefix の応答で resolve する (arbiter.request を CLAIMANT_NAME で呼ぶ)', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      dev.emit('{"type":"ready"}\n')
      await connect()

      const p = core.request('AUTH TICKET', 'AUTH TICKET ', 10_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes.at(-1)).toBe('AUTH TICKET\n')

      dev.emit('AUTH TICKET tkt-1 EXPIRES=300\n')
      await vi.advanceTimersByTimeAsync(0)
      await expect(p).resolves.toBe('AUTH TICKET tkt-1 EXPIRES=300')
    })

    it('未接続なら reject する (ポートを預かっていない)', async () => {
      installSerialMock({ getPorts: vi.fn(async () => []) })
      await load()

      await expect(core.request('AUTH TICKET', 'AUTH TICKET ', 10_000)).rejects.toThrow()
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
