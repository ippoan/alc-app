import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

// useManagerDeviceToken はモジュールスコープに cache / 抑止 / 失敗理由を持つシングルトンなので、
// テスト毎に resetModules + dynamic import で分離する (useDeviceToken.test.ts と同じ流儀)。
type Mod = typeof import('~/composables/useManagerDeviceToken')

async function load(): Promise<Mod['useManagerDeviceToken']> {
  const mod = await import('~/composables/useManagerDeviceToken')
  return mod.useManagerDeviceToken
}

// nuxt.config の既定値 (テストでは runtime config をそのまま使う)
const AUTH_BASE = 'https://auth.ippoan.org'
const NONCE = 'nonce-abc'
const PUBKEY = 'pk-123'
const SIG = 'sig-456'
const TOKEN = 'manager.jwt.token'

// 警告デバイス (VoiceS3R)。この composable が見るのは isConnected だけで、
// 署名の送り先は signAlarmDeviceNonce の**既定値**(= useAlarmDevice().request) に委ねる。
const alarmMock = vi.hoisted(() => ({
  isConnected: { value: true },
  request: vi.fn(),
}))
mockNuxtImport('useAlarmDevice', () => () => alarmMock)

const signAlarmDeviceNonceMock = vi.hoisted(() => vi.fn())
vi.mock('~/utils/alarm-sign', () => ({
  signAlarmDeviceNonce: signAlarmDeviceNonceMock,
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.resetModules()
  alarmMock.isConnected.value = true
  alarmMock.request.mockReset()
  signAlarmDeviceNonceMock.mockReset()
  signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: PUBKEY, sig: SIG })
  // 失敗のたびに 1 行出るので既定では捨てる (中身を見るテストは spy を取り直す)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

/** nonce → token の 2 段をこの順で返す fetch mock を立てる。 */
function stubHappyPath(tokenBody: Record<string, unknown> = { access_token: TOKEN, expires_in: 900 }) {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => tokenBody })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('useManagerDeviceToken (#337 運行管理者席の鍵)', () => {
  it('VoiceS3R が繋がっていなければ fetch せず null (stage=no-alarm-device)', async () => {
    alarmMock.isConnected.value = false
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load())()
    expect(await t.getManagerJwt()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(signAlarmDeviceNonceMock).not.toHaveBeenCalled()
    expect(t.lastFailureStage.value).toBe('no-alarm-device')
    expect(t.lastFailureStatus.value).toBeNull()
    expect(t.lastError.value).toContain('VoiceS3R')
  })

  it('usage を nonce の query と token の body の両方に載せる (片方だけだと auth-worker が 401)', async () => {
    const fetchMock = stubHappyPath()

    const t = (await load())()
    expect(await t.getManagerJwt()).toBe(TOKEN)

    const nonceUrl = fetchMock.mock.calls[0]![0] as string
    expect(nonceUrl).toBe(`${AUTH_BASE}/device/alarm-nonce?usage=tenko-manager`)

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(tokenUrl).toBe(`${AUTH_BASE}/device/alarm-token`)
    expect(tokenInit.method).toBe('POST')
    expect(JSON.parse(tokenInit.body as string)).toEqual({
      nonce: NONCE, pubkey: PUBKEY, sig: SIG, usage: 'tenko-manager',
    })
    // キオスクの `bp_bonded` は載せない (別用途・別 role)
    expect(JSON.parse(tokenInit.body as string)).not.toHaveProperty('bp_bonded')
    expect(t.lastError.value).toBeNull()
  })

  it('署名は送り先を指定せず頼む = 既定の警告デバイス (VoiceS3R) に届く', async () => {
    stubHappyPath()

    const t = (await load())()
    await t.getManagerJwt()
    // 第 2 引数を渡さない = signAlarmDeviceNonce の既定値 useAlarmDevice().request が使われる
    expect(signAlarmDeviceNonceMock.mock.calls[0]).toEqual([NONCE])
  })

  it('期限内は cache を再利用する (2 回目は署名も fetch もしない)', async () => {
    const fetchMock = stubHappyPath()

    const t = (await load())()
    expect(await t.getManagerJwt()).toBe(TOKEN)
    expect(await t.getManagerJwt()).toBe(TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(2) // nonce + token の 1 往復だけ
    expect(signAlarmDeviceNonceMock).toHaveBeenCalledTimes(1)
  })

  it('期限が手前マージンを切っていれば取り直す', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      // 30 秒 = 手前マージン (60 秒) より短いので次の呼び出しで再取得になる
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: TOKEN, expires_in: 30 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'second', expires_in: 900 }) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load())()
    expect(await t.getManagerJwt()).toBe(TOKEN)
    expect(await t.getManagerJwt()).toBe('second')
  })

  it('expires_in が無ければ既定 TTL (900 秒) で cache する', async () => {
    const fetchMock = stubHappyPath({ access_token: TOKEN })

    const t = (await load())()
    expect(await t.getManagerJwt()).toBe(TOKEN)
    // 900 秒扱いなので 2 回目は cache に当たる
    expect(await t.getManagerJwt()).toBe(TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('同時呼び出しは 1 本にまとめる', async () => {
    const fetchMock = stubHappyPath()

    const t = (await load())()
    const [a, b] = await Promise.all([t.getManagerJwt(), t.getManagerJwt()])
    expect(a).toBe(TOKEN)
    expect(b).toBe(TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(2) // 1 往復ぶんだけ
  })

  it('nonce が HTTP エラーなら stage=nonce / status を残す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load())()
    expect(await t.getManagerJwt()).toBeNull()
    expect(t.lastFailureStage.value).toBe('nonce')
    expect(t.lastFailureStatus.value).toBe(503)
    expect(signAlarmDeviceNonceMock).not.toHaveBeenCalled()
  })

  it('nonce が応答に無ければ stage=nonce / status=null', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load())()
    expect(await t.getManagerJwt()).toBeNull()
    expect(t.lastFailureStage.value).toBe('nonce')
    expect(t.lastFailureStatus.value).toBeNull()
    expect(t.lastError.value).toContain('nonce 欠落')
  })

  it('署名の parse に失敗したら stage=sign', async () => {
    signAlarmDeviceNonceMock.mockResolvedValue(null)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load())()
    expect(await t.getManagerJwt()).toBeNull()
    expect(t.lastFailureStage.value).toBe('sign')
    expect(t.lastError.value).toContain('parse')
  })

  it('firmware が ERR を返したら stage=sign にその理由を残す', async () => {
    signAlarmDeviceNonceMock.mockRejectedValue(new Error('ERR AUTH: no key'))
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load())()
    expect(await t.getManagerJwt()).toBeNull()
    expect(t.lastFailureStage.value).toBe('sign')
    expect(t.lastError.value).toBe('ERR AUTH: no key')
  })

  it('Error 以外が投げられても文字列にして残す', async () => {
    signAlarmDeviceNonceMock.mockRejectedValue('シリアルが閉じました')
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load())()
    expect(await t.getManagerJwt()).toBeNull()
    expect(t.lastError.value).toBe('シリアルが閉じました')
  })

  it('用途「運行管理者席」で鍵が未登録なら token 交換が 401 で落ちる (stage=token-exchange)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'invalid_alarm_token' }) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load())()
    expect(await t.getManagerJwt()).toBeNull()
    expect(t.lastFailureStage.value).toBe('token-exchange')
    expect(t.lastFailureStatus.value).toBe(401)
  })

  it('access_token が応答に無ければ stage=token-exchange / status=null', async () => {
    const fetchMock = stubHappyPath({})

    const t = (await load())()
    expect(await t.getManagerJwt()).toBeNull()
    expect(t.lastFailureStage.value).toBe('token-exchange')
    expect(t.lastFailureStatus.value).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('失敗したら抑止期間のあいだ再試行しない', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load())()
    expect(await t.getManagerJwt()).toBeNull()
    expect(t.backoffUntil.value).toBeGreaterThan(Date.now())
    expect(await t.getManagerJwt()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1) // 2 回目は撃っていない
  })

  it('未接続は抑止しない — 挿した直後の 1 回目で通る', async () => {
    alarmMock.isConnected.value = false
    const fetchMock = stubHappyPath()

    const t = (await load())()
    expect(await t.getManagerJwt()).toBeNull()
    expect(t.backoffUntil.value).toBe(0)

    alarmMock.isConnected.value = true
    expect(await t.getManagerJwt()).toBe(TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('コンソールに出すのは段と status だけ (nonce・署名・token は出さない)', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load())()
    await t.getManagerJwt()
    const text = lines.join('\n')
    expect(text).toContain('stage=token-exchange')
    expect(text).toContain('status=401')
    expect(text).not.toContain(NONCE)
    expect(text).not.toContain(PUBKEY)
    expect(text).not.toContain(SIG)
  })

  it('HTTP を伴わない失敗では status=- と出す', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    signAlarmDeviceNonceMock.mockResolvedValue(null)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) }))

    const t = (await load())()
    await t.getManagerJwt()
    expect(lines.join('\n')).toContain('status=-')
  })
})

