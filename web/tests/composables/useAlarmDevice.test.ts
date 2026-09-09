import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Mock SerialPort ---

interface MockPortHandle {
  port: any
  reader: any
  writer: any
  writes: string[]
  /** デバイスからの受信行を流す (未読なら queue に積まれる) */
  emit: (text: string) => void
  push: (chunk: { value?: Uint8Array; done: boolean }) => void
  setWriteError: (v: boolean) => void
}

function createMockPort(options?: {
  readable?: boolean
  writable?: boolean
  vid?: number
  openError?: Error
  writeError?: boolean
  closeError?: boolean
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
    open: vi.fn(async () => {
      if (options?.openError) throw options.openError
    }),
    close: vi.fn(async () => {
      if (options?.closeError) throw new Error('close failed')
    }),
    readable: options?.readable === false ? null : { getReader: vi.fn(() => reader) },
    writable: options?.writable === false ? null : { getWriter: vi.fn(() => writer) },
    getInfo: vi.fn(() => ({ usbVendorId: options?.vid ?? 0x303A, usbProductId: 0x1001 })),
  }

  return {
    port,
    reader,
    writer,
    writes,
    emit: (text: string) => push({ value: new TextEncoder().encode(text), done: false }),
    push,
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

describe('useAlarmDevice', () => {
  let mod: typeof import('~/composables/useAlarmDevice')
  let alarm: ReturnType<typeof mod.useAlarmDevice>

  /** heartbeat の中身の素 (useActiveRooms の state)。既定は「購読中・着信なし」 */
  function setRooms(opts: { watching?: boolean; rooms?: string[]; joined?: string | null } = {}) {
    useState<boolean>('active-rooms-watching').value = opts.watching ?? true
    useState<string[]>('active-rooms').value = opts.rooms ?? []
    useState<string | null>('active-rooms-joined').value = opts.joined ?? null
  }

  async function load() {
    vi.resetModules()
    mod = await import('~/composables/useAlarmDevice')
    // useState は Nuxt app に残るためテスト間で明示リセット
    setRooms()
    alarm = mod.useAlarmDevice()
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    delete (navigator as any).serial
  })

  afterEach(async () => {
    await alarm?.disconnect()
    delete (navigator as any).serial
    vi.useRealTimers()
  })

  // ---------- isSupported ----------

  describe('WebSerial 非対応', () => {
    it('isSupported=false / connect しても何もしない', async () => {
      await load()
      expect(alarm.isSupported).toBe(false)
      alarm.connect()
      await vi.advanceTimersByTimeAsync(20000)
      expect(alarm.isConnected.value).toBe(false)
    })
  })

  // ---------- 探索 ----------

  describe('探索', () => {
    it('引数なしなら 5 秒待ってから探索する (BLE GW に先に選ばせる)', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      alarm.connect()

      await vi.advanceTimersByTimeAsync(4999)
      expect(dev.port.open).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(dev.port.open).toHaveBeenCalledTimes(1)
    })

    it('connect(0) なら待たずに探索する (BLE GW と同居しない管理者 PC)', async () => {
      const dev = createMockPort()
      dev.emit('EVT ALARM state=idle cause=none\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      alarm.connect(0)

      await vi.advanceTimersByTimeAsync(0)
      expect(dev.port.open).toHaveBeenCalledTimes(1)
      expect(alarm.isConnected.value).toBe(true)
    })

    it('EVT ALARM 行 → 採用して接続', async () => {
      const dev = createMockPort()
      dev.emit('EVT ALARM state=alarming cause=silence\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)

      expect(alarm.isConnected.value).toBe(true)
      expect(alarm.deviceState.value).toEqual({ state: 'alarming', cause: 'silence' })
      expect(dev.writes[0]).toBe('STATUS\n')
    })

    it('STATUS alarm 行 → 採用し、state/cause 以外のトークンは無視する', async () => {
      const dev = createMockPort()
      dev.emit('STATUS alarm state=muted cause=ng:fc1200 hb_age_ms=1200 VER=0.1.0\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)

      expect(alarm.isConnected.value).toBe(true)
      expect(alarm.deviceState.value).toEqual({ state: 'muted', cause: 'ng:fc1200' })
    })

    it('state= の無い行でも採用はするが deviceState は更新しない', async () => {
      const dev = createMockPort()
      dev.emit('EVT ALARM\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)

      expect(alarm.isConnected.value).toBe(true)
      expect(alarm.deviceState.value).toBeNull()
    })

    it('EVT BOOT など他の行は判定材料にしない (後続の EVT ALARM で採用)', async () => {
      const dev = createMockPort()
      dev.emit('EVT BOOT ver=0.1.0\n\nEVT ALARM state=idle cause=none\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)

      expect(alarm.isConnected.value).toBe(true)
      expect(alarm.deviceState.value).toEqual({ state: 'idle', cause: 'none' })
    })

    it('値の無いチャンクは読み飛ばす', async () => {
      const dev = createMockPort()
      dev.push({ value: undefined, done: false })
      dev.emit('EVT ALARM state=idle cause=none\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)

      expect(alarm.isConnected.value).toBe(true)
    })

    it('採用後に別機種の行が来ても判定は覆らない', async () => {
      const dev = createMockPort()
      dev.emit('EVT ALARM state=idle cause=none\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)

      dev.emit('PONG\n')
      await vi.advanceTimersByTimeAsync(0)
      expect(alarm.isConnected.value).toBe(true)
    })

    it('VID が 0x303A でないポートは触らない', async () => {
      const other = createMockPort({ vid: 0x1A86 })
      installSerialMock({ getPorts: vi.fn(async () => [other.port]) })
      await load()
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)

      expect(other.port.open).not.toHaveBeenCalled()
      expect(alarm.isConnected.value).toBe(false)
    })

    it('InvalidStateError (他 composable が使用中) は除外せず次の候補へ', async () => {
      const busy = createMockPort({ openError: new DOMException('busy', 'InvalidStateError') })
      const dev = createMockPort()
      dev.emit('EVT ALARM state=idle cause=none\n')
      installSerialMock({ getPorts: vi.fn(async () => [busy.port, dev.port]) })
      await load()
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)

      expect(busy.port.open).toHaveBeenCalledTimes(1)
      expect(alarm.isConnected.value).toBe(true)
    })

    it('readable が無いポートは閉じて次へ', async () => {
      const broken = createMockPort({ readable: false })
      installSerialMock({ getPorts: vi.fn(async () => [broken.port]) })
      await load()
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)

      expect(broken.port.close).toHaveBeenCalled()
      expect(alarm.isConnected.value).toBe(false)
    })

    it('writable が無いポートは閉じて次へ', async () => {
      const broken = createMockPort({ writable: false })
      installSerialMock({ getPorts: vi.fn(async () => [broken.port]) })
      await load()
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)

      expect(broken.port.close).toHaveBeenCalled()
      expect(alarm.isConnected.value).toBe(false)
    })

    it('close が失敗しても落ちない', async () => {
      const broken = createMockPort({ readable: false, closeError: true })
      installSerialMock({ getPorts: vi.fn(async () => [broken.port]) })
      await load()
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)

      expect(alarm.isConnected.value).toBe(false)
    })
  })

  // ---------- STATUS プローブ ----------

  describe('STATUS プローブ', () => {
    it('1 秒ごとに最大 8 回送り、8 秒無応答なら閉じるが除外はしない', async () => {
      const silent = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [silent.port]) })
      await load()
      alarm.connect(0)

      await vi.advanceTimersByTimeAsync(0)
      expect(silent.writes).toEqual(['STATUS\n'])

      // 1 秒ごとに 8 回目まで送って打ち止め
      await vi.advanceTimersByTimeAsync(7000)
      expect(silent.writes).toHaveLength(8)

      // 7999ms 時点ではまだ諦めない
      await vi.advanceTimersByTimeAsync(999)
      expect(silent.port.close).not.toHaveBeenCalled()

      // 8 秒経過 → 諦めて close。送信は 8 回で止まったまま
      await vi.advanceTimersByTimeAsync(1)
      expect(silent.writes).toHaveLength(8)
      expect(silent.port.close).toHaveBeenCalledTimes(1)
      expect(alarm.isConnected.value).toBe(false)

      // 除外していない → 再スキャンで開き直す
      await vi.advanceTimersByTimeAsync(10000)
      expect(silent.port.open).toHaveBeenCalledTimes(2)
    })

    it('7999ms までは未確定 — 遅れて来た 5 秒ごとのバナーでも採用する', async () => {
      const late = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [late.port]) })
      await load()
      alarm.connect(0)

      await vi.advanceTimersByTimeAsync(7999)
      expect(alarm.isConnected.value).toBe(false)
      expect(late.port.close).not.toHaveBeenCalled()

      late.emit('EVT ALARM state=idle cause=none\n')
      await vi.advanceTimersByTimeAsync(0)
      expect(alarm.isConnected.value).toBe(true)
    })

    it('STATUS の write に失敗したら閉じるが除外はしない', async () => {
      const dev = createMockPort({ writeError: true })
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)

      expect(dev.port.close).toHaveBeenCalledTimes(1)
      expect(alarm.isConnected.value).toBe(false)

      await vi.advanceTimersByTimeAsync(10000)
      expect(dev.port.open).toHaveBeenCalledTimes(2)
    })
  })

  // ---------- 別機種の確定と除外 ----------

  describe('別機種の確定', () => {
    it.each([
      ['STATUS LAN=up VER=1.2.3\n', 'CoreS3 の STATUS'],
      ['PONG\n', 'PONG'],
      ['{"type":"ready","version":"1.0"}\n', 'JSON 行'],
    ])('%s → 除外して二度と開かない', async (line) => {
      const other = createMockPort()
      other.emit(line)
      installSerialMock({ getPorts: vi.fn(async () => [other.port]) })
      await load()
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)

      expect(other.port.close).toHaveBeenCalledTimes(1)
      expect(alarm.isConnected.value).toBe(false)

      await vi.advanceTimersByTimeAsync(10000)
      expect(other.port.open).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- 再スキャン ----------

  describe('再スキャン', () => {
    it('候補ゼロなら 10 秒ごとに探し直す', async () => {
      const getPorts = vi.fn(async () => [])
      installSerialMock({ getPorts })
      await load()
      alarm.connect()

      await vi.advanceTimersByTimeAsync(5000)
      expect(getPorts).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10000)
      expect(getPorts).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(10000)
      expect(getPorts).toHaveBeenCalledTimes(3)
    })

    it('接続済みなら再度 connect しても探索しない', async () => {
      const dev = createMockPort()
      dev.emit('EVT ALARM state=idle cause=none\n')
      const getPorts = vi.fn(async () => [dev.port])
      installSerialMock({ getPorts })
      await load()
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)
      expect(alarm.isConnected.value).toBe(true)

      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)
      expect(getPorts).toHaveBeenCalledTimes(1)
    })

    it('探索中に再入しない', async () => {
      // 無応答ポート 3 本 = 1 回の探索に 24 秒かかる
      const a = createMockPort()
      const b = createMockPort()
      const c = createMockPort()
      const getPorts = vi.fn(async () => [a.port, b.port, c.port])
      installSerialMock({ getPorts })
      await load()
      alarm.connect()

      await vi.advanceTimersByTimeAsync(5000)
      expect(getPorts).toHaveBeenCalledTimes(1)

      // 探索中に connect() → 5 秒後に走るが、まだ探索が終わっていないので何もしない
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)
      expect(getPorts).toHaveBeenCalledTimes(1)
    })

    it('connect を続けて呼んでも探索は 1 本だけ', async () => {
      const getPorts = vi.fn(async () => [])
      installSerialMock({ getPorts })
      await load()
      alarm.connect()
      alarm.connect()

      await vi.advanceTimersByTimeAsync(5000)
      expect(getPorts).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- heartbeat ----------

  describe('heartbeat', () => {
    async function connectDevice() {
      const dev = createMockPort()
      dev.emit('EVT ALARM state=idle cause=none\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      alarm.connect()
      await vi.advanceTimersByTimeAsync(5000)
      return dev
    }

    it('接続直後と 3 秒ごとに HB OK を送る (購読中・着信なし)', async () => {
      const dev = await connectDevice()
      expect(dev.writes).toEqual(['STATUS\n', 'HB OK\n'])

      await vi.advanceTimersByTimeAsync(3000)
      expect(dev.writes).toEqual(['STATUS\n', 'HB OK\n', 'HB OK\n'])

      await vi.advanceTimersByTimeAsync(3000)
      expect(dev.writes).toHaveLength(4)
    })

    it('room 購読が切れているとき HB NG signaling を送る', async () => {
      const dev = await connectDevice()
      setRooms({ watching: false })

      await vi.advanceTimersByTimeAsync(3000)
      expect(dev.writes.at(-1)).toBe('HB NG signaling\n')

      // 張り直せたら OK に戻る
      setRooms({ watching: true })
      await vi.advanceTimersByTimeAsync(3000)
      expect(dev.writes.at(-1)).toBe('HB OK\n')
    })

    it('room が立っていて管理者が未参加なら call=1 を付ける', async () => {
      const dev = await connectDevice()
      setRooms({ rooms: ['room-a'] })

      await vi.advanceTimersByTimeAsync(3000)
      expect(dev.writes.at(-1)).toBe('HB OK call=1\n')
    })

    it('管理者がどれかの room に入ったら call は付けない', async () => {
      const dev = await connectDevice()
      setRooms({ rooms: ['room-a'], joined: 'room-a' })

      await vi.advanceTimersByTimeAsync(3000)
      expect(dev.writes.at(-1)).toBe('HB OK\n')
    })

    it('room が空になったら call は付けない', async () => {
      const dev = await connectDevice()
      setRooms({ rooms: ['room-a'] })
      await vi.advanceTimersByTimeAsync(3000)
      expect(dev.writes.at(-1)).toBe('HB OK call=1\n')

      setRooms({ rooms: [] })
      await vi.advanceTimersByTimeAsync(3000)
      expect(dev.writes.at(-1)).toBe('HB OK\n')
    })

    it('購読が切れていても着信中なら call=1 は付く', async () => {
      const dev = await connectDevice()
      setRooms({ watching: false, rooms: ['room-a'] })

      await vi.advanceTimersByTimeAsync(3000)
      expect(dev.writes.at(-1)).toBe('HB NG signaling call=1\n')
    })

    it('write に失敗したら後始末して再スキャンへ', async () => {
      const dev = await connectDevice()
      dev.setWriteError(true)

      await vi.advanceTimersByTimeAsync(3000)
      expect(alarm.isConnected.value).toBe(false)
      expect(alarm.deviceState.value).toBeNull()
      expect(dev.port.close).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10000)
      expect(dev.port.open).toHaveBeenCalledTimes(2)
    })

    it('受信ループが終わったら (抜線) 後始末して再スキャンへ', async () => {
      const dev = await connectDevice()
      dev.push({ value: undefined, done: true })
      await vi.advanceTimersByTimeAsync(0)

      expect(alarm.isConnected.value).toBe(false)

      await vi.advanceTimersByTimeAsync(10000)
      expect(dev.port.open).toHaveBeenCalledTimes(2)
    })

    it('disconnect でタイマーが止まり、以後送らない', async () => {
      const dev = await connectDevice()
      await alarm.disconnect()

      expect(alarm.isConnected.value).toBe(false)
      const sent = dev.writes.length
      await vi.advanceTimersByTimeAsync(30000)
      expect(dev.writes).toHaveLength(sent)
      expect(dev.port.open).toHaveBeenCalledTimes(1)
    })

    it('未接続のまま disconnect しても落ちない', async () => {
      installSerialMock({ getPorts: vi.fn(async () => []) })
      await load()
      await alarm.disconnect()
      expect(alarm.isConnected.value).toBe(false)
    })
  })

  // ---------- requestPort ----------

  describe('requestPort', () => {
    it('許可されたら探索を始める', async () => {
      const dev = createMockPort()
      dev.emit('EVT ALARM state=idle cause=none\n')
      const getPorts = vi.fn(async () => [dev.port])
      installSerialMock({ requestPort: vi.fn(async () => dev.port), getPorts })
      await load()

      await alarm.requestPort()
      await vi.advanceTimersByTimeAsync(5000)
      expect(alarm.isConnected.value).toBe(true)
    })

    it('キャンセルされたら探索しない', async () => {
      const getPorts = vi.fn(async () => [])
      installSerialMock({
        requestPort: vi.fn(async () => { throw new DOMException('cancelled', 'NotFoundError') }),
        getPorts,
      })
      await load()

      await alarm.requestPort()
      await vi.advanceTimersByTimeAsync(20000)
      expect(getPorts).not.toHaveBeenCalled()
    })
  })
})
