import { describe, it, expect, vi, beforeEach } from 'vitest'
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
