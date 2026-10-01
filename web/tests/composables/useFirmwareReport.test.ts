import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

/**
 * キオスクが、繋がっている CoreS3 をサーバへ報告する (Refs ippoan/alc-app#403)。
 *
 * CoreS3 (`useCoreS3Serial`) と端末の token (`useDeviceToken`) は偽物で模す。
 * onOpen は本物と同じく「登録した時点で繋がっていれば、その場で 1 回呼ぶ」。
 */

interface DeviceInfo { ver: string | null, board: string | null, flavor: string | null }

const coreS3 = vi.hoisted(() => ({
  isConnected: { value: false },
  deviceInfo: { value: null as DeviceInfo | null },
  request: null as unknown as ReturnType<typeof vi.fn>,
  onOpen: null as unknown as ReturnType<typeof vi.fn>,
  onClose: null as unknown as ReturnType<typeof vi.fn>,
}))
mockNuxtImport('useCoreS3Serial', () => () => coreS3)

const deviceToken = vi.hoisted(() => ({
  getDeviceJwt: null as unknown as ReturnType<typeof vi.fn>,
}))
mockNuxtImport('useDeviceToken', () => () => deviceToken)

const reportFirmware = vi.hoisted(() => vi.fn())
vi.mock('~/utils/api', () => ({ reportFirmware }))

const INFO: DeviceInfo = { ver: '0.1.0+abc1234', board: 'cores3', flavor: 'cores3' }

