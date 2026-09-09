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
  Object.defineProperty(navigator, 'serial', {
    value: {
      requestPort: serialMock.requestPort ?? vi.fn(),
      getPorts: serialMock.getPorts ?? vi.fn(async () => []),
    },
    configurable: true,
    writable: true,
  })
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

  beforeEach(() => {
    vi.clearAllMocks()
    // 見送り印の再訪判定が Date.now() を見るので Date も止める
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    delete (navigator as any).serial
  })

  afterEach(async () => {
    await arbiter?.unregister('alarm')
    await arbiter?.unregister('core')
    delete (navigator as any).serial
    vi.useRealTimers()
  })

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
})
