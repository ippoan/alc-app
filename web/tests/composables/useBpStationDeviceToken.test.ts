// 血圧測定台 (ATOM S3) の device JWT (Refs ippoan/alc-app#353)。
//
// useBpStationDeviceToken はモジュールスコープに cache / 抑止 / 失敗理由 / listener 登録済みの
// 印を持つシングルトンなので、テスト毎に resetModules + dynamic import で分離する
// (useManagerDeviceToken.test.ts と同じ流儀)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

type Mod = typeof import('~/composables/useBpStationDeviceToken')

async function load(): Promise<Mod> {
  return await import('~/composables/useBpStationDeviceToken')
}

// ボンド状態は機種に依らない 1 か所 (`useSignedBpBond`) が持つ。`load()` と同じ reset 後に
// 読み込むので、useBpStationDeviceToken.ts が書き込む実体と同一になる
// (useDeviceToken.test.ts と同じ流儀)
async function loadSignedBpBond() {
  const mod = await import('~/composables/useSignedBpBond')
  return mod.useSignedBpBond()
}

// nuxt.config の既定値 (テストでは runtime config をそのまま使う)
const AUTH_BASE = 'https://auth.ippoan.org'
const NONCE = 'nonce-abc'
const PUBKEY = 'pk-123'
const SIG = 'sig-456'
const TOKEN = 'bp-station.jwt.token'

/** ATOM S3 (測定台)。署名は**この端末の request** に直接頼む (`AUTH SIGNBP`)。 */
const atomMock = vi.hoisted(() => ({
  isConnected: { value: true },
  request: vi.fn(),
  connect: vi.fn(),
  onOpen: vi.fn(),
  onClose: vi.fn(),
}))
mockNuxtImport('useAtomS3Serial', () => () => atomMock)

beforeEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.resetModules()
  atomMock.isConnected.value = true
  atomMock.request.mockReset()
  atomMock.request.mockResolvedValue(`AUTH SIGBP ${PUBKEY} ${SIG} BP=1`)
  atomMock.connect.mockReset()
  atomMock.connect.mockResolvedValue(false)
  atomMock.onOpen.mockReset()
  atomMock.onClose.mockReset()
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

describe('parseBpStationSigLine (AUTH SIGBP の parse)', () => {
  it('BP=1 / BP=0 を bpBonded に写す', async () => {
    const { parseBpStationSigLine } = await load()
    expect(parseBpStationSigLine('AUTH SIGBP pk sg BP=1')).toEqual({ pubkey: 'pk', sig: 'sg', bpBonded: true })
    expect(parseBpStationSigLine('AUTH SIGBP pk sg BP=0')).toEqual({ pubkey: 'pk', sig: 'sg', bpBonded: false })
  })

  it.each([
    ['語数が足りない', 'AUTH SIGBP pk sg'],
    ['語数が多い', 'AUTH SIGBP pk sg BP=1 extra'],
    ['AUTH で始まらない', 'ERR SIGBP pk sg BP=1'],
    ['SIGBP でない', 'AUTH SIG pk sg BP=1'],
    ['小文字の bp= は受けない', 'AUTH SIGBP pk sg bp=1'],
    ['BP の値が 0/1 でない', 'AUTH SIGBP pk sg BP=2'],
  ])('%s なら null', async (_name, line) => {
    const { parseBpStationSigLine } = await load()
    expect(parseBpStationSigLine(line)).toBeNull()
  })
})