describe('useFirmwareReport', () => {
  let mod: typeof import('~/composables/useFirmwareReport')
  let fw: ReturnType<typeof mod.useFirmwareReport>
  let openCbs: Array<() => void>
  let closeCbs: Array<() => void>
  let warn: ReturnType<typeof vi.spyOn>

  /** CoreS3 が繋がった (本物の claimant.onOpen と同じ順: 名乗り → 接続 → cb) */
  function open(info: DeviceInfo | null = INFO): void {
    coreS3.deviceInfo.value = info
    coreS3.isConnected.value = true
    for (const cb of openCbs) cb()
  }

  /** CoreS3 を失った */
  function close(): void {
    coreS3.deviceInfo.value = null
    coreS3.isConnected.value = false
    for (const cb of closeCbs) cb()
  }

  /** 機体へ送った行 */
  function sentLines(): string[] {
    return coreS3.request.mock.calls.map(call => call[0] as string)
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    openCbs = []
    closeCbs = []
    coreS3.isConnected.value = false
    coreS3.deviceInfo.value = null
    coreS3.request = vi.fn(async () => 'AUTH PAIRED t1 d1')
    coreS3.onOpen = vi.fn((cb: () => void) => {
      openCbs.push(cb)
      if (coreS3.isConnected.value) cb()
    })
    coreS3.onClose = vi.fn((cb: () => void) => { closeCbs.push(cb) })
    deviceToken.getDeviceJwt = vi.fn(async () => 'kiosk-jwt')
    reportFirmware.mockReset()
    reportFirmware.mockResolvedValue(undefined)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.resetModules()
    mod = await import('~/composables/useFirmwareReport')
    fw = mod.useFirmwareReport()
  })

  afterEach(() => {
    fw.stop()
    vi.useRealTimers()
    warn.mockRestore()
  })

  // ---------- report: 送る条件と順番 ----------

  describe('report', () => {
    it('未接続なら何もしない (token も取りに行かない)', async () => {
      await fw.report('idle')

      expect(deviceToken.getDeviceJwt).not.toHaveBeenCalled()
      expect(coreS3.request).not.toHaveBeenCalled()
      expect(reportFirmware).not.toHaveBeenCalled()
    })

    it('★ 端末の token が null なら AUTH STATUS を送らない (端末として登録されていないブラウザ)', async () => {
      open()
      deviceToken.getDeviceJwt.mockResolvedValue(null)

      await fw.report('idle')

      expect(deviceToken.getDeviceJwt).toHaveBeenCalledTimes(1)
      expect(coreS3.request).not.toHaveBeenCalled()
      expect(reportFirmware).not.toHaveBeenCalled()
      expect(fw.deviceId.value).toBeNull()
    })

    it('★ 端末の token の取得が終わるまで AUTH STATUS を送らない (署名の要求と当てない)', async () => {
      open()
      let resolveJwt!: (jwt: string | null) => void
      deviceToken.getDeviceJwt.mockReturnValue(new Promise<string | null>((resolve) => { resolveJwt = resolve }))

      const done = fw.report('idle')
      await vi.advanceTimersByTimeAsync(10_000)
      // token の取得中は、機体へ 1 行も送っていない
      expect(coreS3.request).not.toHaveBeenCalled()

      resolveJwt('kiosk-jwt')
      await done

      expect(coreS3.request).toHaveBeenCalledTimes(1)
      expect(deviceToken.getDeviceJwt.mock.invocationCallOrder[0]!)
        .toBeLessThan(coreS3.request.mock.invocationCallOrder[0]!)
      expect(coreS3.request.mock.invocationCallOrder[0]!)
        .toBeLessThan(reportFirmware.mock.invocationCallOrder[0]!)
    })

    it('AUTH PAIRED の id と名乗りの 3 欄を、端末の種類 cores3 で 1 回送る', async () => {
      open()

      await fw.report('idle')

      expect(coreS3.request).toHaveBeenCalledWith('AUTH STATUS', 'AUTH ', 3000)
      expect(reportFirmware).toHaveBeenCalledTimes(1)
      expect(reportFirmware).toHaveBeenCalledWith({
        device_id: 'd1',
        kind: 'cores3',
        board: 'cores3',
        flavor: 'cores3',
        version: '0.1.0+abc1234',
        phase: 'idle',
      })
      expect(fw.deviceId.value).toBe('d1')
      expect(warn).not.toHaveBeenCalled()
    })

    it('名乗りが無い機体 (旧いファーム) は 3 つの欄を key ごと省く', async () => {
      open(null)

      await fw.report('idle')

      expect(Object.keys(reportFirmware.mock.calls[0]![0])).toEqual(['device_id', 'kind', 'phase'])
      expect(reportFirmware).toHaveBeenCalledWith({ device_id: 'd1', kind: 'cores3', phase: 'idle' })
    })

    it('名乗りに在る欄だけを送る (無い欄は key ごと省く)', async () => {
      open({ ver: '0.1.0', board: null, flavor: null })

      await fw.report('idle')

      expect(Object.keys(reportFirmware.mock.calls[0]![0])).toEqual(['device_id', 'kind', 'version', 'phase'])
    })

    it('テナントが空の応答 (AUTH PAIRED の後ろが空白 2 つ) でも id を取る', async () => {
      open()
      coreS3.request.mockResolvedValue('AUTH PAIRED  d-2_b')

      await fw.report('idle')

      expect(fw.deviceId.value).toBe('d-2_b')
    })

    it.each([
      ['未登録', 'AUTH UNPAIRED'],
      ['語が足りない', 'AUTH PAIRED t1'],
      ['語が多い', 'AUTH PAIRED t1 d1 extra'],
      ['別の AUTH の応答', 'AUTH SIG pubkey sig'],
      ['id の字種違い', 'AUTH PAIRED t1 d1!'],
      ['id が空', 'AUTH PAIRED t1 '],
      ['id が 65 文字', `AUTH PAIRED t1 ${'a'.repeat(65)}`],
    ])('%s (%s) なら報告せず、例外も出さない', async (_label, line) => {
      open()
      coreS3.request.mockResolvedValue(line)

      await expect(fw.report('idle')).resolves.toBeUndefined()

      expect(reportFirmware).not.toHaveBeenCalled()
      expect(fw.deviceId.value).toBeNull()
      expect(warn).not.toHaveBeenCalled()
    })

    it('id は 64 文字まで受ける', async () => {
      open()
      coreS3.request.mockResolvedValue(`AUTH PAIRED t1 ${'a'.repeat(64)}`)

      await fw.report('idle')

      expect(fw.deviceId.value).toBe('a'.repeat(64))
    })

    it('request の reject (timeout / ほかの要求と当たった) は黙って戻る', async () => {
      open()
      coreS3.request.mockRejectedValue(new Error('request(cores3): 既に応答待ちです'))

      await expect(fw.report('idle')).resolves.toBeUndefined()

      expect(reportFirmware).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    })

    it('reportFirmware が投げても外へ出さず、console.warn に 1 行だけ', async () => {
      open()
      const error = new Error('登録されていない端末です')
      reportFirmware.mockRejectedValue(error)

      await expect(fw.report('idle')).resolves.toBeUndefined()

      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith('[firmware] 報告を送れませんでした:', error)
    })

    it('端末の token の取得が投げても外へ出さない (機体へは何も送らない)', async () => {
      open()
      deviceToken.getDeviceJwt.mockRejectedValue(new Error('network'))

      await expect(fw.report('idle')).resolves.toBeUndefined()

      expect(coreS3.request).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('2 回目は AUTH STATUS を送り直さない (id を持っている)', async () => {
      open()

      await fw.report('idle')
      await fw.report('idle')

      expect(coreS3.request).toHaveBeenCalledTimes(1)
      expect(reportFirmware).toHaveBeenCalledTimes(2)
      // token は毎回先に確かめる
      expect(deviceToken.getDeviceJwt).toHaveBeenCalledTimes(2)
    })

    it('並んで走った 2 本のうち、聞けなかった方が id を消さない', async () => {
      open()
      let resolveFirst!: (line: string) => void
      coreS3.request
        .mockReturnValueOnce(new Promise<string>((resolve) => { resolveFirst = resolve }))
        .mockRejectedValueOnce(new Error('request(cores3): 既に応答待ちです'))

      const first = fw.report('idle')
      const second = fw.report('idle')
      await second
      resolveFirst('AUTH PAIRED t1 d1')
      await first

      expect(fw.deviceId.value).toBe('d1')
      expect(reportFirmware).toHaveBeenCalledTimes(1)
    })

    it('extra (pct / reason / target_version) を body に載せる', async () => {
      open()

      await fw.report('writing', { pct: 42, target_version: '0.2.0' })
      await fw.report('failed', { reason: 'verify' })

      expect(reportFirmware).toHaveBeenNthCalledWith(1, {
        device_id: 'd1',
        kind: 'cores3',
        board: 'cores3',
        flavor: 'cores3',
        version: '0.1.0+abc1234',
        phase: 'writing',
        pct: 42,
        target_version: '0.2.0',
      })
      expect(reportFirmware).toHaveBeenNthCalledWith(2, expect.objectContaining({ phase: 'failed', reason: 'verify' }))
    })

    it('★ 機体へ送るのは AUTH STATUS の 1 行だけ (OTA の行を送らない)', async () => {
      fw.start()
      open()
      await vi.advanceTimersByTimeAsync(mod.FIRMWARE_REPORT_INTERVAL_MS * 3)
      await fw.report('writing', { pct: 1 })

      expect(sentLines()).toEqual(['AUTH STATUS'])
    })
  })

  // ---------- start / stop ----------

  describe('start / stop', () => {
    it('周期は 5 分', () => {
      expect(mod.FIRMWARE_REPORT_INTERVAL_MS).toBe(5 * 60 * 1000)
    })

    it('繋がったら idle を 1 回送る', async () => {
      fw.start()
      expect(reportFirmware).not.toHaveBeenCalled()

      open()
      await vi.advanceTimersByTimeAsync(0)

      expect(reportFirmware).toHaveBeenCalledTimes(1)
      expect(reportFirmware).toHaveBeenCalledWith(expect.objectContaining({ device_id: 'd1', phase: 'idle' }))
    })

    it('始めた時点で既に繋がっていれば、その場で 1 回送る', async () => {
      open()

      fw.start()
      await vi.advanceTimersByTimeAsync(0)

      expect(reportFirmware).toHaveBeenCalledTimes(1)
    })

    it('5 分ごとに idle を送る', async () => {
      fw.start()
      open()
      await vi.advanceTimersByTimeAsync(0)
      expect(reportFirmware).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(mod.FIRMWARE_REPORT_INTERVAL_MS - 1)
      expect(reportFirmware).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(reportFirmware).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(mod.FIRMWARE_REPORT_INTERVAL_MS)
      expect(reportFirmware).toHaveBeenCalledTimes(3)
      expect(reportFirmware).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'idle' }))
    })

    it('未接続の間の周期は何も送らない', async () => {
      fw.start()

      await vi.advanceTimersByTimeAsync(mod.FIRMWARE_REPORT_INTERVAL_MS * 2)

      expect(deviceToken.getDeviceJwt).not.toHaveBeenCalled()
      expect(reportFirmware).not.toHaveBeenCalled()
    })

    it('start() を 2 回呼んでも 1 回分 (cb の登録も周期も 1 つ)', async () => {
      fw.start()
      fw.start()
      mod.useFirmwareReport().start()

      expect(coreS3.onOpen).toHaveBeenCalledTimes(1)
      expect(coreS3.onClose).toHaveBeenCalledTimes(1)

      open()
      await vi.advanceTimersByTimeAsync(0)
      expect(reportFirmware).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(mod.FIRMWARE_REPORT_INTERVAL_MS)
      expect(reportFirmware).toHaveBeenCalledTimes(2)
    })

    it('ポートを失ったら id を捨て、繋ぎ直したら聞き直す (別の機体の id で報告しない)', async () => {
      fw.start()
      open()
      await vi.advanceTimersByTimeAsync(0)
      expect(fw.deviceId.value).toBe('d1')

      close()
      expect(fw.deviceId.value).toBeNull()

      coreS3.request.mockResolvedValue('AUTH PAIRED t1 d2')
      open({ ver: '0.2.0', board: 'cores3se', flavor: 'cores3-wifi' })
      await vi.advanceTimersByTimeAsync(0)

      expect(sentLines()).toEqual(['AUTH STATUS', 'AUTH STATUS'])
      expect(reportFirmware).toHaveBeenLastCalledWith({
        device_id: 'd2',
        kind: 'cores3',
        board: 'cores3se',
        flavor: 'cores3-wifi',
        version: '0.2.0',
        phase: 'idle',
      })
    })

    it('stop() で周期が止まり、その後に繋がっても送らない', async () => {
      fw.start()
      fw.stop()
      // 止まっているときの stop() は何もしない
      fw.stop()

      open()
      await vi.advanceTimersByTimeAsync(mod.FIRMWARE_REPORT_INTERVAL_MS * 2)

      expect(deviceToken.getDeviceJwt).not.toHaveBeenCalled()
      expect(reportFirmware).not.toHaveBeenCalled()
    })

    it('止めてから始め直すと、cb を登録し直さずに、繋がっている分をその場で送る', async () => {
      fw.start()
      open()
      await vi.advanceTimersByTimeAsync(0)
      expect(reportFirmware).toHaveBeenCalledTimes(1)
      fw.stop()

      fw.start()
      await vi.advanceTimersByTimeAsync(0)

      expect(coreS3.onOpen).toHaveBeenCalledTimes(1)
      expect(coreS3.onClose).toHaveBeenCalledTimes(1)
      expect(reportFirmware).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(mod.FIRMWARE_REPORT_INTERVAL_MS)
      expect(reportFirmware).toHaveBeenCalledTimes(3)
    })
  })

  // ---------- hold / release: 更新中は待機の報告を保留する (Refs ippoan/alc-app#403) ----------

  describe('hold / release', () => {
    /** 始めて繋ぎ、最初の idle (id の取得を含む) を済ませる */
    async function started(): Promise<void> {
      fw.start()
      open()
      await vi.advanceTimersByTimeAsync(0)
      expect(reportFirmware).toHaveBeenCalledTimes(1)
      expect(fw.deviceId.value).toBe('d1')
    }

    it('保留中は周期の idle を送らない', async () => {
      await started()

      fw.hold()
      await vi.advanceTimersByTimeAsync(mod.FIRMWARE_REPORT_INTERVAL_MS * 2)

      expect(reportFirmware).toHaveBeenCalledTimes(1)
      expect(deviceToken.getDeviceJwt).toHaveBeenCalledTimes(1)
    })

    it('保留中は繋がったときの idle を送らず、ポートを失っても id を捨てない', async () => {
      await started()

      fw.hold()
      // 書き込み後の再起動
      close()
      expect(fw.deviceId.value).toBe('d1')
      open({ ver: '0.2.0', board: 'cores3', flavor: 'cores3' })
      await vi.advanceTimersByTimeAsync(0)

      expect(reportFirmware).toHaveBeenCalledTimes(1)
      expect(sentLines()).toEqual(['AUTH STATUS'])
    })

    it('保留中は、止めてから始め直したときの idle も送らない', async () => {
      await started()

      fw.hold()
      fw.stop()
      fw.start()
      await vi.advanceTimersByTimeAsync(0)

      expect(reportFirmware).toHaveBeenCalledTimes(1)
    })

    it('保留中でも report(phase, extra) を直接呼べば送る (id を持っているので AUTH STATUS を聞かない)', async () => {
      await started()

      fw.hold()
      await fw.report('writing', { pct: 40, target_version: '0.2.0' })

      expect(sentLines()).toEqual(['AUTH STATUS'])
      expect(reportFirmware).toHaveBeenCalledTimes(2)
      expect(reportFirmware).toHaveBeenLastCalledWith({
        device_id: 'd1',
        kind: 'cores3',
        board: 'cores3',
        flavor: 'cores3',
        version: '0.1.0+abc1234',
        phase: 'writing',
        pct: 40,
        target_version: '0.2.0',
      })
    })

    it('再起動の後も、保留中は持っている id で報告する (聞き直さない)', async () => {
      await started()

      fw.hold()
      close()
      open({ ver: '0.2.0', board: 'cores3', flavor: 'cores3' })
      await fw.report('confirming')

      expect(sentLines()).toEqual(['AUTH STATUS'])
      expect(reportFirmware).toHaveBeenLastCalledWith(expect.objectContaining({ device_id: 'd1', version: '0.2.0', phase: 'confirming' }))
    })

    it('release() 自身は idle を送らず (更新の結果を上書きしない)、以後は周期と繋がったときの idle が戻り、ポートを失ったら id を捨てる', async () => {
      await started()
      fw.hold()
      close()
      open({ ver: '0.2.0', board: 'cores3', flavor: 'cores3' })
      await vi.advanceTimersByTimeAsync(0)
      expect(reportFirmware).toHaveBeenCalledTimes(1)

      fw.release()
      await vi.advanceTimersByTimeAsync(0)
      expect(reportFirmware).toHaveBeenCalledTimes(1)

      // 周期が戻る (更新後の版が一覧に載る)
      await vi.advanceTimersByTimeAsync(mod.FIRMWARE_REPORT_INTERVAL_MS)
      expect(reportFirmware).toHaveBeenCalledTimes(2)
      expect(reportFirmware).toHaveBeenLastCalledWith({
        device_id: 'd1',
        kind: 'cores3',
        board: 'cores3',
        flavor: 'cores3',
        version: '0.2.0',
        phase: 'idle',
      })

      // ポートを失ったら id を捨て、繋がったら聞き直して送る
      close()
      expect(fw.deviceId.value).toBeNull()
      coreS3.request.mockResolvedValue('AUTH PAIRED t1 d2')
      open()
      await vi.advanceTimersByTimeAsync(0)
      expect(sentLines()).toEqual(['AUTH STATUS', 'AUTH STATUS'])
      expect(reportFirmware).toHaveBeenCalledTimes(3)
      expect(reportFirmware).toHaveBeenLastCalledWith(expect.objectContaining({ device_id: 'd2', phase: 'idle' }))
    })

    it('保留していないときの release() は何も送らない', async () => {
      await started()

      fw.release()
      await vi.advanceTimersByTimeAsync(0)

      expect(reportFirmware).toHaveBeenCalledTimes(1)
      expect(deviceToken.getDeviceJwt).toHaveBeenCalledTimes(1)
    })

    it('hold() を 2 回呼んでも、release() 1 回で解ける (周期の idle が戻る)', async () => {
      await started()

      fw.hold()
      fw.hold()
      fw.release()
      fw.release()

      await vi.advanceTimersByTimeAsync(mod.FIRMWARE_REPORT_INTERVAL_MS)
      expect(reportFirmware).toHaveBeenCalledTimes(2)
    })

    it('保留は呼び出しをまたいで 1 つ (別の useFirmwareReport() から解ける)', async () => {
      await started()

      fw.hold()
      mod.useFirmwareReport().release()

      expect(reportFirmware).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(mod.FIRMWARE_REPORT_INTERVAL_MS)
      expect(reportFirmware).toHaveBeenCalledTimes(2)
    })

    // ---------- 更新の後に古い id を残さない (Refs ippoan/alc-app#403) ----------

    it('★ 保留を解いたとき未接続なら id を捨て、次に繋がったときに AUTH STATUS を聞き直す', async () => {
      await started()
      fw.hold()
      // 書き込み後の再起動で切れたまま、繋がり直さずに終わった (再接続の時間切れ)
      close()
      expect(fw.deviceId.value).toBe('d1')

      fw.release()
      expect(fw.deviceId.value).toBeNull()
      expect(reportFirmware).toHaveBeenCalledTimes(1)

      // 故障機を交換して繋いだ: 古い id を使わず、機体に聞き直す
      coreS3.request.mockResolvedValue('AUTH PAIRED t1 d2')
      open()
      await vi.advanceTimersByTimeAsync(0)
      expect(sentLines()).toEqual(['AUTH STATUS', 'AUTH STATUS'])
      expect(fw.deviceId.value).toBe('d2')
      expect(reportFirmware).toHaveBeenLastCalledWith(expect.objectContaining({ device_id: 'd2', phase: 'idle' }))
    })

    it('保留を解いたとき繋がっていれば、id を持ったまま (聞き直さず、次の周期の idle もその id で送る)', async () => {
      await started()
      fw.hold()
      close()
      open({ ver: '0.2.0', board: 'cores3', flavor: 'cores3' })

      fw.release()

      expect(fw.deviceId.value).toBe('d1')
      await vi.advanceTimersByTimeAsync(mod.FIRMWARE_REPORT_INTERVAL_MS)
      expect(sentLines()).toEqual(['AUTH STATUS'])
      expect(reportFirmware).toHaveBeenLastCalledWith(expect.objectContaining({ device_id: 'd1', version: '0.2.0', phase: 'idle' }))
    })
  })
})
