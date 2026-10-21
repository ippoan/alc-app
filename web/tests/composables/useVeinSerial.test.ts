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
  async function connectDevice(dev: MockPortHandle, omronReply: string | null = 'OMRON BP=0\n') {
    installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
    await load()
    dev.emit('DEVICE timecard VER=0.1.0\n')
    expect(await connect()).toBe(true)
    // つながると機体の血圧計の設定を聞く (`OMRON STATUS`)。応答を返して枠を空ける
    if (omronReply !== null) {
      await vi.advanceTimersByTimeAsync(0)
      dev.emit(omronReply)
      await vi.advanceTimersByTimeAsync(0)
    }
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

  // ---------- omronBp (機体の設定で血圧計を使うか、Refs ippoan/alc-app#436) ----------

  describe('omronBp', () => {
    it('つながると OMRON STATUS を聞き、OMRON BP=1 なら true', async () => {
      const dev = createMockPort()
      await connectDevice(dev, 'OMRON BP=1\n')

      expect(dev.writes).toContain('OMRON STATUS\n')
      expect(vein.omronBp.value).toBe(true)
    })

    it('OMRON BP=0 なら false', async () => {
      const dev = createMockPort()
      await connectDevice(dev, 'OMRON BP=0\n')

      expect(vein.omronBp.value).toBe(false)
    })

    it('値が 0/1 でない応答は分からないまま (null)', async () => {
      const dev = createMockPort()
      await connectDevice(dev, 'OMRON BP=x\n')

      expect(vein.omronBp.value).toBeNull()
    })

    it('旧ファームで応答が無ければ null のまま', async () => {
      const dev = createMockPort()
      await connectDevice(dev, 'ERR OMRON: unsupported\n')
      await vi.advanceTimersByTimeAsync(5000)

      expect(vein.omronBp.value).toBeNull()
    })

    it('鍵の署名 (AUTH SIGN) が先に枠を取っていたら、空いてから聞き直す', async () => {
      const dev = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      // useDeviceToken と同じ: つながった瞬間 (同期) に署名を頼む
      const stop = watch(vein.isConnected, (connected) => {
        if (connected) void vein.request('AUTH SIGN n', 'AUTH SIG', 10000).catch(() => {})
      }, { flush: 'sync' })
      dev.emit('DEVICE timecard VER=0.1.0\n')
      expect(await connect()).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      // 署名の応答待ちが塞いでいるあいだ、問い合わせは送られない
      expect(dev.writes.at(-1)).toBe('AUTH SIGN n\n')
      expect(dev.writes).not.toContain('OMRON STATUS\n')

      dev.emit('AUTH SIG pk sg\n')
      await vi.advanceTimersByTimeAsync(300)
      expect(dev.writes.at(-1)).toBe('OMRON STATUS\n')
      dev.emit('OMRON BP=1\n')
      await vi.advanceTimersByTimeAsync(0)
      expect(vein.omronBp.value).toBe(true)
      stop()
    })

    it('切断で null に戻り、切断をまたいだ古い応答では書かない', async () => {
      const dev = createMockPort()
      await connectDevice(dev, 'OMRON BP=1\n')
      expect(vein.omronBp.value).toBe(true)

      await vein.disconnect()
      expect(vein.omronBp.value).toBeNull()
    })

    it('切断で応答待ちが落ちても null のまま (エラーを外へ出さない)', async () => {
      const dev = createMockPort()
      await connectDevice(dev, null)
      await vein.disconnect()
      await vi.advanceTimersByTimeAsync(5000)

      expect(vein.omronBp.value).toBeNull()
    })

    it('noteOmronBp: 端末設定で ON/OFF が通ったら値を合わせる', async () => {
      const dev = createMockPort()
      await connectDevice(dev, 'OMRON BP=0\n')

      vein.noteOmronBp(true)
      expect(vein.omronBp.value).toBe(true)
      vein.noteOmronBp(false)
      expect(vein.omronBp.value).toBe(false)
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

  describe('onFingerPlaced (EVT VEIN FINGER)', () => {
    it('EVT VEIN FINGER で cb を呼ぶ。UNSUPPORTED・他の EVT では呼ばない', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const cb = vi.fn()
      vein.onFingerPlaced(cb)

      dev.emit('EVT VEIN FINGER UNSUPPORTED\nEVT VEIN OTHER\nEVT FC1200 FINGER\nEVT VEIN\n')
      await vi.advanceTimersByTimeAsync(0)
      expect(cb).not.toHaveBeenCalled()

      dev.emit('EVT VEIN FINGER\n')
      await vi.advanceTimersByTimeAsync(0)
      expect(cb).toHaveBeenCalledTimes(1)
    })

    it('返り値で解除すると、以後は呼ばれない', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const cb = vi.fn()
      const off = vein.onFingerPlaced(cb)

      off()
      dev.emit('EVT VEIN FINGER\n')
      await vi.advanceTimersByTimeAsync(0)
      expect(cb).not.toHaveBeenCalled()
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

  // ---------- 照合をモジュールに任せる口 (M-b、Refs ippoan/alc-app#436) ----------

  /** 応答を 1 行流して処理させる */
  async function reply(dev: MockPortHandle, text: string) {
    await vi.advanceTimersByTimeAsync(0)
    dev.emit(text)
    await vi.advanceTimersByTimeAsync(0)
  }

  describe('enroll', () => {
    it('VEIN RECORD の行を END まで集め、offset 順に 1 つの記録にする。置き直しの案内を onPlace へ', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const places: number[] = []
      const p = vein.enroll(10, n => places.push(n))
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes.at(-1)).toBe('VEIN ENROLL 10\n')

      // 置き直しの案内 (形の違う EVT は数えない)
      await reply(dev, 'EVT VEIN PLACE 2\nEVT VEIN PLACE\nEVT VEIN FOO 3\nEVT NFC PLACE 9\nEVT VEIN PLACE 3\n')
      // 後ろの塊が先に来ても・前のログ行に連結されても拾う。ほかの ID の行は混ぜない
      await reply(dev, 'VEIN RECORD 11 0 FFFF\nVEIN RECORD 10 2 dead\nEVT NFC_READY VEIN RECORD 10 0 DEED\nVEIN RECORD 10 END 4\n')
      await expect(p).resolves.toEqual(new Uint8Array([0xDE, 0xED, 0xDE, 0xAD]))
      expect(places).toEqual([2, 3])
    })

    it('onPlace を渡さなくてもよい。END の後の行は集めない', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const p = vein.enroll(100)
      await reply(dev, 'EVT VEIN PLACE 2\nVEIN RECORD 100 0 0102\nVEIN RECORD 100 END 2\n')
      await expect(p).resolves.toEqual(new Uint8Array([1, 2]))
      // 終わった後の行は onLine へ流れるだけ
      dev.emit('VEIN RECORD 100 0 0304\n')
      await vi.advanceTimersByTimeAsync(0)
    })

    it('ERR VEIN RETAKE は reason RETAKE の Error', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const p = vein.enroll(10)
      const assertion = expect(p).rejects.toThrow('RETAKE')
      await reply(dev, 'EVT VEIN PLACE 2\nERR VEIN RETAKE\n')
      await assertion
    })

    it.each([
      ['offset が数字でない', 'VEIN RECORD 10 X DEED\nVEIN RECORD 10 END 2\n'],
      ['hex が無い', 'VEIN RECORD 10 0\nVEIN RECORD 10 END 2\n'],
      ['hex が 16 進でない', 'VEIN RECORD 10 0 ZZZZ\nVEIN RECORD 10 END 2\n'],
      ['hex が奇数桁', 'VEIN RECORD 10 0 ABC\nVEIN RECORD 10 END 2\n'],
      ['offset に隙間がある', 'VEIN RECORD 10 0 DE\nVEIN RECORD 10 2 DE\nVEIN RECORD 10 END 3\n'],
      ['総バイト数を超える', 'VEIN RECORD 10 0 DEEDDEED\nVEIN RECORD 10 END 2\n'],
      ['総バイト数に足りない', 'VEIN RECORD 10 0 DE\nVEIN RECORD 10 END 2\n'],
      ['総バイト数が 0', 'VEIN RECORD 10 END 0\n'],
      ['総バイト数が数字でない', 'VEIN RECORD 10 0 DE\nVEIN RECORD 10 END x\n'],
    ])('%s → RECORD_BROKEN', async (_name, lines) => {
      const dev = createMockPort()
      await connectDevice(dev)
      const p = vein.enroll(10)
      const assertion = expect(p).rejects.toThrow(mod.VEIN_RECORD_BROKEN)
      await reply(dev, lines)
      await assertion
    })
  })

  describe('identify', () => {
    it('VEIN IDENTIFIED <id> は ID、VEIN NOMATCH は null', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const hit = vein.identify()
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes.at(-1)).toBe('VEIN IDENTIFY\n')
      await reply(dev, 'EVT VEIN FINGER\nVEIN IDENTIFIED 12\n')
      await expect(hit).resolves.toBe(12)

      const miss = vein.identify()
      await reply(dev, 'VEIN NOMATCH\n')
      await expect(miss).resolves.toBeNull()
    })

    it('ERR VEIN <reason> は reason の Error、読めない ID も Error', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const err = vein.identify()
      const a1 = expect(err).rejects.toThrow(/^NO_MODULE$/)
      await reply(dev, 'ERR VEIN NO_MODULE\n')
      await a1

      const bad = vein.identify()
      const a2 = expect(bad).rejects.toThrow('IDENTIFY の応答が読めません')
      await reply(dev, 'VEIN IDENTIFIED x\n')
      await a2
    })

    it('ほかの要求の応答待ちで弾かれたら、空くまで呼び直す', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const sign = vein.request('AUTH SIGN abc', 'AUTH SIG', 5_000)
      await vi.advanceTimersByTimeAsync(0)
      const p = vein.identify()
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes).not.toContain('VEIN IDENTIFY\n')
      dev.emit('AUTH SIG pk sg\n')
      await vi.advanceTimersByTimeAsync(0)
      await expect(sign).resolves.toBe('AUTH SIG pk sg')
      await vi.advanceTimersByTimeAsync(200)
      expect(dev.writes.at(-1)).toBe('VEIN IDENTIFY\n')
      await reply(dev, 'VEIN NOMATCH\n')
      await expect(p).resolves.toBeNull()
    })

    it('呼び直しを待つ間に錠が掛かったら送らずに断る', async () => {
      const { OTA_LOCKED_MESSAGE } = await import('~/composables/useCoreS3Serial')
      const dev = createMockPort()
      await connectDevice(dev)
      const sign = vein.request('AUTH SIGN abc', 'AUTH SIG', 5_000)
      await vi.advanceTimersByTimeAsync(0)
      const p = vein.identify()
      const assertion = expect(p).rejects.toThrow(OTA_LOCKED_MESSAGE)
      await vi.advanceTimersByTimeAsync(0)
      vein.ota.begin()
      dev.emit('AUTH SIG pk sg\n')
      await vi.advanceTimersByTimeAsync(200)
      await assertion
      await sign
      expect(dev.writes).not.toContain('VEIN IDENTIFY\n')
      vein.ota.end()
    })
  })

  describe('syncWrite / syncClear', () => {
    it('192 バイトずつ送って応答を待ち、END で書かせる', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const record = new Uint8Array(200).map((_, i) => i)
      const p = vein.syncWrite(10, record)
      await vi.advanceTimersByTimeAsync(0)
      const first = dev.writes.at(-1)!
      expect(first.startsWith('VEIN SYNC WRITE 10 0 000102')).toBe(true)
      expect(first.length).toBe('VEIN SYNC WRITE 10 0 '.length + 192 * 2 + 1)
      await reply(dev, 'VEIN SYNC WRITE 10 192\n')
      expect(dev.writes.at(-1)).toBe('VEIN SYNC WRITE 10 192 C0C1C2C3C4C5C6C7\n')
      await reply(dev, 'VEIN SYNC WRITE 10 200\n')
      expect(dev.writes.at(-1)).toBe('VEIN SYNC WRITE 10 END\n')
      await reply(dev, 'VEIN SYNC WRITTEN 10 200\n')
      await expect(p).resolves.toBeUndefined()
    })

    it('次の offset が合わなければ WRITE_SEQ、機体の失敗は reason のまま', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const p1 = vein.syncWrite(10, new Uint8Array([1, 2]))
      const a1 = expect(p1).rejects.toThrow('WRITE_SEQ')
      await reply(dev, 'VEIN SYNC WRITE 10 1\n')
      await a1

      const p2 = vein.syncWrite(10, new Uint8Array([1, 2]))
      const a2 = expect(p2).rejects.toThrow(/^WRITE_HEADER$/)
      await reply(dev, 'VEIN SYNC WRITE 10 2\n')
      await reply(dev, 'ERR VEIN WRITE_HEADER\n')
      await a2
    })

    it('syncClear は VEIN SYNC CLEARED <id> で成功、失敗は reason', async () => {
      const dev = createMockPort()
      await connectDevice(dev)
      const ok = vein.syncClear(42)
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes.at(-1)).toBe('VEIN SYNC CLEAR 42\n')
      await reply(dev, 'VEIN SYNC CLEARED 42\n')
      await expect(ok).resolves.toBeUndefined()

      const ng = vein.syncClear(42)
      const assertion = expect(ng).rejects.toThrow(/^RC=01$/)
      await reply(dev, 'ERR VEIN RC=01\n')
      await assertion
    })
  })
})
