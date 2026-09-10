import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SerialClaimant } from '~/composables/useSerialArbiter'

// --- Mock SerialPort (useAlarmDevice.test.ts と同形) ---

interface MockPortHandle {
  port: any
  writes: string[]
  /** setSignals (引数つき) / close の呼び出し順 (ESP32-S3 のリセット回避の検証に使う) */
  calls: string[]
  /** デバイスからの受信行を流す (未読なら queue に積まれる) */
  emit: (text: string) => void
  push: (chunk: { value?: Uint8Array; done: boolean }) => void
}

function createMockPort(options?: {
  readable?: boolean
  writable?: boolean
  vid?: number
  openError?: Error
  writeError?: boolean
  /** setSignals 非対応のポート (古い Chrome / 一部ドライバ) を模す */
  signalsError?: boolean
  /** 1 回目の setSignals (RTS) だけ失敗するポートを模す */
  firstSignalsError?: boolean
}): MockPortHandle {
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
      if (options?.writeError) throw new Error('write failed')
      writes.push(new TextDecoder().decode(data))
    }),
    releaseLock: vi.fn(),
  }

  const calls: string[] = []
  let signalsCalls = 0
  const port = {
    open: vi.fn(async () => {
      if (options?.openError) throw options.openError
    }),
    setSignals: vi.fn(async (signals: { dataTerminalReady?: boolean; requestToSend?: boolean }) => {
      signalsCalls += 1
      // 引数まで記録する — RTS → DTR の順序が S3 のリセット回避の本体なので
      calls.push(`setSignals(${JSON.stringify(signals)})`)
      if (options?.signalsError) throw new Error('setSignals unsupported')
      if (options?.firstSignalsError && signalsCalls === 1) throw new Error('setSignals failed')
    }),
    close: vi.fn(async () => {
      calls.push('close')
    }),
    readable: options?.readable === false ? null : { getReader: vi.fn(() => reader) },
    writable: options?.writable === false ? null : { getWriter: vi.fn(() => writer) },
    getInfo: vi.fn(() => ({ usbVendorId: options?.vid ?? 0x303A, usbProductId: 0x1001 })),
  }

  return {
    port,
    writes,
    calls,
    emit: (text: string) => push({ value: new TextEncoder().encode(text), done: false }),
    push,
  }
}

function installSerialMock(serialMock: {
  requestPort?: ReturnType<typeof vi.fn>
  getPorts?: ReturnType<typeof vi.fn>
}) {
  // navigator.serial は本物同様 EventTarget にしておく — addEventListener /
  // dispatchEvent が実際に効く形にすることで、Refs ippoan/alc-app#221 の
  // connect 購読 (onPortConnected) をそのまま検証できる
  Object.defineProperty(navigator, 'serial', {
    value: Object.assign(new EventTarget(), {
      requestPort: serialMock.requestPort ?? vi.fn(),
      getPorts: serialMock.getPorts ?? vi.fn(async () => []),
    }),
    configurable: true,
    writable: true,
  })
}

/**
 * `navigator.serial` へ `connect` イベントを流す (Refs ippoan/alc-app#221)。
 *
 * Web Serial の `connect` は SerialPort で発火して navigator.serial へ bubble
 * するため、本物の `target` は挿されたポート自身になる。plain `EventTarget` に
 * `dispatchEvent` させると target は dispatch した相手 (navigator.serial) に
 * なってしまうので、`target` を挿し直したポートへ差し替えてから配る。
 */
function emitConnect(port: any): void {
  const ev = new Event('connect')
  Object.defineProperty(ev, 'target', { value: port, configurable: true })
  ;(navigator as any).serial.dispatchEvent(ev)
}

/** 「自分の機種だ」と名乗り出る印を持つ利用側 */
function createClaimant(mine: string, notMine: string) {
  const seen = {
    opened: 0,
    closed: 0,
    /** onOpen で渡された「プローブ中に集まった行」 */
    backlog: [] as string[],
    /** onOpen 後に届いた行 */
    lines: [] as string[],
    port: null as any,
    writer: null as WritableStreamDefaultWriter<Uint8Array> | null,
  }
  const claimant: SerialClaimant = {
    claim: lines => lines.some(line => line.startsWith(mine)),
    reject: lines => lines.some(line => line.startsWith(notMine)),
    onOpen(port, _reader, writer, lines) {
      seen.opened += 1
      seen.port = port
      seen.writer = writer
      seen.backlog = [...lines]
    },
    onLine(line) {
      seen.lines.push(line)
    },
    onClose() {
      seen.closed += 1
      seen.writer = null
    },
  }
  return { claimant, seen }
}

// --- Tests ---

