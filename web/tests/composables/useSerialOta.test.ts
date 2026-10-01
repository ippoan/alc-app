import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, watch } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

/**
 * キオスクのシリアル OTA (Refs ippoan/alc-app-s3#279, ippoan/alc-app#403)。
 *
 * 端末 (station) は useVeinSerial の `request` / `isConnected` の裏にいる偽物で模す。
 * 行の応答は契約どおり (`OTA READY 4096` / `OTA ACK <累計>` / `OTA OK` / `OTA CONFIRMED`)、
 * `OTA OK` の後は 500 ms で切れて 12 秒後につながり直す。
 *
 * CoreS3 は useCoreS3Serial の `ota` / `isConnected` と useFirmwareReport の裏にいる偽物で模す
 * (下の describe)。
 */

const link = vi.hoisted(() => ({
  isConnected: null as unknown as { value: boolean },
  request: null as unknown as ReturnType<typeof vi.fn>,
}))
mockNuxtImport('useVeinSerial', () => () => link)

const hub = vi.hoisted(() => ({
  isConnected: null as unknown as { value: boolean },
  ota: {
    begin: null as unknown as ReturnType<typeof vi.fn>,
    end: null as unknown as ReturnType<typeof vi.fn>,
    request: null as unknown as ReturnType<typeof vi.fn>,
  },
}))
mockNuxtImport('useCoreS3Serial', () => () => hub)

const fw = vi.hoisted(() => ({
  deviceId: null as unknown as { value: string | null },
  report: null as unknown as ReturnType<typeof vi.fn>,
  hold: null as unknown as ReturnType<typeof vi.fn>,
  release: null as unknown as ReturnType<typeof vi.fn>,
}))
mockNuxtImport('useFirmwareReport', () => () => fw)

/** 呼ばれた順 (錠・保留・報告・機体へ送った行・取得・接続の変化) を 1 本に記録する */
let events: string[]

/** CoreS3 と報告の偽物を作り直す (既定は「CoreS3 は繋がっていない」) */
function resetHubMocks(): void {
  events = []
  hub.isConnected = ref(false)
  hub.ota.begin = vi.fn(() => { events.push('begin') })
  hub.ota.end = vi.fn(() => { events.push('end') })
  hub.ota.request = vi.fn(async () => { throw new Error('unexpected request to cores3') })
  fw.deviceId = ref<string | null>(null)
  fw.report = vi.fn(async (phase: string) => { events.push(`report:${phase}`) })
  fw.hold = vi.fn(() => { events.push('hold') })
  fw.release = vi.fn(() => { events.push('release') })
}

/** `fetch` の 2 つ目の引数 (取得の時間切れ付き) */
const FETCH_INIT = { cache: 'no-store', signal: expect.any(AbortSignal) }

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
    resetHubMocks()
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
  async function runToEnd(target = 'timecard-station', opts?: { deviceId?: string }): Promise<void> {
    let settled = false
    const p = ota.run(target, opts).finally(() => { settled = true })
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
    expect(fetchMock).toHaveBeenCalledWith(MANIFEST_URL, FETCH_INIT)
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
    for (const target of ['timecard', 'https://evil.example/x.bin', '__proto__', 'constructor', 'toString']) {
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
      [MANIFEST_URL, FETCH_INIT],
      [APP_URL, FETCH_INIT],
    ])
    // 表の中身は tests/utils/firmware-targets.test.ts で見る (Refs ippoan/alc-app#403)
  })

  // ---------- cores3 の合図は Vein Station のポートを使わない (Refs ippoan/alc-app#403) ----------

  it('cores3 の合図は、CoreS3 が繋がっていなければ Vein のポートへ 1 行も送らず fetch もしない', async () => {
    // 機体が CoreS3 の flavor を名乗っていても、Vein のポートでは書かない
    dev.flavor = 'cores3'
    fw.deviceId.value = 'kiosk-a'

    await runToEnd('cores3', { deviceId: 'kiosk-a' })
    ota.enqueue('cores3', { deviceId: 'kiosk-a' })
    await ota.runQueued()

    expect(link.request).not.toHaveBeenCalled()
    expect(hub.ota.request).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(ota.state.value).toEqual({ kind: 'idle' })
  })

  it('Vein Station の更新は CoreS3 のポートにも報告にも触らない (終わりの end / release は空振りで呼ぶだけ)', async () => {
    await runToEnd()
    expect(ota.state.value.kind).toBe('done')
    expect(hub.ota.request).not.toHaveBeenCalled()
    expect(hub.ota.begin).not.toHaveBeenCalled()
    expect(fw.hold).not.toHaveBeenCalled()
    expect(fw.report).not.toHaveBeenCalled()
    // 錠も保留も掛けていないので、本物はどちらも何もしない
    expect(events).toEqual(['end', 'release'])
  })

  it('取得には時間切れを付ける (固まった取得で「更新中」のまま残らない)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === MANIFEST_URL) return new Response(JSON.stringify(manifest))
      throw new DOMException('The operation timed out.', 'TimeoutError')
    })
    await runToEnd()
    expect(dev.log).toEqual(['DEVICE'])
    expect(ota.state.value).toEqual({ kind: 'failed', reason: 'The operation timed out.' })
  })

  it('機体が FLAVOR を名乗らなければ何もしない', async () => {
    dev.flavor = ''
    await runToEnd()
    expect(dev.log).toEqual(['DEVICE'])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(ota.state.value).toEqual({ kind: 'idle' })
  })

  it('別の target の flavor を名乗る機体 (cores3) には書かない', async () => {
    dev.flavor = 'cores3'
    await runToEnd()
    expect(dev.log).toEqual(['DEVICE'])
    expect(fetchMock).not.toHaveBeenCalled()
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
})

