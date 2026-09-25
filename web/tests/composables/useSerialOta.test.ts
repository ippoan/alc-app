import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, watch } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

/**
 * キオスクのシリアル OTA (Refs ippoan/alc-app-s3#279)。
 *
 * 端末 (station) は useVeinSerial の `request` / `isConnected` の裏にいる偽物で模す。
 * 行の応答は契約どおり (`OTA READY 4096` / `OTA ACK <累計>` / `OTA OK` / `OTA CONFIRMED`)、
 * `OTA OK` の後は 500 ms で切れて 12 秒後につながり直す。
 */

const link = vi.hoisted(() => ({
  isConnected: null as unknown as { value: boolean },
  request: null as unknown as ReturnType<typeof vi.fn>,
}))
mockNuxtImport('useVeinSerial', () => () => link)

const MANIFEST_URL = 'https://ippoan.github.io/alc-app-s3/manifest-timecard-station.json'
const APP_URL = 'https://ippoan.github.io/alc-app-s3/firmware/alc-hub-atoms3-timecard-station-app.bin'

type Mod = typeof import('~/composables/useSerialOta')

/** 偽の端末。返答の差し替え口を持つ */
interface FakeDevice {
  ver: string | null
  flavor: string
  /** 再起動後に名乗る FLAVOR (既定は flavor のまま) */
  flavorAfterReboot: string | null
  /** 再起動後に名乗る VER */
  verAfterReboot: string | null
  /** `OTA SERIAL` への応答 */
  readyLine: string
  /** 累計 n バイトを受けたときの応答 (既定は `OTA ACK n`) */
  ackFor: (received: number) => string
  /** 最後のチャンクへの応答 */
  finalLine: string
  /** 再起動のふるまい: 切れる / つながり直す */
  disconnects: boolean
  reconnects: boolean
  received: number
  /** 端末へ届いた書き込み (行、またはバイト列の長さ) */
  log: string[]
}

let dev: FakeDevice

function fakeRequest(payload: string | Uint8Array, matchPrefix: string, _timeoutMs: number, errPrefix?: string): Promise<string> {
  const answer = (line: string): Promise<string> => {
    // arbiter と同じく、errPrefix で始まる行は reject、matchPrefix の行は resolve
    if (errPrefix && line.startsWith(errPrefix)) return Promise.reject(new Error(line))
    if (line.startsWith(matchPrefix)) return Promise.resolve(line)
    return Promise.reject(new Error(`unexpected "${line}" for "${matchPrefix}"`))
  }
  if (typeof payload !== 'string') {
    dev.received += payload.length
    dev.log.push(`<${payload.length} B>`)
    if (matchPrefix === 'OTA ACK') return answer(dev.ackFor(dev.received))
    // 最後のチャンク: 検証の結果を返し、成功なら再起動する
    if (dev.finalLine === 'OTA OK') reboot()
    return answer(dev.finalLine)
  }
  dev.log.push(payload)
  if (payload === 'DEVICE') {
    const ver = dev.ver === null ? '' : ` VER=${dev.ver}`
    return answer(`DEVICE timecard${ver} FLAVOR=${dev.flavor}`)
  }
  if (payload.startsWith('OTA SERIAL ')) return answer(dev.readyLine)
  if (payload === 'OTA CONFIRM') return answer('OTA CONFIRMED')
  return Promise.reject(new Error(`unknown command ${payload}`))
}

function reboot(): void {
  if (!dev.disconnects) return
  setTimeout(() => { link.isConnected.value = false }, 500)
  if (!dev.reconnects) return
  setTimeout(() => {
    dev.ver = dev.verAfterReboot
    dev.flavor = dev.flavorAfterReboot ?? dev.flavor
    link.isConnected.value = true
  }, 12_000)
}