describe('useSerialArbiter', () => {
  let mod: typeof import('~/composables/useSerialArbiter')
  let arbiter: ReturnType<typeof mod.useSerialArbiter>

  async function load() {
    vi.resetModules()
    mod = await import('~/composables/useSerialArbiter')
    arbiter = mod.useSerialArbiter()
  }

  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    // 診断ログ ([SERIAL]) はテスト出力に流さない。中身を見るテストは logSpy を読む
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    localStorage.removeItem('alc_debug_serial')
    // 見送り印の再訪判定が Date.now() を見るので Date も止める
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    delete (navigator as any).serial
  })

  afterEach(async () => {
    await arbiter?.unregister('alarm')
    await arbiter?.unregister('core')
    delete (navigator as any).serial
    vi.useRealTimers()
    localStorage.removeItem('alc_debug_serial')
    logSpy.mockRestore()
  })

  /** `[SERIAL] …` のログだけ (prefix と末尾の経過 ms を落とした本文) */
  function serialLogs(): string[] {
    return logSpy.mock.calls
      .map(args => String(args[0]))
      .filter(line => line.startsWith('[SERIAL] '))
      .map(line => line.replace('[SERIAL] ', '').replace(/ \(\+\d+ms\)$/, ''))
  }

  // ---------- WebSerial 非対応 ----------

  it('WebSerial 非対応なら register しても start しても探索しない', async () => {
    await load()
    expect(arbiter.isSupported).toBe(false)

    const { claimant } = createClaimant('ALARM', 'CORE')
    arbiter.register('alarm', claimant)
    arbiter.start(0)
    await vi.advanceTimersByTimeAsync(60000)
    // navigator.serial が無いので触りようがない (例外も出さない)
    expect((navigator as any).serial).toBeUndefined()
  })

  // ---------- 名乗り出 ----------

  describe('claim', () => {
    it('claim した利用側にポート・reader・writer とプローブ中の行を渡す', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const { claimant, seen } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      expect(dev.writes[0]).toBe('STATUS\n')
      expect(seen.opened).toBe(1)
      expect(seen.port).toBe(dev.port)
      expect(seen.writer).not.toBeNull()
      expect(seen.backlog).toEqual(['ALARM state=idle'])
    })

    it('採用後の行は加工せず onLine へ流す', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const { claimant, seen } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      dev.emit('{"type":"ready"}\nEVT ALARM state=alarming\n')
      await vi.advanceTimersByTimeAsync(0)
      expect(seen.lines).toEqual(['{"type":"ready"}', 'EVT ALARM state=alarming'])
    })

    it('同じチャンクで claim 行のあとに来た行は onOpen の lines に載る', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\nALARM state=alarming\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const { claimant, seen } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      expect(seen.backlog).toEqual(['ALARM state=idle', 'ALARM state=alarming'])
      expect(seen.lines).toEqual([])
    })

    it('登録順に尋ね、先に登録した利用側が取る', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const first = createClaimant('ALARM', 'ZZZ')
      const second = createClaimant('ALARM', 'ZZZ')
      arbiter.register('alarm', first.claimant)
      arbiter.register('core', second.claimant)
      await vi.advanceTimersByTimeAsync(0)

      expect(first.seen.opened).toBe(1)
      expect(second.seen.opened).toBe(0)
    })
  })

  // ---------- 見送りと再訪 ----------

  describe('見送り', () => {
    it('全員が reject したら手放し、60 秒は再訪しない', async () => {
      const other = createMockPort()
      other.emit('CORE LAN=up\n')
      installSerialMock({ getPorts: vi.fn(async () => [other.port]) })
      await load()

      const { claimant, seen } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      // reject が揃った時点で打ち切る (8 秒のプローブ窓を待たない)
      expect(other.port.close).toHaveBeenCalledTimes(1)
      expect(seen.opened).toBe(0)

      await vi.advanceTimersByTimeAsync(50000)
      expect(other.port.open).toHaveBeenCalledTimes(1)
    })

    it('見送った候補も RTS → DTR の順で落としてから閉じる (再訪のたびに再起動させない)', async () => {
      const other = createMockPort()
      other.emit('CORE LAN=up\n')
      installSerialMock({ getPorts: vi.fn(async () => [other.port]) })
      await load()

      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      // BLE 相乗り中の CoreS3 が 10 秒ごとのプローブで毎回リセットされないこと
      expect(other.calls).toEqual(['setSignals({"requestToSend":false})', 'setSignals({"dataTerminalReady":false})', 'close'])
    })

    it('60 秒経ったら見送ったポートを再訪する (永久除外にしない)', async () => {
      const other = createMockPort()
      other.emit('CORE LAN=up\n')
      installSerialMock({ getPorts: vi.fn(async () => [other.port]) })
      await load()

      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)
      expect(other.port.open).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(60000)
      expect(other.port.open).toHaveBeenCalledTimes(2)
    })

    it('無応答 (行が 1 つも来ない) は印を残さず 10 秒後に再訪する', async () => {
      const silent = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [silent.port]) })
      await load()

      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)

      await vi.advanceTimersByTimeAsync(8000)
      expect(silent.writes).toHaveLength(8)
      expect(silent.port.close).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10000)
      expect(silent.port.open).toHaveBeenCalledTimes(2)
    })

    it('新しい利用側が register したら見送り印を捨てて即スキャンする', async () => {
      const other = createMockPort()
      other.emit('CORE LAN=up\n')
      installSerialMock({ getPorts: vi.fn(async () => [other.port]) })
      await load()

      const first = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', first.claimant)
      await vi.advanceTimersByTimeAsync(0)
      expect(other.port.open).toHaveBeenCalledTimes(1)

      // CoreS3 の利用側が後から来た → 10 秒周期を待たずに開き直す
      const second = createClaimant('CORE', 'ALARM')
      arbiter.register('core', second.claimant)
      await vi.advanceTimersByTimeAsync(0)

      expect(other.port.open).toHaveBeenCalledTimes(2)
    })

    it('登録済みの名前で register し直しても即スキャンはしない', async () => {
      const getPorts = vi.fn(async () => [])
      installSerialMock({ getPorts })
      await load()

      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)
      expect(getPorts).toHaveBeenCalledTimes(1)

      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)
      expect(getPorts).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- connect イベント (Refs ippoan/alc-app#221) ----------

  describe('connect イベント', () => {
    it('connect で 1 秒後にスキャンが走り claim される', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      let portsAvailable: any[] = []
      const getPorts = vi.fn(async () => portsAvailable)
      installSerialMock({ getPorts })
      await load()

      const { claimant, seen } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)
      expect(getPorts).toHaveBeenCalledTimes(1)
      expect(seen.opened).toBe(0)

      // ここで USB を挿す — getPorts で見えるようになる
      portsAvailable = [dev.port]
      emitConnect(dev.port)

      // 1 秒経つ前はまだ探しにいかない
      await vi.advanceTimersByTimeAsync(999)
      expect(getPorts).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(getPorts).toHaveBeenCalledTimes(2)
      expect(seen.opened).toBe(1)
    })

    it('見送り中 (60 秒 cooldown 中) のポートでも connect なら待たずに再訪する', async () => {
      const other = createMockPort()
      other.emit('CORE LAN=up\n')
      installSerialMock({ getPorts: vi.fn(async () => [other.port]) })
      await load()

      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)
      // 全員 reject → 見送り、本来なら 60 秒は再訪しない
      expect(other.port.open).toHaveBeenCalledTimes(1)

      // cooldown (60 秒) の途中で挿し直しの connect が来る
      await vi.advanceTimersByTimeAsync(5000)
      emitConnect(other.port)
      await vi.advanceTimersByTimeAsync(1000)

      // 60 秒待たずに再訪している
      expect(other.port.open).toHaveBeenCalledTimes(2)
    })
  })

  // ---------- 複数の利用側 ----------

  describe('複数の利用側', () => {
    it('1 本目が埋まっても、まだ空いている利用側のために探索を続ける', async () => {
      const alarmPort = createMockPort()
      alarmPort.emit('ALARM state=idle\n')
      const corePort = createMockPort()
      corePort.emit('CORE LAN=up\n')
      installSerialMock({ getPorts: vi.fn(async () => [alarmPort.port, corePort.port]) })
      await load()

      const alarm = createClaimant('ALARM', 'CORE')
      const core = createClaimant('CORE', 'ALARM')
      arbiter.register('alarm', alarm.claimant)
      arbiter.register('core', core.claimant)
      await vi.advanceTimersByTimeAsync(0)

      expect(alarm.seen.opened).toBe(1)
      expect(core.seen.opened).toBe(1)
      expect(alarm.seen.port).toBe(alarmPort.port)
      expect(core.seen.port).toBe(corePort.port)
    })

    it('預かり中のポートはスキャンで開き直さない', async () => {
      const alarmPort = createMockPort()
      alarmPort.emit('ALARM state=idle\n')
      const corePort = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [alarmPort.port, corePort.port]) })
      await load()

      const alarm = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', alarm.claimant)
      await vi.advanceTimersByTimeAsync(0)
      expect(alarmPort.port.open).toHaveBeenCalledTimes(1)

      // CoreS3 の利用側が後から来ても、警告デバイスのポートは触らない
      const core = createClaimant('CORE', 'ALARM')
      arbiter.register('core', core.claimant)
      await vi.advanceTimersByTimeAsync(8000)

      expect(alarmPort.port.open).toHaveBeenCalledTimes(1)
      expect(corePort.port.open).toHaveBeenCalledTimes(1)
    })

    it('片方を unregister しても、もう片方の探索は止めない', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      const getPorts = vi.fn(async () => [dev.port])
      installSerialMock({ getPorts })
      await load()

      const alarm = createClaimant('ALARM', 'CORE')
      const core = createClaimant('CORE', 'ZZZ')
      arbiter.register('alarm', alarm.claimant)
      arbiter.register('core', core.claimant)
      await vi.advanceTimersByTimeAsync(0)
      expect(alarm.seen.opened).toBe(1)

      await arbiter.unregister('alarm')
      expect(alarm.seen.closed).toBe(1)

      // core の探索予約は残っている
      const before = getPorts.mock.calls.length
      await vi.advanceTimersByTimeAsync(10000)
      expect(getPorts.mock.calls.length).toBeGreaterThan(before)
    })
  })

  // ---------- 返却 ----------

  describe('返却', () => {
    it('release でポートを閉じて onClose を呼び、掴み直しへ', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const { claimant, seen } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      await arbiter.release('alarm')
      expect(seen.closed).toBe(1)
      expect(dev.port.close).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10000)
      expect(dev.port.open).toHaveBeenCalledTimes(2)
    })

    it('close の前に RTS → DTR の順で落とす (ESP32-S3 を再起動させない)', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      await arbiter.release('alarm')

      // DTR=0 かつ RTS=1 が S3 の chip reset の条件。RTS を先に落として
      // その瞬間を作らない (同時指定では OS が DTR → RTS の順に落としてしまう)
      expect(dev.port.setSignals).toHaveBeenNthCalledWith(1, { requestToSend: false })
      expect(dev.port.setSignals).toHaveBeenNthCalledWith(2, { dataTerminalReady: false })
      expect(dev.calls).toEqual(['setSignals({"requestToSend":false})', 'setSignals({"dataTerminalReady":false})', 'close'])
    })

    it('setSignals が失敗しても close は呼ぶ (非対応のポート)', async () => {
      const dev = createMockPort({ signalsError: true })
      dev.emit('ALARM state=idle\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const { claimant, seen } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      await arbiter.release('alarm')

      // 2 回とも throw しても close は呼ぶ
      expect(dev.port.setSignals).toHaveBeenCalledTimes(2)
      expect(dev.port.close).toHaveBeenCalledTimes(1)
      expect(seen.closed).toBe(1)
    })

    it('RTS の setSignals が失敗しても DTR と close は続ける', async () => {
      const dev = createMockPort({ firstSignalsError: true })
      dev.emit('ALARM state=idle\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const { claimant, seen } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      await arbiter.release('alarm')

      // 1 つ目を個別に try/catch していないと DTR も close も飛ぶ
      expect(dev.calls).toEqual(['setSignals({"requestToSend":false})', 'setSignals({"dataTerminalReady":false})', 'close'])
      expect(dev.port.close).toHaveBeenCalledTimes(1)
      expect(seen.closed).toBe(1)
    })

    it('預かっていない名前の release は何もしない', async () => {
      installSerialMock({ getPorts: vi.fn(async () => []) })
      await load()

      const { claimant, seen } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await arbiter.release('alarm')
      expect(seen.closed).toBe(0)
    })

    it('受信ループが終わったら (抜線) 返させて掴み直しへ', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const { claimant, seen } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      dev.push({ value: undefined, done: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(seen.closed).toBe(1)

      await vi.advanceTimersByTimeAsync(10000)
      expect(dev.port.open).toHaveBeenCalledTimes(2)
    })
  })

  // ---------- 他の探索者への口 ----------

  describe('isArbitratedPort', () => {
    it('握っているポートだけ true', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      const outsider = createMockPort({ vid: 0x1A86 })
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      expect(mod.isArbitratedPort(dev.port)).toBe(false)

      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      expect(mod.isArbitratedPort(dev.port)).toBe(true)
      expect(mod.isArbitratedPort(outsider.port)).toBe(false)

      await arbiter.unregister('alarm')
      expect(mod.isArbitratedPort(dev.port)).toBe(false)
    })
  })

  // ---------- 開けないポート ----------

  describe('開けないポート', () => {
    it('VID が対象外のポートは触らない', async () => {
      const other = createMockPort({ vid: 0x0403 })
      installSerialMock({ getPorts: vi.fn(async () => [other.port]) })
      await load()

      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)
      expect(other.port.open).not.toHaveBeenCalled()
    })

    it('open が失敗したら印を残さず次の候補へ', async () => {
      const busy = createMockPort({ openError: new DOMException('busy', 'InvalidStateError') })
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      installSerialMock({ getPorts: vi.fn(async () => [busy.port, dev.port]) })
      await load()

      const { claimant, seen } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      expect(seen.opened).toBe(1)

      // 印は残っていないので、返したあとの再訪でまた試す
      await arbiter.release('alarm')
      await vi.advanceTimersByTimeAsync(10000)
      expect(busy.port.open).toHaveBeenCalledTimes(2)
    })

    it('readable / writable が取れないポートは閉じて次へ', async () => {
      const noRead = createMockPort({ readable: false })
      const noWrite = createMockPort({ writable: false })
      installSerialMock({ getPorts: vi.fn(async () => [noRead.port, noWrite.port]) })
      await load()

      const { claimant, seen } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      expect(noRead.port.close).toHaveBeenCalledTimes(1)
      expect(noWrite.port.close).toHaveBeenCalledTimes(1)
      expect(seen.opened).toBe(0)
    })

    it('readable / writable が取れないポートも RTS → DTR の順で落としてから閉じる', async () => {
      const noRead = createMockPort({ readable: false })
      const noWrite = createMockPort({ writable: false })
      installSerialMock({ getPorts: vi.fn(async () => [noRead.port, noWrite.port]) })
      await load()

      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      expect(noRead.calls).toEqual(['setSignals({"requestToSend":false})', 'setSignals({"dataTerminalReady":false})', 'close'])
      expect(noWrite.calls).toEqual(['setSignals({"requestToSend":false})', 'setSignals({"dataTerminalReady":false})', 'close'])
    })

    it('書き込めないポートでも、先に名乗り出があればそちらが勝つ', async () => {
      const dev = createMockPort({ writeError: true })
      dev.emit('ALARM state=idle\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const { claimant, seen } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      // STATUS の write 失敗はあとから届くが、判定は覆らない
      expect(seen.opened).toBe(1)
      expect(seen.closed).toBe(0)
    })

    it('STATUS の write に失敗したら諦めて閉じる', async () => {
      const dev = createMockPort({ writeError: true })
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const { claimant, seen } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      expect(dev.port.close).toHaveBeenCalledTimes(1)
      expect(seen.opened).toBe(0)
    })
  })

  // ---------- 探索の予約 ----------

  describe('探索の予約', () => {
    it('start(delay) で待ってから探し、見つからなければ 10 秒ごと', async () => {
      const getPorts = vi.fn(async () => [])
      installSerialMock({ getPorts })
      await load()

      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      arbiter.start(5000)

      await vi.advanceTimersByTimeAsync(4999)
      expect(getPorts).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(getPorts).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10000)
      expect(getPorts).toHaveBeenCalledTimes(2)
    })

    it('利用側が 1 つも居なければ探索しない', async () => {
      const getPorts = vi.fn(async () => [])
      installSerialMock({ getPorts })
      await load()

      arbiter.start(0)
      await vi.advanceTimersByTimeAsync(20000)
      expect(getPorts).not.toHaveBeenCalled()
    })

    it('探索中に予約が来ても再入しない', async () => {
      const silent = createMockPort()
      const getPorts = vi.fn(async () => [silent.port])
      installSerialMock({ getPorts })
      await load()

      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)
      expect(getPorts).toHaveBeenCalledTimes(1)

      // 無応答ポートを 8 秒握っている最中の予約は空振りする
      arbiter.start(1000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(getPorts).toHaveBeenCalledTimes(1)
    })

    it('全員が預かったら再スキャンを予約しない', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      const getPorts = vi.fn(async () => [dev.port])
      installSerialMock({ getPorts })
      await load()

      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      arbiter.start(0)
      await vi.advanceTimersByTimeAsync(30000)
      expect(getPorts).toHaveBeenCalledTimes(1)
    })

    it('スキャン中に来た connect は取りこぼさず次を 1 秒で予約し、その次の周期は 10 秒に戻る (Refs ippoan/alc-app#221)', async () => {
      const silent = createMockPort()
      let portsAvailable: any[] = [silent.port]
      const getPorts = vi.fn(async () => portsAvailable)
      installSerialMock({ getPorts })
      await load()

      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)

      // 無応答ポートを 8 秒握っている (= scanning 中) 最中に挿し直しの connect が来る
      await vi.advanceTimersByTimeAsync(3000)
      portsAvailable = []
      emitConnect(silent.port)

      // プローブが打ち切られるまで (8 秒) は再入しない
      await vi.advanceTimersByTimeAsync(5000)
      expect(getPorts).toHaveBeenCalledTimes(1)

      // 取りこぼさず、通常の 10 秒より早い 1 秒後に次のスキャンが走る
      await vi.advanceTimersByTimeAsync(1000)
      expect(getPorts).toHaveBeenCalledTimes(2)

      // その次の周期は通常の 10 秒に戻っている (1 秒では再スキャンしない)
      await vi.advanceTimersByTimeAsync(9000)
      expect(getPorts).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1000)
      expect(getPorts).toHaveBeenCalledTimes(3)
    })
  })

  // ---------- ポートの許可 ----------

  describe('requestPort', () => {
    it('許可されたら true', async () => {
      installSerialMock({
        requestPort: vi.fn(async () => createMockPort().port),
        getPorts: vi.fn(async () => []),
      })
      await load()
      expect(await arbiter.requestPort()).toBe(true)
    })
  })

  // ---------- writeLine ----------

  describe('writeLine', () => {
    it('末尾に改行を足して書き、失敗したら false', async () => {
      const ok = createMockPort()
      const ng = createMockPort({ writeError: true })
      await load()

      const okWriter = ok.port.writable.getWriter()
      expect(await mod.writeLine(okWriter, 'HB OK')).toBe(true)
      expect(ok.writes).toEqual(['HB OK\n'])

      const ngWriter = ng.port.writable.getWriter()
      expect(await mod.writeLine(ngWriter, 'HB OK')).toBe(false)
    })
  })

  // ---------- request (#213 CoreS3 自動端末登録 / 後続の VoiceS3R 認証) ----------

  describe('request', () => {
    /** 'core' を claim させてから返す (writer への直アクセス用に seen も返す) */
    async function claimAsCore() {
      const dev = createMockPort()
      dev.emit('CORE hello\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()

      const { claimant, seen } = createClaimant('CORE', 'ZZZ')
      arbiter.register('core', claimant)
      await vi.advanceTimersByTimeAsync(0)
      expect(seen.opened).toBe(1)
      return { dev, seen }
    }

    it('行を書いて matchPrefix で始まる応答で resolve する (onLine への配送は壊さない)', async () => {
      const { dev, seen } = await claimAsCore()

      const p = arbiter.request('core', 'AUTH TICKET', 'AUTH TICKET ', 10_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes.at(-1)).toBe('AUTH TICKET\n')

      dev.emit('AUTH TICKET abc123 EXPIRES=300\n')
      await vi.advanceTimersByTimeAsync(0)

      await expect(p).resolves.toBe('AUTH TICKET abc123 EXPIRES=300')
      // 既存の行配送 (onLine) は変えない — claimant にも同じ行が届く
      expect(seen.lines).toContain('AUTH TICKET abc123 EXPIRES=300')
    })

    it('応答待ち中に 2 件目を呼ぶと書かずに即 reject する (同時に 1 件しか待てない)', async () => {
      const { dev } = await claimAsCore()

      const p1 = arbiter.request('core', 'AUTH TICKET', 'AUTH TICKET ', 10_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(dev.writes.filter(w => w === 'AUTH TICKET\n')).toHaveLength(1)

      await expect(arbiter.request('core', 'AUTH SIGN', 'AUTH SIGN ', 10_000))
        .rejects.toThrow('既に応答待ちです')
      // 2 件目は書かれていない (1 件目の応答待ちのみ)
      expect(dev.writes).not.toContain('AUTH SIGN\n')

      // 1 件目は生きたまま — 待っている間も他の writeLine (HB 等) は塞がない
      expect(await mod.writeLine(dev.port.writable.getWriter(), 'HB OK')).toBe(true)
      expect(dev.writes).toContain('HB OK\n')

      dev.emit('AUTH TICKET abc123 EXPIRES=300\n')
      await vi.advanceTimersByTimeAsync(0)
      await expect(p1).resolves.toBe('AUTH TICKET abc123 EXPIRES=300')
    })

    it('`ERR <送った行の先頭トークン>` で始まる応答は reject する (送信行をまるごと echo するパターン)', async () => {
      const { dev } = await claimAsCore()

      const p = arbiter.request('core', 'AUTH TICKET', 'AUTH TICKET ', 10_000)
      // reject より前に handler を付けておく (付ける前に settle すると
      // vitest が "Unhandled Rejection" として拾ってしまうため)
      const assertion = expect(p).rejects.toThrow('ERR AUTH TICKET: not ready')
      await vi.advanceTimersByTimeAsync(0)

      dev.emit('ERR AUTH TICKET: not ready\n')
      await vi.advanceTimersByTimeAsync(0)

      await assertion
    })

    it('先頭トークンだけ一致する ERR も reject する (nonce を echo しない #214 の AUTH SIGN)', async () => {
      const { dev } = await claimAsCore()

      const p = arbiter.request('core', 'AUTH SIGN abc123', 'AUTH SIG ', 10_000)
      const assertion = expect(p).rejects.toThrow('ERR AUTH: no key')
      await vi.advanceTimersByTimeAsync(0)

      // firmware は送った "AUTH SIGN abc123" を echo せず、先頭トークン (AUTH) だけ一致する
      dev.emit('ERR AUTH: no key\n')
      await vi.advanceTimersByTimeAsync(0)

      await assertion
    })

    it('無関係な行では resolve も reject もせず、timeoutMs で reject する', async () => {
      const { dev } = await claimAsCore()

      const p = arbiter.request('core', 'AUTH TICKET', 'AUTH TICKET ', 10_000)
      const assertion = expect(p).rejects.toThrow(/timeout/)
      await vi.advanceTimersByTimeAsync(0)
      dev.emit('EVT SOMETHING else\n')
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
    })

    it('書き込みに失敗したら reject する', async () => {
      const { seen } = await claimAsCore()
      ;(seen.writer as unknown as { write: ReturnType<typeof vi.fn> }).write
        = vi.fn().mockRejectedValueOnce(new Error('write failed'))

      const p = arbiter.request('core', 'AUTH TICKET', 'AUTH TICKET ', 10_000)
      await expect(p).rejects.toThrow('write failed')
    })

    it('その名前でポートを預かっていなければ書かずに即 reject する', async () => {
      await load()
      await expect(arbiter.request('core', 'AUTH TICKET', 'AUTH TICKET ', 10_000))
        .rejects.toThrow('ポートを預かっていません')
    })

    it('待っている間にポートを失ったら reject する (抜線・release)', async () => {
      await claimAsCore()

      const p = arbiter.request('core', 'AUTH TICKET', 'AUTH TICKET ', 10_000)
      const assertion = expect(p).rejects.toThrow(/port closed/)
      await vi.advanceTimersByTimeAsync(0)

      await arbiter.release('core')

      await assertion
    })
  })
})