// ---------- CoreS3 (Refs ippoan/alc-app#403) ----------

const HUB_PAGES = 'https://ippoan.github.io/alc-app-s3/'
/** flavor → [manifest, イメージ] (utils/firmware-targets.ts の表と同じ並び) */
const HUB_URLS: Record<string, [string, string]> = {
  'cores3': [`${HUB_PAGES}manifest.json`, `${HUB_PAGES}firmware/alc-hub-cores3-app.bin`],
  'cores3-wifi': [`${HUB_PAGES}manifest-wifi.json`, `${HUB_PAGES}firmware/alc-hub-cores3-wifi-app.bin`],
  'cores3-dev': [`${HUB_PAGES}manifest-dev.json`, `${HUB_PAGES}firmware/alc-hub-cores3-dev-app.bin`],
}

/** arbiter が、ほかの要求の応答待ちで送らずに弾くときの文言 */
const PORT_BUSY = 'request(cores3): 既に応答待ちです'

/** 偽の CoreS3。`'silent'` は応答しない (時間切れで reject) */
interface FakeHub {
  id: string
  /** 再起動後に名乗る id (`null` は未登録 = `AUTH UNPAIRED`) */
  idAfterReboot: string | null
  ver: string
  verAfterReboot: string
  board: string | null
  flavor: string
  flavorAfterReboot: string
  hbOffLine: string
  readyLine: string
  ackFor: (received: number) => string
  finalLine: string
  confirmLine: string
  authLine: string | null
  reconnects: boolean
  /** 行ごとの「既に応答待ち」で弾く残り回数 (弾いた行は機体へ届かない) */
  busy: Record<string, number>
  received: number
}

let hubDev: FakeHub

function hubRequest(payload: string | Uint8Array, matchPrefix: string, timeoutMs: number, errPrefix?: string): Promise<string> {
  const answer = (line: string): Promise<string> => {
    if (line === 'silent') {
      return new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`request(cores3): timeout waiting for "${matchPrefix}"`)), timeoutMs)
      })
    }
    if (line.startsWith(errPrefix ?? `ERR ${String(payload).split(' ')[0]}`)) return Promise.reject(new Error(line))
    return Promise.resolve(line)
  }
  if (typeof payload !== 'string') {
    hubDev.received += payload.length
    events.push('tx:<chunk>')
    if (matchPrefix === 'OTA ACK') return answer(hubDev.ackFor(hubDev.received))
    if (hubDev.finalLine === 'OTA OK') hubReboot()
    return answer(hubDev.finalLine)
  }
  if ((hubDev.busy[payload] ?? 0) > 0) {
    hubDev.busy[payload]!--
    return Promise.reject(new Error(PORT_BUSY))
  }
  events.push(`tx:${payload}`)
  if (payload === 'DEVICE') {
    const board = hubDev.board === null ? '' : ` BOARD=${hubDev.board}`
    return answer(`DEVICE cores3 VER=${hubDev.ver}${board} FLAVOR=${hubDev.flavor}`)
  }
  if (payload === 'HB OFF') return answer(hubDev.hbOffLine)
  if (payload === 'AUTH STATUS') return answer(hubDev.authLine ?? (hubDev.id === '' ? 'AUTH UNPAIRED' : `AUTH PAIRED tenant-a ${hubDev.id}`))
  if (payload.startsWith('OTA SERIAL ')) return answer(hubDev.readyLine)
  return answer(hubDev.confirmLine)
}