// dev端末の印 (Refs ippoan/alc-app#387)。resetModules 後に同じ実体を掴むため、
// token-selection は load() の後で dynamic import する
describe('useManagerDeviceToken — dev端末の印 (#387)', () => {
  const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const jwtOf = (payload: Record<string, unknown>) => `${seg({ alg: 'HS256' })}.${seg(payload)}.sig`

  // 印は localStorage にも残る (reload をまたぐ) ので、テスト間で持ち越さない
  beforeEach(() => { localStorage.clear() })

  it('dev でないトークンに替わったら印が消える (保存した印も)', async () => {
    const devJwt = jwtOf({ sub: 'm1', aud: 'device', dev_device: true })
    const plainJwt = jwtOf({ sub: 'm1', aud: 'device' })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      // 30 秒 = 手前マージンより短いので次の呼び出しで取り直す
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: devJwt, expires_in: 30 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: plainJwt, expires_in: 900 }) }))
    const t = (await load())()
    const { isDevDevice } = await import('~/utils/token-selection')

    expect(await t.getManagerJwt()).toBe(devJwt)
    expect(isDevDevice('manager-device')).toBe(true)
    expect(localStorage.getItem('alc_dev_device_manager-device')).toBe('1')

    expect(await t.getManagerJwt()).toBe(plainJwt)
    expect(isDevDevice('manager-device')).toBe(false)
    expect(localStorage.getItem('alc_dev_device_manager-device')).toBeNull()
  })

  it('dev の鍵でトークンが取れたら運行管理者席の印だけが立つ (同期で読める)', async () => {
    const devJwt = jwtOf({ sub: 'm1', aud: 'device', dev_device: true })
    stubHappyPath({ access_token: devJwt, expires_in: 900 })
    const useManagerDeviceToken = await load()
    const { isDevDevice } = await import('~/utils/token-selection')
    expect(isDevDevice('manager-device')).toBe(false)

    expect(await useManagerDeviceToken().getManagerJwt()).toBe(devJwt)

    expect(isDevDevice('manager-device')).toBe(true)
    expect(isDevDevice('kiosk')).toBe(false)
    expect(isDevDevice('bp-station')).toBe(false)
  })

  it('dev でない鍵のトークンでは印は立たない', async () => {
    stubHappyPath({ access_token: jwtOf({ sub: 'm1', aud: 'device' }), expires_in: 900 })
    const useManagerDeviceToken = await load()
    const { isDevDevice } = await import('~/utils/token-selection')

    await useManagerDeviceToken().getManagerJwt()

    expect(isDevDevice('manager-device')).toBe(false)
  })

  describe('prefetchManagerJwt — 警告デバイスが繋がったときの先取り (Refs ippoan/alc-app#387)', () => {
    it('取れたら cache に載り、抑止の期限には触らない (続く getManagerJwt は通信しない)', async () => {
      const fetchMock = stubHappyPath()
      const t = (await load())()

      await expect(t.prefetchManagerJwt()).resolves.toBeUndefined()

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(t.backoffUntil.value).toBe(0)
      expect(await t.getManagerJwt()).toBe(TOKEN)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('★ 取れなかったら抑止の期限を先取りの前の値 (0) へ戻し、直後の本物の要求はもう一度取りに行って通る', async () => {
      const fetchMock = vi.fn()
        // 先取り: 繋がった直後で nonce が取れない
        .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
        // 本物の要求: nonce → token
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: TOKEN, expires_in: 900 }) })
      vi.stubGlobal('fetch', fetchMock)
      const t = (await load())()

      await t.prefetchManagerJwt()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(t.backoffUntil.value).toBe(0)
      expect(await t.getManagerJwt()).toBe(TOKEN)
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('本物の要求の失敗で立っていた抑止は、先取りが消さない (前の値のまま)', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
      vi.stubGlobal('fetch', fetchMock)
      const t = (await load())()
      expect(await t.getManagerJwt()).toBeNull()
      const before = t.backoffUntil.value
      expect(before).toBeGreaterThan(Date.now())

      await t.prefetchManagerJwt()

      // 抑止中なので通信せず、期限も動かない
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(t.backoffUntil.value).toBe(before)
    })

    it('VoiceS3R が繋がっていなければ通信 0', async () => {
      alarmMock.isConnected.value = false
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const t = (await load())()

      await t.prefetchManagerJwt()

      expect(fetchMock).not.toHaveBeenCalled()
      expect(t.backoffUntil.value).toBe(0)
    })

    it('中で例外が出ても reject しない', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const t = (await load())()
      // 接続の状態を読むところで落とす (getManagerJwt は reject する)
      const connected = alarmMock.isConnected
      alarmMock.isConnected = null as unknown as typeof connected
      try {
        await expect(t.getManagerJwt()).rejects.toThrow()
        await expect(t.prefetchManagerJwt()).resolves.toBeUndefined()
      }
      finally {
        alarmMock.isConnected = connected
      }
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})