describe('useSerialOta', () => {
  let mod: Mod
  let ota: ReturnType<Mod['useSerialOta']>
  let fetchMock: ReturnType<typeof vi.fn>
  let imageBytes: number
  let manifest: unknown
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vi.useFakeTimers()
    dev = {
      ver: '0.1.0',
      flavor: 'timecard-station',
      flavorAfterReboot: null,
      verAfterReboot: '0.2.0',
      readyLine: 'OTA READY 4096',
      ackFor: n => `OTA ACK ${n}`,
      finalLine: 'OTA OK',
      disconnects: true,
      reconnects: true,
      received: 0,
      log: [],
    }
    link.isConnected = ref(true)
    link.request = vi.fn(fakeRequest)
    manifest = { version: '0.2.0' }
    // 256 KB + 端数 (最後のチャンクが短い形)
    imageBytes = 256 * 1024 + 100
    fetchMock = vi.fn(async (url: string) => {
      if (url === MANIFEST_URL) return new Response(JSON.stringify(manifest))
      if (url === APP_URL) return new Response(new Uint8Array(imageBytes))
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.resetModules()
    mod = await import('~/composables/useSerialOta')
    ota = mod.useSerialOta()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    warnSpy.mockRestore()
  })

  /**
   * run を走らせ、終わるまで 1 秒ずつ時計を進める (再起動の 12 秒・再接続待ちの 90 秒を越える)。
   * 一気に進めると結果の表示時間 (RESULT_DISPLAY_MS) まで過ぎて idle に戻ってしまう
   */
  async function runToEnd(target = 'timecard-station'): Promise<void> {
    let settled = false
    const p = ota.run(target).finally(() => { settled = true })
    for (let i = 0; i < 200 && !settled; i++) await vi.advanceTimersByTimeAsync(1_000)
    await p
  }

  const chunkWrites = (): string[] => dev.log.filter(l => l.startsWith('<'))

  // ---------- 成功 ----------

  it('版が古ければ書き込み、再接続後に FLAVOR が一致したら確定する', async () => {
    const states: string[] = []
    const stop = watch(() => ota.state.value, s => states.push(s.kind), { flush: 'sync' })

    await runToEnd()
    stop()

    expect(dev.log[0]).toBe('DEVICE')
    expect(dev.log[1]).toBe(`OTA SERIAL ${imageBytes} timecard-station`)
    // 4096 B ずつ、最後は端数
    const chunks = chunkWrites()
    expect(chunks).toHaveLength(Math.ceil(imageBytes / 4096))
    expect(chunks.at(-1)).toBe(`<${imageBytes % 4096} B>`)
    expect(dev.received).toBe(imageBytes)
    // 再接続後に DEVICE で名乗りを確かめてから確定する
    expect(dev.log.slice(-2)).toEqual(['DEVICE', 'OTA CONFIRM'])

    expect(ota.state.value).toEqual({ kind: 'done', ver: '0.2.0' })
    expect(states).toEqual(expect.arrayContaining(['downloading', 'writing', 'rebooting', 'confirming', 'done']))

    // 数秒出してから idle に戻る
    await vi.advanceTimersByTimeAsync(mod.RESULT_DISPLAY_MS)
    expect(ota.state.value).toEqual({ kind: 'idle' })
  })

  it('進捗は writing の pct で出し、最後は 100', async () => {
    const pcts: number[] = []
    const stop = watch(() => ota.state.value, (s) => {
      if (s.kind === 'writing') pcts.push(s.pct)
    }, { flush: 'sync' })
    await runToEnd()
    stop()
    expect(pcts[0]).toBe(0)
    expect(pcts.at(-1)).toBe(100)
    expect([...pcts].sort((a, b) => a - b)).toEqual(pcts)
  })

  it('再起動後に VER を名乗らなくても FLAVOR が合えば確定する (VER は確定の条件にしない)', async () => {
    dev.verAfterReboot = null
    await runToEnd()
    expect(dev.log.at(-1)).toBe('OTA CONFIRM')
    expect(ota.state.value).toEqual({ kind: 'done', ver: '' })
  })

  it('manifest とイメージが食い違っても (再起動後の VER が manifest と違っても) FLAVOR で確定する', async () => {
    dev.verAfterReboot = '0.1.9'
    await runToEnd()
    expect(dev.log.at(-1)).toBe('OTA CONFIRM')
    expect(ota.state.value).toEqual({ kind: 'done', ver: '0.1.9' })
  })

  it('OTA OK の前に切れていても、つながり直すのを待って確定する', async () => {
    // 最後のチャンクの応答より先に切断が見える形
    dev.disconnects = false
    link.request = vi.fn((payload: string | Uint8Array, matchPrefix: string, t: number, e?: string) => {
      if (typeof payload !== 'string' && matchPrefix === 'OTA OK') {
        link.isConnected.value = false
        setTimeout(() => {
          dev.ver = '0.2.0'
          link.isConnected.value = true
        }, 12_000)
      }
      return fakeRequest(payload, matchPrefix, t, e)
    })
    await runToEnd()
    expect(ota.state.value).toEqual({ kind: 'done', ver: '0.2.0' })
  })

  // ---------- (1) 版が同じなら書かない ----------

  it('(1) VER が manifest の version と同じなら何も書かず、画面にも出さない', async () => {
    dev.ver = '0.2.0'
    const states: string[] = []
    const stop = watch(() => ota.state.value, s => states.push(s.kind), { flush: 'sync' })
    await runToEnd()
    stop()

    expect(dev.log).toEqual(['DEVICE'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(MANIFEST_URL, { cache: 'no-store' })
    expect(states).toEqual([])
    expect(ota.state.value).toEqual({ kind: 'idle' })
  })

  // ---------- (2) ACK を待ってから次を送る ----------

  it('(2) OTA ACK を受けるまで次のチャンクを送らない', async () => {
    let releaseAck: (() => void) | null = null
    link.request = vi.fn((payload: string | Uint8Array, matchPrefix: string, t: number, e?: string) => {
      if (typeof payload !== 'string' && dev.received === 0) {
        dev.received += payload.length
        dev.log.push(`<${payload.length} B>`)
        return new Promise<string>((resolve) => {
          releaseAck = () => resolve(`OTA ACK ${dev.received}`)
        })
      }
      return fakeRequest(payload, matchPrefix, t, e)
    })

    const p = ota.run('timecard-station')
    await vi.advanceTimersByTimeAsync(1_000)
    // 1 チャンク目の ACK 待ち — 2 チャンク目は書かれていない
    expect(chunkWrites()).toEqual(['<4096 B>'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(chunkWrites()).toHaveLength(1)
    expect(ota.state.value).toEqual({ kind: 'writing', pct: 0 })

    releaseAck!()
    let settled = false
    void p.finally(() => { settled = true })
    while (!settled) await vi.advanceTimersByTimeAsync(1_000)
    expect(chunkWrites().length).toBeGreaterThan(1)
    expect(ota.state.value.kind).toBe('done')
  })

  it('チャンクは OTA ACK / 最後だけ OTA OK を待ち、失敗行は OTA ERR で拾う', async () => {
    await runToEnd()
    const calls = link.request.mock.calls.filter(c => typeof c[0] !== 'string')
    expect(calls.slice(0, -1).every(c => c[1] === 'OTA ACK' && c[3] === 'OTA ERR')).toBe(true)
    expect(calls.at(-1)![1]).toBe('OTA OK')
    expect(calls.at(-1)![3]).toBe('OTA ERR')
  })

  // ---------- (3) OTA ERR で止まる ----------

  it('(3) OTA SERIAL が OTA ERR で断られたら何も送らず failed', async () => {
    dev.readyLine = 'OTA ERR busy'
    await runToEnd()
    expect(chunkWrites()).toEqual([])
    expect(ota.state.value).toEqual({ kind: 'failed', reason: 'OTA ERR busy' })

    await vi.advanceTimersByTimeAsync(mod.RESULT_DISPLAY_MS)
    expect(ota.state.value).toEqual({ kind: 'idle' })
  })

  it('(3) 途中のチャンクで OTA ERR write が来たら以降を送らず failed (確定もしない)', async () => {
    dev.ackFor = n => (n >= 3 * 4096 ? 'OTA ERR write' : `OTA ACK ${n}`)
    await runToEnd()
    expect(chunkWrites()).toHaveLength(3)
    expect(dev.log).not.toContain('OTA CONFIRM')
    expect(ota.state.value).toEqual({ kind: 'failed', reason: 'OTA ERR write' })
  })

  it('(3) 検証で OTA ERR verify なら failed (再起動を待たない)', async () => {
    dev.finalLine = 'OTA ERR verify'
    await runToEnd()
    expect(dev.log).not.toContain('OTA CONFIRM')
    expect(ota.state.value).toEqual({ kind: 'failed', reason: 'OTA ERR verify' })
  })

  it('ACK の累計が送った量と合わなければ止める', async () => {
    dev.ackFor = () => 'OTA ACK 1'
    await runToEnd()
    expect(chunkWrites()).toHaveLength(1)
    expect(ota.state.value).toEqual({ kind: 'failed', reason: 'ack mismatch (1 != 4096)' })
  })

  it('OTA READY のチャンク長が読めなければ送らない', async () => {
    dev.readyLine = 'OTA READY'
    await runToEnd()
    expect(chunkWrites()).toEqual([])
    expect(ota.state.value).toEqual({ kind: 'failed', reason: 'bad chunk size (OTA READY)' })
  })

  // ---------- (4) 再接続後に FLAVOR が一致したときだけ確定 ----------

  it('(4) 再接続後の FLAVOR が違えば OTA CONFIRM を送らず failed', async () => {
    dev.flavorAfterReboot = 'timecard-vein'
    await runToEnd()
    expect(dev.log.at(-1)).toBe('DEVICE')
    expect(dev.log).not.toContain('OTA CONFIRM')
    expect(ota.state.value).toEqual({ kind: 'failed', reason: 'flavor mismatch after reboot (timecard-vein)' })
  })

  it('(4) 再起動しても切れなければ (90 秒) 確定せず failed', async () => {
    dev.disconnects = false
    await runToEnd()
    expect(dev.log).not.toContain('OTA CONFIRM')
    expect(ota.state.value).toEqual({ kind: 'failed', reason: 'reconnect timeout' })
  })

  it('(4) 90 秒以内につながり直さなければ確定せず failed', async () => {
    dev.reconnects = false
    const p = ota.run('timecard-station')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ota.state.value).toEqual({ kind: 'rebooting' })
    await vi.advanceTimersByTimeAsync(31_000)
    await p
    expect(dev.log).not.toContain('OTA CONFIRM')
    expect(ota.state.value).toEqual({ kind: 'failed', reason: 'reconnect timeout' })
  })

  // ---------- (5) allowlist 外の target を無視する ----------

  it('(5) allowlist に無い target は端末にも Pages にも触らない', async () => {
    for (const target of ['timecard', 'cores3', 'https://evil.example/x.bin', '__proto__', 'constructor', 'toString']) {
      await runToEnd(target)
      ota.enqueue(target)
      await ota.runQueued()
    }
    expect(link.request).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(ota.state.value).toEqual({ kind: 'idle' })
  })

  // ---------- (6) URL はメッセージに依存しない ----------

  it('(6) 取りに行く URL はコードの固定値だけ (cache: no-store)', async () => {
    await runToEnd()
    expect(fetchMock.mock.calls).toEqual([
      [MANIFEST_URL, { cache: 'no-store' }],
      [APP_URL, { cache: 'no-store' }],
    ])
    expect(mod.SERIAL_OTA_TARGETS).toEqual({
      'timecard-station': { manifestUrl: MANIFEST_URL, appUrl: APP_URL, flavor: 'timecard-station' },
    })
  })

  // ---------- 対象外・前提の欠け ----------

  it('端末がつながっていなければ何もしない (捨てる)', async () => {
    link.isConnected.value = false
    await runToEnd()
    expect(link.request).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('つながっているのが station 以外 (FLAVOR 違い) なら何もしない', async () => {
    dev.flavor = 'timecard-vein'
    await runToEnd()
    expect(dev.log).toEqual(['DEVICE'])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(ota.state.value).toEqual({ kind: 'idle' })
  })

  it('実行中にもう 1 回呼ばれても 2 本目は走らない', async () => {
    const p1 = ota.run('timecard-station')
    await ota.run('timecard-station')
    await vi.advanceTimersByTimeAsync(100_000)
    await p1
    expect(dev.log.filter(l => l.startsWith('OTA SERIAL'))).toHaveLength(1)
  })

  it('更新が要るか調べる段階の失敗 (manifest の取得) は画面に出さない', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('x', { status: 503 }))
    await runToEnd()
    expect(ota.state.value).toEqual({ kind: 'idle' })
    expect(warnSpy).toHaveBeenCalledWith('[SERIAL_OTA] skipped: HTTP 503')
  })

  it('manifest に version が無ければ書かない', async () => {
    manifest = { name: 'x' }
    await runToEnd()
    expect(chunkWrites()).toEqual([])
    expect(ota.state.value).toEqual({ kind: 'idle' })
    expect(warnSpy).toHaveBeenCalledWith('[SERIAL_OTA] skipped: manifest has no version')
  })

  it('イメージが取れなければ failed', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === MANIFEST_URL ? new Response(JSON.stringify(manifest)) : new Response('x', { status: 404 }))
    await runToEnd()
    expect(dev.log).toEqual(['DEVICE'])
    expect(ota.state.value).toEqual({ kind: 'failed', reason: 'HTTP 404' })
  })

  it('イメージが 256 KB 未満なら書かずに failed', async () => {
    imageBytes = 256 * 1024 - 1
    await runToEnd()
    expect(dev.log).toEqual(['DEVICE'])
    expect(ota.state.value).toEqual({ kind: 'failed', reason: `image too small (${imageBytes} B)` })
  })

  it('結果を出している間に次の結果が来たら、表示時間を数え直す', async () => {
    dev.readyLine = 'OTA ERR busy'
    // 1 本目: 時計を進めずに終わらせる (fetch と応答は即時)
    await ota.run('timecard-station')
    expect(ota.state.value.kind).toBe('failed')
    await vi.advanceTimersByTimeAsync(mod.RESULT_DISPLAY_MS - 1_000)
    // 2 本目 (同じく失敗)。1 本目の表示が残っているうちに来る
    await ota.run('timecard-station')
    await vi.advanceTimersByTimeAsync(1_000)
    // 1 本目の時刻 (RESULT_DISPLAY_MS) を過ぎても、数え直したので出したまま
    expect(ota.state.value.kind).toBe('failed')
    await vi.advanceTimersByTimeAsync(mod.RESULT_DISPLAY_MS)
    expect(ota.state.value).toEqual({ kind: 'idle' })
  })

  // ---------- 預けて後で走らせる ----------

  it('enqueue した target を runQueued で 1 回だけ走らせる', async () => {
    dev.ver = '0.2.0' // 版が同じ (DEVICE だけで終わる) 形で呼ばれた回数を数える
    await ota.runQueued()
    expect(link.request).not.toHaveBeenCalled()

    ota.enqueue('timecard-station')
    await ota.runQueued()
    await ota.runQueued()
    expect(dev.log).toEqual(['DEVICE'])
  })

  // ---------- parseDeviceLine ----------

  it('parseDeviceLine は VER と FLAVOR を取り出し、無ければ null', () => {
    expect(mod.parseDeviceLine('DEVICE timecard VER=0.1.0+abc FLAVOR=timecard-station'))
      .toEqual({ ver: '0.1.0+abc', flavor: 'timecard-station' })
    expect(mod.parseDeviceLine('DEVICE timecard VER=0.1.0')).toEqual({ ver: '0.1.0', flavor: null })
    // 他のトークンの一部 (XVER=) は拾わない
    expect(mod.parseDeviceLine('DEVICE timecard XVER=1')).toEqual({ ver: null, flavor: null })
  })
})