describe('useBpStationDeviceToken (#353 測定台の鍵)', () => {
  it('usage を nonce の query と token の body の両方に載せ、bp_bonded も送る', async () => {
    const fetchMock = stubHappyPath()

    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBe(TOKEN)

    expect(fetchMock.mock.calls[0]![0]).toBe(`${AUTH_BASE}/device/alarm-nonce?usage=bp-station`)
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(tokenUrl).toBe(`${AUTH_BASE}/device/alarm-token`)
    expect(tokenInit.method).toBe('POST')
    expect(JSON.parse(tokenInit.body as string)).toEqual({
      nonce: NONCE, pubkey: PUBKEY, sig: SIG, usage: 'bp-station', bp_bonded: true,
    })
    expect(t.lastError.value).toBeNull()
  })

  it('AUTH SIGN ではなく AUTH SIGNBP を撃つ (ボンド状態つき署名)', async () => {
    stubHappyPath()

    const t = (await load()).useBpStationDeviceToken()
    await t.getBpStationJwt()
    expect(atomMock.request).toHaveBeenCalledWith(`AUTH SIGNBP ${NONCE}`, 'AUTH SIGBP ', 10_000)
    expect(atomMock.request.mock.calls.every(([line]) => !String(line).startsWith('AUTH SIGN '))).toBe(true)
  })

  it('BP=1 なら signedBpBonded=true を機種非依存の 1 か所へ書き込む', async () => {
    stubHappyPath()
    const mod = await load()
    const bond = await loadSignedBpBond()
    expect(bond.hasProbedBpBond.value).toBe(false)
    expect(await mod.useBpStationDeviceToken().getBpStationJwt()).toBe(TOKEN)
    expect(bond.signedBpBonded.value).toBe(true)
    expect(bond.hasProbedBpBond.value).toBe(true)
  })

  it('BP=0 なら signedBpBonded=false (「不明」と潰さない)', async () => {
    atomMock.request.mockResolvedValue(`AUTH SIGBP ${PUBKEY} ${SIG} BP=0`)
    stubHappyPath()
    const t = (await load()).useBpStationDeviceToken()
    const bond = await loadSignedBpBond()
    expect(await t.getBpStationJwt()).toBe(TOKEN)
    expect(bond.signedBpBonded.value).toBe(false)
    expect(bond.hasProbedBpBond.value).toBe(true)
  })

  it('ATOM S3 が繋がっていなければ探しに行き、それでも居なければ stage=no-bp-station で「不明」', async () => {
    atomMock.isConnected.value = false
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBeNull()
    expect(atomMock.connect).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(atomMock.request).not.toHaveBeenCalled()
    expect(t.lastFailureStage.value).toBe('no-bp-station')
    expect(t.lastFailureStatus.value).toBeNull()
    expect(t.lastError.value).toContain('ATOM S3')
    // 「試したが分からなかった」= 画面は判定してよい (checking のまま止めない)
    const bond = await loadSignedBpBond()
    expect(bond.signedBpBonded.value).toBeNull()
    expect(bond.hasProbedBpBond.value).toBe(true)
    // 未接続は抑止しない (挿した直後の 1 回目で通ってほしい)
    expect(t.backoffUntil.value).toBe(0)
  })

  it('探しに行って繋がれば、そのまま署名まで進む', async () => {
    atomMock.isConnected.value = false
    atomMock.connect.mockImplementation(async () => {
      atomMock.isConnected.value = true
      return true
    })
    stubHappyPath()

    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBe(TOKEN)
    expect(atomMock.connect).toHaveBeenCalledTimes(1)
  })

  it('期限内は cache を再利用する (2 回目は署名も fetch もしない)', async () => {
    const fetchMock = stubHappyPath()

    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBe(TOKEN)
    expect(await t.getBpStationJwt()).toBe(TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(2) // nonce + token の 1 往復だけ
    expect(atomMock.request).toHaveBeenCalledTimes(1)
  })

  it('期限が手前マージンを切っていれば取り直す', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      // 30 秒 = 手前マージン (60 秒) より短いので次の呼び出しで再取得になる
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: TOKEN, expires_in: 30 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'second', expires_in: 900 }) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBe(TOKEN)
    expect(await t.getBpStationJwt()).toBe('second')
  })

  it('expires_in が無ければ既定 TTL (900 秒) で cache する', async () => {
    const fetchMock = stubHappyPath({ access_token: TOKEN })

    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBe(TOKEN)
    expect(await t.getBpStationJwt()).toBe(TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('同時呼び出しは 1 本にまとめる', async () => {
    const fetchMock = stubHappyPath()

    const t = (await load()).useBpStationDeviceToken()
    const [a, b] = await Promise.all([t.getBpStationJwt(), t.getBpStationJwt()])
    expect(a).toBe(TOKEN)
    expect(b).toBe(TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('nonce が HTTP エラーなら stage=nonce / status を残し、ボンド状態は「不明」', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBeNull()
    expect(t.lastFailureStage.value).toBe('nonce')
    expect(t.lastFailureStatus.value).toBe(503)
    expect(atomMock.request).not.toHaveBeenCalled()
    const bond = await loadSignedBpBond()
    expect(bond.signedBpBonded.value).toBeNull()
    expect(bond.hasProbedBpBond.value).toBe(true)
  })

  it('nonce が応答に無ければ stage=nonce / status=null', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBeNull()
    expect(t.lastFailureStage.value).toBe('nonce')
    expect(t.lastFailureStatus.value).toBeNull()
    expect(t.lastError.value).toContain('nonce 欠落')
  })

  it('署名の parse に失敗したら stage=sign (AUTH SIGN へは落とさない)', async () => {
    atomMock.request.mockResolvedValue('AUTH SIGBP 壊れた応答')
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBeNull()
    expect(t.lastFailureStage.value).toBe('sign')
    expect(t.lastError.value).toContain('parse')
    expect(atomMock.request).toHaveBeenCalledTimes(1) // フォールバックの 2 本目は撃っていない
  })

  it('firmware が ERR を返したら stage=sign にその理由を残す', async () => {
    atomMock.request.mockRejectedValue(new Error('ERR AUTH: no key'))
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBeNull()
    expect(t.lastFailureStage.value).toBe('sign')
    expect(t.lastError.value).toBe('ERR AUTH: no key')
  })

  it('Error 以外が投げられても文字列にして残す', async () => {
    atomMock.request.mockRejectedValue('シリアルが閉じました')
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBeNull()
    expect(t.lastError.value).toBe('シリアルが閉じました')
  })

  it('用途「測定台」で鍵が未登録なら token 交換が 401 で落ちる (stage=token-exchange)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'invalid_alarm_token' }) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBeNull()
    expect(t.lastFailureStage.value).toBe('token-exchange')
    expect(t.lastFailureStatus.value).toBe(401)
    const bond = await loadSignedBpBond()
    expect(bond.signedBpBonded.value).toBeNull()
    expect(bond.hasProbedBpBond.value).toBe(true)
  })

  it('access_token が応答に無ければ stage=token-exchange / status=null', async () => {
    const fetchMock = stubHappyPath({})

    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBeNull()
    expect(t.lastFailureStage.value).toBe('token-exchange')
    expect(t.lastFailureStatus.value).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('失敗したら抑止期間のあいだ再試行しない', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBeNull()
    expect(t.backoffUntil.value).toBeGreaterThan(Date.now())
    expect(await t.getBpStationJwt()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1) // 2 回目は撃っていない
  })

  it('ATOM S3 を抜いたら cache を捨てる (次の呼び出しで取り直す)', async () => {
    const fetchMock = stubHappyPath()
    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBe(TOKEN)

    // onClose に預けたハンドラを鳴らす
    const onClose = atomMock.onClose.mock.calls[0]![0] as () => void
    onClose()

    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'second', expires_in: 900 }) })
    expect(await t.getBpStationJwt()).toBe('second')
  })

  it('ATOM S3 を挿し直したら抑止を解いて取り直す (挿し忘れて開いた画面が動き出す)', async () => {
    const failing = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    vi.stubGlobal('fetch', failing)

    const t = (await load()).useBpStationDeviceToken()
    expect(await t.getBpStationJwt()).toBeNull()
    expect(t.backoffUntil.value).toBeGreaterThan(Date.now())

    // 挿し直し = onOpen。抑止が解けて 1 本取りに行く
    stubHappyPath()
    const onOpen = atomMock.onOpen.mock.calls[0]![0] as () => void
    onOpen()
    expect(t.backoffUntil.value).toBe(0)
    expect(await t.getBpStationJwt()).toBe(TOKEN)
  })

  it('抜き差しの監視は二重登録しない (composable を何度呼んでも 1 本ずつ)', async () => {
    stubHappyPath()
    const mod = await load()
    mod.useBpStationDeviceToken()
    mod.useBpStationDeviceToken()
    expect(atomMock.onOpen).toHaveBeenCalledTimes(1)
    expect(atomMock.onClose).toHaveBeenCalledTimes(1)
  })

  it('コンソールに出すのは段と status だけ (nonce・署名・token は出さない)', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const t = (await load()).useBpStationDeviceToken()
    await t.getBpStationJwt()
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
    atomMock.request.mockResolvedValue('AUTH SIGBP 壊れた応答')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ nonce: NONCE }) }))

    const t = (await load()).useBpStationDeviceToken()
    await t.getBpStationJwt()
    expect(lines.join('\n')).toContain('status=-')
  })
})