// 警告デバイスの切断による期限 (Refs ippoan/alc-app#387)。いつ入れ・外すかは useAlarmWatch の側
// (useAlarmWatch.disconnect-grace.test.ts)。ここは「期限でトークンが使えなくなる」ことと、
// そのときに**トークンそのものと開発用の印に触らない**こと。
describe('useManagerDeviceToken — 切断による期限 (#387)', () => {
  const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const devJwt = `${seg({ alg: 'HS256' })}.${seg({ sub: 'm1', aud: 'device', dev_device: true })}.sig`
  const T0 = Date.UTC(2026, 0, 1, 0, 0, 0)
  const GRACE_MS = 120_000

  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 印の書き換えを数える (`noteDeviceToken` は印が変わるたびにこのイベントを出す) */
  async function watchDevMark() {
    const { isDevDevice, DEV_DEVICE_MARK_EVENT } = await import('~/utils/token-selection')
    const onChange = vi.fn()
    window.addEventListener(DEV_DEVICE_MARK_EVENT, onChange)
    return { isDevDevice, onChange, off: () => window.removeEventListener(DEV_DEVICE_MARK_EVENT, onChange) }
  }

  it('期限を入れると、期限の直前までは cache を返し、期限ちょうどで使わなくなる (USB なしなら null)', async () => {
    const fetchMock = stubHappyPath()
    const t = (await load())()
    expect(await t.getManagerJwt()).toBe(TOKEN)

    // 切れた: 2 分後を期限にする
    alarmMock.isConnected.value = false
    t.setDisconnectDeadline(T0 + GRACE_MS)

    vi.setSystemTime(T0 + GRACE_MS - 1)
    expect(await t.getManagerJwt()).toBe(TOKEN)
    expect(t.lastFailureStage.value).toBeNull()

    vi.setSystemTime(T0 + GRACE_MS)
    expect(await t.getManagerJwt()).toBeNull()
    expect(t.lastFailureStage.value).toBe('no-alarm-device')
    // 取り直しには行っていない (USB が無いので通信 0) / 抑止も立てない
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(t.backoffUntil.value).toBe(0)
  })

  it('★ 期限を入れても・期限が切れても、開発用の印は変わらない (トークンを捨てない = 印を落とさない)', async () => {
    stubHappyPath({ access_token: devJwt, expires_in: 900 })
    const t = (await load())()
    expect(await t.getManagerJwt()).toBe(devJwt)
    const mark = await watchDevMark()
    expect(mark.isDevDevice('manager-device')).toBe(true)

    alarmMock.isConnected.value = false
    t.setDisconnectDeadline(T0 + GRACE_MS)
    expect(mark.isDevDevice('manager-device')).toBe(true)

    vi.setSystemTime(T0 + GRACE_MS + 1000)
    expect(await t.getManagerJwt()).toBeNull()
    expect(mark.isDevDevice('manager-device')).toBe(true)
    expect(localStorage.getItem('alc_dev_device_manager-device')).toBe('1')

    // その場で期限を切っても (設定 off)、外しても同じ
    t.setDisconnectDeadline(Date.now())
    t.clearDisconnectDeadline()
    expect(mark.isDevDevice('manager-device')).toBe(true)
    expect(mark.onChange).not.toHaveBeenCalled()
    mark.off()
  })

  it('期限 = 今 (設定 off) なら、その場で cache を使わなくなる', async () => {
    stubHappyPath()
    const t = (await load())()
    expect(await t.getManagerJwt()).toBe(TOKEN)

    alarmMock.isConnected.value = false
    t.setDisconnectDeadline(T0)
    expect(await t.getManagerJwt()).toBeNull()
    expect(t.lastFailureStage.value).toBe('no-alarm-device')
  })

  it('期限が切れた後に USB が繋がっていれば取り直す。期限を外した後の新しいトークンは元の 15 分', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: TOKEN, expires_in: 900 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'second', expires_in: 900 }) })
    vi.stubGlobal('fetch', fetchMock)
    const t = (await load())()
    expect(await t.getManagerJwt()).toBe(TOKEN)

    t.setDisconnectDeadline(T0 + GRACE_MS)
    const reconnectedAt = T0 + GRACE_MS + 5000
    vi.setSystemTime(reconnectedAt)
    // 繋がり直した: 期限を外す (切り詰めた cache の期限は戻らないので、次の要求が取り直す)
    t.clearDisconnectDeadline()
    expect(await t.getManagerJwt()).toBe('second')
    expect(fetchMock).toHaveBeenCalledTimes(4)

    // 新しいトークンは 900 秒 − 手前マージン 60 秒の直前まで cache に当たる
    vi.setSystemTime(reconnectedAt + 840_000 - 1)
    expect(await t.getManagerJwt()).toBe('second')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('猶予のあいだに繋がり直して期限を外しても、切り詰めた期限は戻らない (元の期限の所で取り直すだけ)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: TOKEN, expires_in: 900 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'second', expires_in: 900 }) })
    vi.stubGlobal('fetch', fetchMock)
    const t = (await load())()
    expect(await t.getManagerJwt()).toBe(TOKEN)

    t.setDisconnectDeadline(T0 + GRACE_MS)
    vi.setSystemTime(T0 + 30_000)
    t.clearDisconnectDeadline()
    expect(await t.getManagerJwt()).toBe(TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    vi.setSystemTime(T0 + GRACE_MS)
    expect(await t.getManagerJwt()).toBe('second')
  })

  it('★ 期限が入っている間に書き込まれたトークン (切断をまたいだ取得) も、同じ期限で使えなくなる', async () => {
    // token の応答を、切断の後まで保留する
    let resolveToken!: (v: unknown) => void
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      .mockReturnValueOnce(new Promise((resolve) => { resolveToken = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const t = (await load())()
    const pending = t.getManagerJwt()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    // 取得の途中で切れた
    alarmMock.isConnected.value = false
    vi.setSystemTime(T0 + 1000)
    t.setDisconnectDeadline(T0 + 1000 + GRACE_MS)

    resolveToken({ ok: true, status: 200, json: async () => ({ access_token: TOKEN, expires_in: 900 }) })
    expect(await pending).toBe(TOKEN)

    // 15 分ではなく、切断による期限で切れる
    vi.setSystemTime(T0 + 1000 + GRACE_MS - 1)
    expect(await t.getManagerJwt()).toBe(TOKEN)
    vi.setSystemTime(T0 + 1000 + GRACE_MS)
    expect(await t.getManagerJwt()).toBeNull()
    expect(t.lastFailureStage.value).toBe('no-alarm-device')
  })

  it('切断による期限より先に切れるトークンの期限は延ばさない', async () => {
    const fetchMock = stubHappyPath({ access_token: TOKEN, expires_in: 90 })
    const t = (await load())()
    expect(await t.getManagerJwt()).toBe(TOKEN)

    // 元の期限 (90 秒 − 手前マージン 60 秒 = 30 秒後) の方が、2 分後より早い
    alarmMock.isConnected.value = false
    t.setDisconnectDeadline(T0 + GRACE_MS)
    vi.setSystemTime(T0 + 30_000)
    expect(await t.getManagerJwt()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