// ---------- 診断ログ (#197) ----------

describe('useSerialArbiter 診断ログ', () => {
  let mod: typeof import('~/composables/useSerialArbiter')
  let arbiter: ReturnType<typeof mod.useSerialArbiter>
  let logSpy: ReturnType<typeof vi.spyOn>

  function serialLogs(): string[] {
    return logSpy.mock.calls
      .map(args => String(args[0]))
      .filter(line => line.startsWith('[SERIAL] '))
      .map(line => line.replace('[SERIAL] ', '').replace(/ \(\+\d+ms\)$/, ''))
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    localStorage.removeItem('alc_debug_serial')
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    delete (navigator as any).serial
  })

  /** isSupported は useSerialArbiter() の呼び出し時に決まるので installSerialMock の後で呼ぶ */
  async function load() {
    vi.resetModules()
    mod = await import('~/composables/useSerialArbiter')
    arbiter = mod.useSerialArbiter()
  }

  afterEach(async () => {
    await arbiter?.unregister('alarm')
    delete (navigator as any).serial
    vi.useRealTimers()
    localStorage.removeItem('alc_debug_serial')
    logSpy.mockRestore()
  })

  it('msSinceLoad は page load からの経過 ms (整数)', async () => {
    await load()
    expect(Number.isInteger(mod.msSinceLoad())).toBe(true)
  })

  it('scan の開始・閉じた理由・60 秒再訪は常時出す (候補ごとの行は出さない)', async () => {
    const other = createMockPort()
    other.emit('CORE LAN=up\n')
    installSerialMock({ getPorts: vi.fn(async () => [other.port]) })
    await load()
    const { claimant } = createClaimant('ALARM', 'CORE')
    arbiter.register('alarm', claimant)
    await vi.advanceTimersByTimeAsync(0)

    expect(serialLogs()).toEqual([
      'scan start: candidates=1 pending=alarm',
      'close probed port: passed over',
    ])

    // 60 秒後の再訪
    await vi.advanceTimersByTimeAsync(60000)
    expect(serialLogs()).toContain('revisiting a passed-over port (cooldown elapsed)')
  })

  it('release / unregister は誰のポートをなぜ閉じたかを出す', async () => {
    const dev = createMockPort()
    dev.emit('ALARM state=idle\n')
    installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
    await load()
    const { claimant } = createClaimant('ALARM', 'CORE')
    arbiter.register('alarm', claimant)
    await vi.advanceTimersByTimeAsync(0)

    await arbiter.release('alarm')
    expect(serialLogs()).toContain('close port of alarm: release(alarm)')

    // 掴み直したところで unregister (mock の reader は cancel 後に再利用できないので別ポート)
    const dev2 = createMockPort()
    dev2.emit('ALARM state=idle\n')
    installSerialMock({ getPorts: vi.fn(async () => [dev2.port]) })
    await vi.advanceTimersByTimeAsync(10000)
    await arbiter.unregister('alarm')
    expect(serialLogs()).toContain('close port of alarm: unregister(alarm)')
  })

  describe('localStorage.alc_debug_serial=1 のときだけ候補ごとの行を出す', () => {
    beforeEach(() => {
      localStorage.setItem('alc_debug_serial', '1')
    })

    it('claim', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
    await load()
      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      expect(serialLogs()).toContain('claimed by alarm (probe lines=1)')
    })

    it('見送り (全員 reject)', async () => {
      const other = createMockPort()
      other.emit('CORE LAN=up\n')
      installSerialMock({ getPorts: vi.fn(async () => [other.port]) })
    await load()
      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      expect(serialLogs()).toContain('passed over (nobody claimed 1 lines) -> revisit in 60s')
    })

    it('無応答', async () => {
      const silent = createMockPort()
      installSerialMock({ getPorts: vi.fn(async () => [silent.port]) })
    await load()
      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(8000)

      expect(serialLogs()).toContain('no response within probe window -> retry next scan')
    })

    it('open 失敗 / ストリームが取れない', async () => {
      const busy = createMockPort({ openError: new DOMException('busy', 'InvalidStateError') })
      const broken = createMockPort({ readable: false })
      installSerialMock({ getPorts: vi.fn(async () => [busy.port, broken.port]) })
    await load()
      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      expect(serialLogs()).toContain('open failed name=InvalidStateError')
      expect(serialLogs()).toContain('no readable/writable stream -> close')
    })
  })

  // ---------- 置き場 (alc_serial_diag、Refs ippoan/alc-app#223) ----------

  describe('診断ログの置き場', () => {
    beforeEach(() => {
      localStorage.removeItem('alc_serial_diag')
    })

    afterEach(() => {
      localStorage.removeItem('alc_serial_diag')
    })

    /** 置き場の行 (先頭の `HH:MM:SS.mmm ` を落とした本文) */
    async function diag(): Promise<string[]> {
      const { readDiag } = await import('~/utils/serialDiagLog')
      return readDiag().map(line => line.replace(/^\d\d:\d\d:\d\d\.\d{3} /, ''))
    }

    it('alc_debug_serial が無くても debug の行は置き場に入る (コンソールには出ない)', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      expect(await diag()).toEqual([
        'scan start: candidates=1 pending=alarm',
        'claimed by alarm (probe lines=1)',
      ])
      // コンソールへの debug 出力は今までどおりフラグ次第
      expect(serialLogs()).not.toContain('claimed by alarm (probe lines=1)')
    })

    it.each([
      [new DOMException('busy', 'InvalidStateError'), 'open failed name=InvalidStateError'],
      ['not an error', 'open failed name=unknown'],
    ])('open 失敗はエラー名だけ残す (%s)', async (openError, expected) => {
      const busy = createMockPort({ openError: openError as Error })
      installSerialMock({ getPorts: vi.fn(async () => [busy.port]) })
      await load()
      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      expect(await diag()).toContain(expected)
    })

    it('connect イベントを残す (コンソールにも出す)', async () => {
      installSerialMock({ getPorts: vi.fn(async () => []) })
      await load()
      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      emitConnect(createMockPort().port)

      expect(await diag()).toContain('connect event')
      expect(serialLogs()).toContain('connect event')
    })

    it('close の失敗はエラー名を残す (握りつぶさない)', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      dev.port.close.mockRejectedValueOnce(new DOMException('gone', 'NetworkError'))
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      const { claimant, seen } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      await arbiter.release('alarm')

      expect(await diag()).toContain('close failed name=NetworkError')
      // 後始末 (onClose) は続ける
      expect(seen.closed).toBe(1)
    })

    it('受信ループが終わった (抜線) release は reason=read_end を残す', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      dev.push({ value: undefined, done: true })
      await vi.advanceTimersByTimeAsync(0)

      expect(await diag()).toContain('close port of alarm: release(alarm) reason=read_end')
    })

    it('release に渡した理由を残す (理由なしは今までの行のまま)', async () => {
      const dev = createMockPort()
      dev.emit('ALARM state=idle\n')
      installSerialMock({ getPorts: vi.fn(async () => [dev.port]) })
      await load()
      const { claimant } = createClaimant('ALARM', 'CORE')
      arbiter.register('alarm', claimant)
      await vi.advanceTimersByTimeAsync(0)

      await arbiter.release('alarm', 'write_failed')

      expect(await diag()).toContain('close port of alarm: release(alarm) reason=write_failed')
      expect(serialLogs()).toContain('close port of alarm: release(alarm) reason=write_failed')
    })
  })
})