function hubReboot(): void {
  setTimeout(() => { hub.isConnected.value = false }, 500)
  if (!hubDev.reconnects) return
  setTimeout(() => {
    hubDev.ver = hubDev.verAfterReboot
    hubDev.flavor = hubDev.flavorAfterReboot
    hubDev.id = hubDev.idAfterReboot ?? ''
    hub.isConnected.value = true
  }, 12_000)
}

describe('useSerialOta (cores3)', () => {
  let mod: Mod
  let ota: ReturnType<Mod['useSerialOta']>
  let fetchMock: ReturnType<typeof vi.fn>
  let imageBytes: number
  let warnSpy: ReturnType<typeof vi.spyOn>
  let stopWatch: () => void

  const OPTS = { deviceId: 'kiosk-a' }

  beforeEach(async () => {
    vi.useFakeTimers()
    hubDev = {
      id: 'kiosk-a',
      idAfterReboot: 'kiosk-a',
      ver: '0.1.0',
      verAfterReboot: '0.2.0',
      board: 'cores3',
      flavor: 'cores3',
      flavorAfterReboot: 'cores3',
      hbOffLine: 'OK HB OFF',
      readyLine: 'OTA READY 65536',
      ackFor: n => `OTA ACK ${n}`,
      finalLine: 'OTA OK',
      confirmLine: 'OTA CONFIRMED',
      authLine: null,
      reconnects: true,
      busy: {},
      received: 0,
    }
    // Vein Station は繋がっていない (CoreS3 だけのキオスク)
    link.isConnected = ref(false)
    link.request = vi.fn(async () => { throw new Error('unexpected request to vein') })
    resetHubMocks()
    hub.isConnected.value = true
    hub.ota.request = vi.fn(hubRequest)
    fw.deviceId.value = 'kiosk-a'
    stopWatch = watch(() => hub.isConnected.value, c => events.push(c ? 'reconnected' : 'disconnected'), { flush: 'sync' })
    imageBytes = 256 * 1024 + 100
    fetchMock = vi.fn(async (url: string) => {
      const flavor = Object.keys(HUB_URLS).find(f => HUB_URLS[f]!.includes(url))
      events.push(`fetch:${url}`)
      if (flavor && url === HUB_URLS[flavor]![0]) return new Response(JSON.stringify({ version: '0.2.0' }))
      if (flavor) return new Response(new Uint8Array(imageBytes))
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.resetModules()
    mod = await import('~/composables/useSerialOta')
    ota = mod.useSerialOta()
  })

  afterEach(() => {
    stopWatch()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    warnSpy.mockRestore()
  })

  /** 終わるまで 1 秒ずつ時計を進める */
  async function finish(p: Promise<void>): Promise<void> {
    let settled = false
    void p.finally(() => { settled = true })
    for (let i = 0; i < 300 && !settled; i++) await vi.advanceTimersByTimeAsync(1_000)
    await p
  }

  const runToEnd = (opts: { deviceId?: string, isBusy?: () => boolean } = OPTS): Promise<void> => finish(ota.run('cores3', opts))

  /** 機体へ送った行 (チャンクは 1 つにまとめない) */
  const sent = (): string[] => events.filter(e => e.startsWith('tx:')).map(e => e.slice(3))
  const reports = (): string[] => events.filter(e => e.startsWith('report:')).map(e => e.slice(7))
  /** チャンクを除いた、呼ばれた順 */
  const order = (): string[] => events.filter(e => e !== 'tx:<chunk>')
  const chunks = (): number => events.filter(e => e === 'tx:<chunk>').length

  /** 何も起きていない (機体へ 1 行も送らず、取得も報告も保留も錠も無い) */
  function expectUntouched(): void {
    expect(hub.ota.request).not.toHaveBeenCalled()
    expect(link.request).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fw.report).not.toHaveBeenCalled()
    expect(fw.hold).not.toHaveBeenCalled()
    expect(hub.ota.begin).not.toHaveBeenCalled()
    expect(ota.state.value).toEqual({ kind: 'idle' })
  }

  /** 錠が掛かったまま・保留したまま終わっていない */
  function expectUnlockedAndReleased(): void {
    expect(hub.ota.end.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(events.lastIndexOf('end')).toBeGreaterThan(events.lastIndexOf('begin'))
    expect(fw.release).toHaveBeenCalledTimes(1)
  }

  // ---------- (1) 入口: 宛先の照合 ----------

  it.each([
    ['合図に device_id が無い', {}, 'kiosk-a'],
    ['合図の device_id が自分の機体と違う', { deviceId: 'kiosk-b' }, 'kiosk-a'],
    ['自分の機体の id がまだ取れていない', { deviceId: 'kiosk-a' }, null],
  ] as Array<[string, { deviceId?: string }, string | null]>)('★ %s → 機体へ 1 行も送らず、取得も報告も保留もしない', async (_name, opts, own) => {
    fw.deviceId.value = own
    await runToEnd(opts)
    ota.enqueue('cores3', opts)
    await ota.runQueued()
    expectUntouched()
  })

  it('★ 預けた後に自分の機体の id が変わったら (差し替え)、走らせるときの照合で弾く', async () => {
    ota.enqueue('cores3', OPTS)
    fw.deviceId.value = 'kiosk-b'
    await ota.runQueued()
    expectUntouched()
  })

  it('引数なしの run / enqueue (Vein Station の呼び方) は cores3 では何もしない', async () => {
    await finish(ota.run('cores3'))
    ota.enqueue('cores3')
    await ota.runQueued()
    expectUntouched()
  })

  it('CoreS3 が繋がっていなければ何もしない', async () => {
    hub.isConnected.value = false
    events.length = 0
    await runToEnd()
    expectUntouched()
  })

  // ---------- 成功の経路: 順番 ----------

  it('★ 成功: 錠・保留・報告・機体へ送る行の順番', async () => {
    const [manifestUrl, appUrl] = HUB_URLS.cores3!
    await runToEnd()

    expect(order()).toEqual([
      'tx:DEVICE',
      `fetch:${manifestUrl}`,
      'hold',
      'report:downloading',
      `fetch:${appUrl}`,
      'begin',
      'tx:HB OFF',
      `tx:OTA SERIAL ${imageBytes} cores3`,
      'report:writing',
      // (チャンク)
      'end', // `OTA OK` の直後。再起動 (切断) を待つ前
      'report:rebooting',
      'disconnected',
      'reconnected',
      'report:confirming',
      'tx:AUTH STATUS',
      'tx:DEVICE',
      'tx:OTA CONFIRM',
      'report:done',
      'end', // finally (錠は解けているので本物は何もしない)
      'release',
    ])
    // チャンクは `OTA SERIAL` の後・1 回目の `end` の前
    expect(chunks()).toBe(Math.ceil(imageBytes / 65536))
    expect(events.lastIndexOf('tx:<chunk>')).toBeLessThan(events.indexOf('end'))
    expect(events.indexOf('tx:<chunk>')).toBeGreaterThan(events.indexOf('report:writing'))
    expect(hubDev.received).toBe(imageBytes)
    expect(link.request).not.toHaveBeenCalled()

    expect(hub.ota.begin).toHaveBeenCalledTimes(1)
    expect(hub.ota.end).toHaveBeenCalledTimes(2)
    expect(fw.hold).toHaveBeenCalledTimes(1)
    expect(fw.release).toHaveBeenCalledTimes(1)
    expect(ota.state.value).toEqual({ kind: 'done', ver: '0.2.0' })
  })

  it('報告は遷移だけ: どれも target_version を持ち、writing に pct を載せない', async () => {
    await runToEnd()
    expect(fw.report.mock.calls).toEqual([
      ['downloading', { target_version: '0.2.0' }],
      ['writing', { target_version: '0.2.0' }],
      ['rebooting', { target_version: '0.2.0' }],
      ['confirming', { target_version: '0.2.0' }],
      ['done', { target_version: '0.2.0' }],
    ])
  })

  it('要求の形: HB OFF は 5 秒、チャンクと OTA SERIAL / OTA CONFIRM は OTA ERR で失敗を拾う', async () => {
    await runToEnd()
    const calls = hub.ota.request.mock.calls
    expect(calls.find(c => c[0] === 'HB OFF')).toEqual(['HB OFF', 'OK HB OFF', 5_000])
    expect(calls.find(c => typeof c[0] === 'string' && c[0].startsWith('OTA SERIAL'))!.slice(1)).toEqual(['OTA READY', 60_000, 'OTA ERR'])
    expect(calls.find(c => c[0] === 'AUTH STATUS')).toEqual(['AUTH STATUS', 'AUTH ', 3_000, undefined])
    expect(calls.find(c => c[0] === 'OTA CONFIRM')).toEqual(['OTA CONFIRM', 'OTA CONFIRMED', 10_000, 'OTA ERR'])
    expect(calls.filter(c => typeof c[0] !== 'string').every(c => c[3] === 'OTA ERR')).toBe(true)
  })

  it.each(Object.keys(HUB_URLS))('flavor %s は表どおりの URL から取る', async (flavor) => {
    hubDev.flavor = flavor
    hubDev.flavorAfterReboot = flavor
    await runToEnd()
    expect(fetchMock.mock.calls).toEqual([
      [HUB_URLS[flavor]![0], FETCH_INIT],
      [HUB_URLS[flavor]![1], FETCH_INIT],
    ])
    expect(sent()).toContain(`OTA SERIAL ${imageBytes} ${flavor}`)
    expect(ota.state.value.kind).toBe('done')
  })

  it('BOARD=cores3se も同じイメージで進む', async () => {
    hubDev.board = 'cores3se'
    await runToEnd()
    expect(ota.state.value).toEqual({ kind: 'done', ver: '0.2.0' })
  })

  // ---------- (2) 照合: 対象外は一覧へ skipped を出すだけ ----------

  it.each([
    ['BOARD が表に無い', (d: FakeHub) => { d.board = 'atoms3' }, 'unsupported'],
    ['BOARD を名乗らない', (d: FakeHub) => { d.board = null }, 'unsupported'],
    ['FLAVOR が表に無い', (d: FakeHub) => { d.flavor = 'timecard-station' }, 'flavor_mismatch'],
    ['版が同じ', (d: FakeHub) => { d.ver = '0.2.0' }, 'up_to_date'],
  ] as Array<[string, (d: FakeHub) => void, string]>)('%s → skipped: %s (幕も錠も保留も無い)', async (_name, arrange, reason) => {
    arrange(hubDev)
    const states: string[] = []
    const stop = watch(() => ota.state.value, s => states.push(s.kind), { flush: 'sync' })
    await runToEnd()
    stop()

    expect(fw.report.mock.calls).toEqual([['skipped', { reason }]])
    expect(sent()).toEqual(['DEVICE'])
    expect(states).toEqual([])
    expect(hub.ota.begin).not.toHaveBeenCalled()
    expect(fw.hold).not.toHaveBeenCalled()
  })

  it('最初の DEVICE がほかの要求と当たって弾かれたら、何も報告せず戻る (管理者が押し直す)', async () => {
    hubDev.busy.DEVICE = 1
    await runToEnd()
    expect(sent()).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fw.report).not.toHaveBeenCalled()
    expect(fw.hold).not.toHaveBeenCalled()
    expect(hub.ota.begin).not.toHaveBeenCalled()
    expect(ota.state.value).toEqual({ kind: 'idle' })
    expect(warnSpy).toHaveBeenCalledWith(`[SERIAL_OTA] skipped: ${PORT_BUSY}`)
  })

  // ---------- 取得の時間切れ ----------

  it('manifest の取得が時間切れ → 何も出さず戻る', async () => {
    fetchMock.mockImplementationOnce(async () => { throw new DOMException('The operation was aborted.', 'AbortError') })
    await runToEnd()
    expect(fw.report).not.toHaveBeenCalled()
    expect(fw.hold).not.toHaveBeenCalled()
    expect(hub.ota.begin).not.toHaveBeenCalled()
    expect(ota.state.value).toEqual({ kind: 'idle' })
    expect(warnSpy).toHaveBeenCalledWith('[SERIAL_OTA] skipped: The operation was aborted.')
  })

  it('manifest に version が無ければ何も出さず戻る', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ name: 'x' })))
    await runToEnd()
    expect(fw.report).not.toHaveBeenCalled()
    expect(ota.state.value).toEqual({ kind: 'idle' })
  })

  it('イメージの取得が時間切れ → failed (download) の幕と報告。錠は掛けていない', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === HUB_URLS.cores3![0]) return new Response(JSON.stringify({ version: '0.2.0' }))
      throw new DOMException('The operation timed out.', 'TimeoutError')
    })
    await runToEnd()
    expect(ota.state.value).toEqual({ kind: 'failed', reason: 'The operation timed out.' })
    expect(reports()).toEqual(['downloading', 'failed'])
    expect(fw.report).toHaveBeenLastCalledWith('failed', { reason: 'download' })
    expect(hub.ota.begin).not.toHaveBeenCalled()
    expect(sent()).toEqual(['DEVICE'])
    expectUnlockedAndReleased()
  })

  it('イメージが 256 KB 未満なら書かずに failed (image_too_small)', async () => {
    imageBytes = 1024
    await runToEnd()
    expect(fw.report).toHaveBeenLastCalledWith('failed', { reason: 'image_too_small' })
    expect(hub.ota.begin).not.toHaveBeenCalled()
    expectUnlockedAndReleased()
  })

  // ---------- (4) 始める直前の再確認 ----------

  it('★ 取得の後に機体が使用中になっていたら、始めずに預け直し、空いたらもう一度走る', async () => {
    let busy = true
    const opts = { deviceId: 'kiosk-a', isBusy: () => busy }
    await runToEnd(opts)

    expect(hub.ota.begin).not.toHaveBeenCalled()
    expect(sent()).toEqual(['DEVICE'])
    // 失敗の幕も、失敗・対象外の報告も出ない。一覧の「更新中」は、保留を解いてから待機へ戻す
    expect(ota.state.value).toEqual({ kind: 'idle' })
    expect(reports()).toEqual(['downloading', 'idle'])
    expect(fw.report).toHaveBeenLastCalledWith('idle', {})
    expect(order().slice(-4)).toEqual(['release', 'report:idle', 'end', 'release'])

    // 空いた → 受けが runQueued を呼ぶ
    busy = false
    await finish(ota.runQueued())
    expect(ota.state.value).toEqual({ kind: 'done', ver: '0.2.0' })
    expect(sent()).toContain('OTA CONFIRM')
    // 走り切った回は結果 (done) を残す: idle を送り直さない
    expect(reports().filter(r => r === 'idle')).toHaveLength(1)
    expect(reports().at(-1)).toBe('done')
    // 預かりは 1 回で消費する
    await ota.runQueued()
    expect(hub.ota.begin).toHaveBeenCalledTimes(1)
  })

  it('使用中でなければ、そのまま始める', async () => {
    await runToEnd({ deviceId: 'kiosk-a', isBusy: () => false })
    expect(ota.state.value.kind).toBe('done')
  })

  // ---------- (5) 錠を掛けた後の「いまは受けられない」 ----------

  it('★ OTA ERR busy → skipped: busy。失敗の幕にせず、錠を解いてから報告する', async () => {
    hubDev.readyLine = 'OTA ERR busy'
    const states: string[] = []
    const stop = watch(() => ota.state.value, s => states.push(s.kind), { flush: 'sync' })
    await runToEnd()
    stop()

    expect(states).toEqual(['downloading', 'idle'])
    expect(chunks()).toBe(0)
    expect(fw.report).toHaveBeenLastCalledWith('skipped', { reason: 'busy' })
    expect(events.indexOf('end')).toBeLessThan(events.indexOf('report:skipped'))
    // 結果 (skipped) を idle で上書きしない
    expect(reports()).not.toContain('idle')
    expectUnlockedAndReleased()
  })

  it('★ HB OFF がほかの要求と当たって弾かれた → skipped: busy (OTA SERIAL を送らない)', async () => {
    hubDev.busy['HB OFF'] = 1
    await runToEnd()
    expect(sent()).toEqual(['DEVICE'])
    expect(ota.state.value).toEqual({ kind: 'idle' })
    expect(fw.report).toHaveBeenLastCalledWith('skipped', { reason: 'busy' })
    expect(events.indexOf('end')).toBeLessThan(events.indexOf('report:skipped'))
    expectUnlockedAndReleased()
  })

  it.each([
    ['ERR を返す', 'ERR HB: unknown'],
    ['無応答 (5 秒)', 'silent'],
  ])('HB OFF に機体が%s → 失敗にせず OTA SERIAL へ進む', async (_name, line) => {
    hubDev.hbOffLine = line
    await runToEnd()
    expect(sent().slice(0, 3)).toEqual(['DEVICE', 'HB OFF', `OTA SERIAL ${imageBytes} cores3`])
    expect(ota.state.value.kind).toBe('done')
  })

  // ---------- 失敗: どの経路でも錠と保留を残さない ----------

  it('OTA SERIAL が無応答 (この対応より前の版) → 時間切れで failed: no_response', async () => {
    hubDev.readyLine = 'silent'
    const p = ota.run('cores3', OPTS)
    await vi.advanceTimersByTimeAsync(59_000)
    // 待っている間は取得の「0%」のまま (書き込みは始まっていない)
    expect(ota.state.value).toEqual({ kind: 'downloading' })
    await finish(p)

    expect(ota.state.value.kind).toBe('failed')
    expect(fw.report).toHaveBeenLastCalledWith('failed', { reason: 'no_response' })
    expect(chunks()).toBe(0)
    expectUnlockedAndReleased()
  })

  it.each([
    ['OTA ERR flavor', (d: FakeHub) => { d.readyLine = 'OTA ERR flavor' }, 'flavor', 'OTA ERR flavor'],
    ['チャンク長が読めない', (d: FakeHub) => { d.readyLine = 'OTA READY' }, 'bad_chunk', 'bad chunk size (OTA READY)'],
    ['ACK の食い違い', (d: FakeHub) => { d.ackFor = () => 'OTA ACK 1' }, 'ack_mismatch', 'ack mismatch (1 != 65536)'],
    ['途中の OTA ERR write', (d: FakeHub) => { d.ackFor = () => 'OTA ERR write' }, 'write', 'OTA ERR write'],
    ['検証の OTA ERR verify', (d: FakeHub) => { d.finalLine = 'OTA ERR verify' }, 'verify', 'OTA ERR verify'],
    ['再接続の時間切れ', (d: FakeHub) => { d.reconnects = false }, 'reconnect_timeout', 'reconnect timeout'],
    ['再起動後の FLAVOR 違い', (d: FakeHub) => { d.flavorAfterReboot = 'cores3-dev' }, 'flavor_mismatch', 'flavor mismatch after reboot (cores3-dev)'],
    ['OTA CONFIRM の OTA ERR', (d: FakeHub) => { d.confirmLine = 'OTA ERR confirm' }, 'confirm', 'OTA ERR confirm'],
    ['語の無い OTA ERR', (d: FakeHub) => { d.confirmLine = 'OTA ERR' }, 'no_response', 'OTA ERR'],
  ] as Array<[string, (d: FakeHub) => void, string, string]>)('%s → failed の幕と報告 (%s)。錠も保留も残さない', async (_name, arrange, word, reason) => {
    arrange(hubDev)
    await runToEnd()

    expect(ota.state.value).toEqual({ kind: 'failed', reason })
    expect(fw.report).toHaveBeenLastCalledWith('failed', { reason: word })
    expect(fw.report.mock.calls.filter(c => c[0] === 'failed')).toHaveLength(1)
    expect(sent().filter(l => l === 'OTA CONFIRM')).toHaveLength(word === 'confirm' || word === 'no_response' ? 1 : 0)
    // 報告 (端末の token を取りに行く) は錠を解いた後
    expect(events.lastIndexOf('end', events.indexOf('report:failed'))).toBeGreaterThan(events.indexOf('begin'))
    expectUnlockedAndReleased()

    await vi.advanceTimersByTimeAsync(mod.RESULT_DISPLAY_MS)
    expect(ota.state.value).toEqual({ kind: 'idle' })
  })

  // ---------- (7) 再起動後: 差し替えの検出 ----------

  it.each([
    ['別の機体の id', 'kiosk-b'],
    ['未登録 (AUTH UNPAIRED)', null],
  ])('★ 再接続後の AUTH STATUS が%s → OTA CONFIRM を送らず failed: device_changed', async (_name, id) => {
    hubDev.idAfterReboot = id
    await runToEnd()

    expect(sent().at(-1)).toBe('AUTH STATUS')
    expect(sent()).not.toContain('OTA CONFIRM')
    expect(ota.state.value).toEqual({ kind: 'failed', reason: 'device changed after reboot' })
    expect(fw.report).toHaveBeenLastCalledWith('failed', { reason: 'device_changed' })
    expectUnlockedAndReleased()
  })

  // ---------- (7) 再起動後: 「既に応答待ち」だけ再試行 ----------

  it.each(['AUTH STATUS', 'DEVICE', 'OTA CONFIRM'])('再接続後の %s が「既に応答待ち」で 2 回弾かれても、2 秒おきに送り直して確定する', async (line) => {
    // 最初の DEVICE (照合) は通し、再起動後だけ弾く
    const original = hub.ota.request.getMockImplementation()!
    hub.ota.request = vi.fn((...args: Parameters<typeof hubRequest>) => {
      if (events.includes('reconnected') && hubDev.busy[line] === undefined) hubDev.busy[line] = 2
      return original(...args)
    })
    ota = mod.useSerialOta()
    await runToEnd()

    expect(hub.ota.request.mock.calls.filter(c => c[0] === line && events.includes('reconnected')).length).toBeGreaterThanOrEqual(3)
    expect(sent().slice(-3)).toEqual(['AUTH STATUS', 'DEVICE', 'OTA CONFIRM'])
    expect(ota.state.value).toEqual({ kind: 'done', ver: '0.2.0' })
  })

  it('再接続後の AUTH STATUS が 60 秒弾かれ続けたら failed: busy (OTA CONFIRM を送らない)', async () => {
    const original = hub.ota.request.getMockImplementation()!
    hub.ota.request = vi.fn((...args: Parameters<typeof hubRequest>) => {
      if (events.includes('reconnected')) hubDev.busy['AUTH STATUS'] = 1
      return original(...args)
    })
    ota = mod.useSerialOta()
    const p = ota.run('cores3', OPTS)
    while (!events.includes('report:confirming')) await vi.advanceTimersByTimeAsync(1_000)
    const before = hub.ota.request.mock.calls.length
    await vi.advanceTimersByTimeAsync(57_000)
    // まだ諦めていない (2 秒おきに送り直している)
    expect(ota.state.value).toEqual({ kind: 'confirming' })
    await finish(p)

    // 60 秒を 2 秒おき: 最初の 1 回 + 送り直し 30 回
    expect(hub.ota.request.mock.calls.length - before).toBeLessThanOrEqual(31)
    expect(sent()).not.toContain('OTA CONFIRM')
    expect(ota.state.value).toEqual({ kind: 'failed', reason: PORT_BUSY })
    expect(fw.report).toHaveBeenLastCalledWith('failed', { reason: 'busy' })
    expectUnlockedAndReleased()
  })

  it('再接続後の AUTH STATUS が時間切れ (「既に応答待ち」以外) なら送り直さない', async () => {
    hubDev.authLine = 'silent'
    await runToEnd()
    expect(sent().filter(l => l === 'AUTH STATUS')).toHaveLength(1)
    expect(sent()).not.toContain('OTA CONFIRM')
    expect(fw.report).toHaveBeenLastCalledWith('failed', { reason: 'no_response' })
    expectUnlockedAndReleased()
  })

  // ---------- 報告を待つ・待たない ----------

  it('★ report(confirming) が解決するまで、再接続後の機体への要求を 1 つも送らない', async () => {
    let resolveConfirming: (() => void) | null = null
    fw.report = vi.fn((phase: string) => {
      events.push(`report:${phase}`)
      if (phase !== 'confirming') return Promise.resolve()
      return new Promise<void>((resolve) => { resolveConfirming = resolve })
    })
    ota = mod.useSerialOta()
    const p = ota.run('cores3', OPTS)
    while (!events.includes('report:confirming')) await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(25_000)

    expect(order().at(-1)).toBe('report:confirming')
    expect(sent()).not.toContain('AUTH STATUS')
    expect(ota.state.value).toEqual({ kind: 'confirming' })

    resolveConfirming!()
    await finish(p)
    expect(sent().slice(-3)).toEqual(['AUTH STATUS', 'DEVICE', 'OTA CONFIRM'])
    expect(ota.state.value.kind).toBe('done')
  })

  it('★ report(confirming) が固まっても、30 秒で打ち切って確定まで進む (機体の確定を逃さない)', async () => {
    fw.report = vi.fn((phase: string) => {
      events.push(`report:${phase}`)
      return phase === 'confirming' ? new Promise<void>(() => {}) : Promise.resolve()
    })
    ota = mod.useSerialOta()
    const p = ota.run('cores3', OPTS)
    while (!events.includes('report:confirming')) await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(28_000)
    expect(sent()).not.toContain('AUTH STATUS')

    await finish(p)
    expect(sent().slice(-3)).toEqual(['AUTH STATUS', 'DEVICE', 'OTA CONFIRM'])
    expect(reports().at(-1)).toBe('done')
    expect(ota.state.value).toEqual({ kind: 'done', ver: '0.2.0' })
  })

  it('★ 錠の間の報告は待たない: report(writing) が解決しなくても、チャンクの送信が進んで確定する', async () => {
    fw.report = vi.fn((phase: string) => {
      events.push(`report:${phase}`)
      return phase === 'confirming' ? Promise.resolve() : new Promise<void>(() => {})
    })
    ota = mod.useSerialOta()
    await runToEnd()
    expect(hubDev.received).toBe(imageBytes)
    expect(reports()).toEqual(['downloading', 'writing', 'rebooting', 'confirming', 'done'])
    expect(ota.state.value.kind).toBe('done')
  })

  // ---------- finally の順 ----------

  it('★ finally: running を下ろしてから release() (release() の中から呼んだ run が走る)', async () => {
    hubDev.ver = '0.2.0' // 版が同じ (DEVICE だけで終わる) 形
    let nested: Promise<void> | null = null
    fw.release = vi.fn(() => {
      events.push('release')
      if (!nested) nested = ota.run('cores3', OPTS)
    })
    ota = mod.useSerialOta()
    await runToEnd()
    await nested

    // 2 本目も機体まで届いている (running のままなら黙って戻っている)
    expect(sent()).toEqual(['DEVICE', 'DEVICE'])
    expect(events.filter(e => e === 'end' || e === 'release')).toEqual(['end', 'release', 'end', 'release'])
  })

  it('実行中にもう 1 回呼ばれても 2 本目は走らない (Vein Station の合図も捨てる)', async () => {
    link.isConnected.value = true
    const p = ota.run('cores3', OPTS)
    await ota.run('cores3', OPTS)
    await ota.run('timecard-station')
    await finish(p)
    expect(sent().filter(l => l.startsWith('OTA SERIAL'))).toHaveLength(1)
    expect(link.request).not.toHaveBeenCalled()
  })
})
