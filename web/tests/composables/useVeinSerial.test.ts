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

    // 抜線で JWT キャッシュを捨てるための口 (Refs ippoan/alc-app#436)
    it('onClose に登録した cb はポートを失ったときに呼ばれる', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const cb = vi.fn()
      vein.onClose(cb)
      expect(cb).not.toHaveBeenCalled()

      await vein.disconnect()
      expect(cb).toHaveBeenCalledTimes(1)
    })

    // 機体が自分で打刻を送るかを FLAVOR で決める (Refs ippoan/alc-app#436)
    it('名乗りの FLAVOR を deviceInfo に持ち、ポートを失ったら null に戻す', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      expect(vein.deviceInfo.value).toBeNull()
      dev.emit('DEVICE timecard VER=0.1.0 FLAVOR=timecard-vein\n')
      expect(await connect()).toBe(true)
      expect(vein.deviceInfo.value).toEqual({ ver: '0.1.0', board: null, flavor: 'timecard-vein' })

      await vein.disconnect()
      expect(vein.deviceInfo.value).toBeNull()
    })
  })

  // ---------- EVT / JSON の配布 (Refs ippoan/alc-app#436) ----------
  // Port A の NFC ユニットと RS232 の FC-1200 の行を、CoreS3 と同じ形で配る

  describe('onEvent / onJson', () => {
    it('EVT は名前と引数に割って、JSON は読んで配る', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const events: Array<[string, string[]]> = []
      const jsons: unknown[] = []
      vein.onEvent((name, args) => events.push([name, args]))
      vein.onJson(msg => jsons.push(msg))

      dev.emit('EVT NFC_LICENSE issue=20230401 expiry=20280401\n')
      dev.emit('EVT FC1200 BLOW_WAITING\n')
      dev.emit('{"type":"alcohol","value":0.1,"result":"normal"}\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(events).toEqual([
        ['NFC_LICENSE', ['issue=20230401', 'expiry=20280401']],
        ['FC1200', ['BLOW_WAITING']],
      ])
      expect(jsons).toEqual([{ type: 'alcohol', value: 0.1, result: 'normal' }])
    })

    it('プローブ中に来ていた EVT も接続時に配る', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      const events: string[] = []
      vein.onEvent(name => events.push(name))

      dev.emit('EVT FC1200 WARMING 120 5\nDEVICE timecard VER=0.1.0\n')
      expect(await connect()).toBe(true)

      expect(events).toEqual(['FC1200'])
    })

    it('capture / say の応答は配らない (EVT でも JSON でもない)', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const seen: unknown[] = []
      vein.onEvent((name, args) => seen.push([name, args]))
      vein.onJson(msg => seen.push(msg))

      const p = vein.capture()
      await vi.advanceTimersByTimeAsync(0)
      dev.emit('VEIN CHARA 0a1b\nOK VEIN SAY PLACE\nERR VEIN TIMEOUT\n')
      await vi.advanceTimersByTimeAsync(0)
      await expect(p).resolves.toBe('0a1b')

      expect(seen).toEqual([])
    })

    it('onEvent の返り値で購読を解除できる / 壊れた JSON は捨てる', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const events: string[] = []
      const jsons: unknown[] = []
      const off = vein.onEvent(name => events.push(name))
      vein.onJson(msg => jsons.push(msg))

      off()
      dev.emit('EVT NFC_READY\n{"type":\n')
      await vi.advanceTimersByTimeAsync(0)

      expect(events).toEqual([])
      expect(jsons).toEqual([])
      expect(warn).toHaveBeenCalledWith('[VEIN] Invalid JSON:', '{"type":')
      warn.mockRestore()
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

  // ---------- request (鍵の署名の口、Refs ippoan/alc-app#436) ----------

  describe('request', () => {
    it('行を預かったポートへ撃ち、ERR <先頭トークン> で失敗を拾う', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      const ok = vein.request('AUTH SIGN abc', 'AUTH SIG', 5_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes.at(-1)).toBe('AUTH SIGN abc\n')
      dev.emit('AUTH SIG pub sig\n')
      await vi.advanceTimersByTimeAsync(0)
      await expect(ok).resolves.toBe('AUTH SIG pub sig')

      const ng = vein.request('DEVICE', 'DEVICE ', 5_000)
      const assertion = expect(ng).rejects.toThrow('ERR DEVICE busy')
      await vi.advanceTimersByTimeAsync(0)
      dev.emit('ERR DEVICE busy\n')
      await vi.advanceTimersByTimeAsync(0)
      await assertion
    })
  })

  // ---------- ota (書き込み中の錠、Refs ippoan/alc-app-s3#279, ippoan/alc-app#436) ----------

  describe('ota', () => {
    it('ota.request は行を預かったポートへ撃ち、errPrefix 付きで応答を待つ', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      const p = vein.ota.request('OTA CONFIRM', 'OTA CONFIRMED', 5_000, 'OTA ERR')
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes.at(-1)).toBe('OTA CONFIRM\n')

      dev.emit('OTA CONFIRMED\n')
      await vi.advanceTimersByTimeAsync(0)
      await expect(p).resolves.toBe('OTA CONFIRMED')
    })

    it('ota.request のバイト列は改行を足さずに書き、OTA ERR で reject する', async () => {
      const dev = createMockPort()
      await connectDevice(dev)

      const p = vein.ota.request(new Uint8Array([0x41, 0x42, 0x43]), 'OTA ACK', 5_000, 'OTA ERR')
      const assertion = expect(p).rejects.toThrow('OTA ERR write')
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes.at(-1)).toBe('ABC')

      dev.emit('OTA ERR write\n')
      await vi.advanceTimersByTimeAsync(0)
      await assertion
    })

    it('錠の間は request・capture・say を送らずに断り、ota.request だけが通る。外したらまた通る', async () => {
      const { OTA_LOCKED_MESSAGE } = await import('~/composables/useCoreS3Serial')
      const dev = createMockPort()
      await connectDevice(dev)
      const before = dev.writes.length

      vein.ota.begin()
      await expect(vein.request('AUTH SIGN abc', 'AUTH SIG', 5_000)).rejects.toThrow(OTA_LOCKED_MESSAGE)
      await expect(vein.capture()).rejects.toThrow(OTA_LOCKED_MESSAGE)
      await expect(vein.say('PLACE')).rejects.toThrow(OTA_LOCKED_MESSAGE)
      expect(dev.writes.length).toBe(before)

      const ota = vein.ota.request('DEVICE', 'DEVICE ', 5_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes.at(-1)).toBe('DEVICE\n')
      dev.emit('DEVICE timecard VER=0.1.0 FLAVOR=timecard-vein\n')
      await vi.advanceTimersByTimeAsync(0)
      await expect(ota).resolves.toBe('DEVICE timecard VER=0.1.0 FLAVOR=timecard-vein')

      vein.ota.end()
      const p = vein.say('PLACE')
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes.at(-1)).toBe('VEIN SAY PLACE\n')
      dev.emit('OK VEIN SAY PLACE\n')
      await vi.advanceTimersByTimeAsync(0)
      await expect(p).resolves.toBeUndefined()
      // 掛かっていないときに外しても害は無い
      vein.ota.end()
    })
  })
})
