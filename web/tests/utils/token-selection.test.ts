// 送るトークンの選び方 (Refs ippoan/alc-app#387)。
//
// 規則は 1 つ: **その送信で使える端末の鍵のトークンに claim `dev_device` があれば、管理者の
// トークンより先にそれを使う。無ければ今までの優先順位 (管理者 → 端末) のまま。**
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  clearDevDeviceMark, isDevDevice, isDevDeviceToken, noteDeviceToken, selectSendToken, usesAdminToken,
  DEV_SIGNALING_TOKEN_UNAVAILABLE_MESSAGE, devSignalingToken,
  type DeviceTokenKind,
} from '~/utils/token-selection'
import { browserJwt, devDeviceJwt, dummyJwt, plainDeviceJwt } from '../helpers/dummy-jwt'

const ADMIN = browserJwt()
const DEV = devDeviceJwt()
const PLAIN = plainDeviceJwt()
const KINDS: DeviceTokenKind[] = ['kiosk', 'manager-device', 'bp-station']

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const kind of KINDS) noteDeviceToken(kind, null)
  localStorage.clear()
})

describe('isDevDeviceToken — payload の dev_device を読む (署名は見ない)', () => {
  it('dev_device === true のときだけ true', () => {
    expect(isDevDeviceToken(DEV)).toBe(true)
    expect(isDevDeviceToken(PLAIN)).toBe(false)
    expect(isDevDeviceToken(ADMIN)).toBe(false)
  })

  it('true 以外の値 (文字列・1・false) は dev にしない', () => {
    expect(isDevDeviceToken(dummyJwt({ aud: 'device', dev_device: 'true' }))).toBe(false)
    expect(isDevDeviceToken(dummyJwt({ aud: 'device', dev_device: 1 }))).toBe(false)
    expect(isDevDeviceToken(dummyJwt({ aud: 'device', dev_device: false }))).toBe(false)
  })

  it('トークン無し・読めないトークンは dev でない側に倒れる', () => {
    expect(isDevDeviceToken(null)).toBe(false)
    expect(isDevDeviceToken(undefined)).toBe(false)
    expect(isDevDeviceToken('')).toBe(false)
    expect(isDevDeviceToken('not-a-jwt')).toBe(false)
    expect(isDevDeviceToken('a.!!!.c')).toBe(false)
    // payload が JSON の null
    expect(isDevDeviceToken(dummyJwt(null))).toBe(false)
  })
})

describe('noteDeviceToken / isDevDevice — dev の印 (同期で読む)', () => {
  it('印がまだ無い (トークンを一度も取れていない) あいだは false', () => {
    for (const kind of KINDS) expect(isDevDevice(kind)).toBe(false)
  })

  it('dev のトークンが取れたら、その種類の印だけが立つ', () => {
    noteDeviceToken('kiosk', DEV)
    expect(isDevDevice('kiosk')).toBe(true)
    expect(isDevDevice('manager-device')).toBe(false)
    expect(isDevDevice('bp-station')).toBe(false)
  })

  it('dev でないトークンに替わったら・捨てたら (null) 印は下りる', () => {
    noteDeviceToken('manager-device', DEV)
    noteDeviceToken('manager-device', PLAIN)
    expect(isDevDevice('manager-device')).toBe(false)

    noteDeviceToken('bp-station', DEV)
    noteDeviceToken('bp-station', null)
    expect(isDevDevice('bp-station')).toBe(false)
  })
})

describe('usesAdminToken — 規則の本体', () => {
  it('管理者のトークン + dev の端末 → 管理者では送らない', () => {
    noteDeviceToken('kiosk', DEV)
    expect(usesAdminToken(ADMIN, 'kiosk')).toBe(false)
  })

  it('管理者のトークン + dev でない端末 → 管理者で送る (今までどおり)', () => {
    noteDeviceToken('kiosk', PLAIN)
    expect(usesAdminToken(ADMIN, 'kiosk')).toBe(true)
  })

  it('印がまだ無い → 管理者で送る (今までどおり)', () => {
    expect(usesAdminToken(ADMIN, 'kiosk')).toBe(true)
  })

  it('管理者のトークンが無ければ、印に関わらず管理者では送らない', () => {
    expect(usesAdminToken(null, 'kiosk')).toBe(false)
    expect(usesAdminToken(undefined, 'kiosk')).toBe(false)
    expect(usesAdminToken('', 'kiosk')).toBe(false)
  })

  it('見るのは**その送信が使うはずの端末の鍵**の印だけ (別の種類の印では変わらない)', () => {
    noteDeviceToken('kiosk', DEV)
    expect(usesAdminToken(ADMIN, 'manager-device')).toBe(true)
    expect(usesAdminToken(ADMIN, 'bp-station')).toBe(true)
  })
})

describe('selectSendToken — 付けるトークンを 1 つ選ぶ', () => {
  it('管理者のトークンと dev の端末トークンが両方ある → 端末トークン', async () => {
    noteDeviceToken('kiosk', DEV)
    const getter = vi.fn(async () => DEV)
    await expect(selectSendToken(ADMIN, 'kiosk', getter)).resolves.toBe(DEV)
  })

  it('管理者のトークンと dev でない端末トークン → 管理者のトークン (端末の getter は呼ばない)', async () => {
    noteDeviceToken('kiosk', PLAIN)
    const getter = vi.fn(async () => PLAIN)
    await expect(selectSendToken(ADMIN, 'kiosk', getter)).resolves.toBe(ADMIN)
    expect(getter).not.toHaveBeenCalled()
  })

  it('端末トークンだけ → 端末トークン', async () => {
    await expect(selectSendToken(null, 'kiosk', async () => PLAIN)).resolves.toBe(PLAIN)
    noteDeviceToken('kiosk', DEV)
    await expect(selectSendToken(null, 'kiosk', async () => DEV)).resolves.toBe(DEV)
  })

  it('印がまだ無い → 管理者のトークン (端末トークン取得の待ちを足さない)', async () => {
    const getter = vi.fn(async () => DEV)
    await expect(selectSendToken(ADMIN, 'kiosk', getter)).resolves.toBe(ADMIN)
    expect(getter).not.toHaveBeenCalled()
  })

  it('dev端末でトークンが取れなくても管理者のトークンへは戻さない (本番の行にしない)', async () => {
    noteDeviceToken('kiosk', DEV)
    await expect(selectSendToken(ADMIN, 'kiosk', async () => null)).resolves.toBeNull()
    await expect(selectSendToken(ADMIN, 'kiosk', null)).resolves.toBeNull()
    await expect(selectSendToken(ADMIN, 'kiosk', undefined)).resolves.toBeNull()
  })

  it('どちらも無ければ null', async () => {
    await expect(selectSendToken(null, 'kiosk', null)).resolves.toBeNull()
    await expect(selectSendToken(undefined, 'kiosk', async () => null)).resolves.toBeNull()
  })
})

// 印は reload をまたいで残す (localStorage)。起動時 = module の読み込み時に同期で読むので、
// 「reload 後」は resetModules + dynamic import で作る。
describe('dev の印を localStorage に残す (reload をまたぐ)', () => {
  const KEY = 'alc_dev_device_kiosk'

  /** reload 後の module を読み込む (起動時に localStorage を読む)。 */
  async function reloaded(): Promise<typeof import('~/utils/token-selection')> {
    vi.resetModules()
    return await import('~/utils/token-selection')
  }

  it('dev のトークンが取れたら保存し、dev でないトークンが取れたら消す (kind ごと)', () => {
    noteDeviceToken('kiosk', DEV)
    noteDeviceToken('manager-device', DEV)
    expect(localStorage.getItem(KEY)).toBe('1')
    expect(localStorage.getItem('alc_dev_device_manager-device')).toBe('1')
    expect(localStorage.getItem('alc_dev_device_bp-station')).toBeNull()

    noteDeviceToken('kiosk', PLAIN)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(localStorage.getItem('alc_dev_device_manager-device')).toBe('1')
  })

  it('トークンを捨てただけ (null) では保存した印を消さない — 「取れなかった」と「dev でなくなった」は別', () => {
    noteDeviceToken('kiosk', DEV)
    noteDeviceToken('kiosk', null)

    expect(isDevDevice('kiosk')).toBe(false)
    expect(localStorage.getItem(KEY)).toBe('1')
  })

  it('★ 起動時に印が保存されていれば、端末のトークンをまだ取っていなくても admin を使わない', async () => {
    localStorage.setItem(KEY, '1')
    const mod = await reloaded()
    const getter = vi.fn(async () => DEV)

    expect(mod.isDevDevice('kiosk')).toBe(true)
    expect(mod.isDevDevice('manager-device')).toBe(false)
    expect(mod.usesAdminToken(ADMIN, 'kiosk')).toBe(false)
    await expect(mod.selectSendToken(ADMIN, 'kiosk', getter)).resolves.toBe(DEV)
    // 取り直しに失敗しても admin へは戻さない
    await expect(mod.selectSendToken(ADMIN, 'kiosk', async () => null)).resolves.toBeNull()
  })

  it('★ dev でないトークンが取れたら印が消えて admin に戻る (次の起動でも戻ったまま)', async () => {
    localStorage.setItem(KEY, '1')
    const mod = await reloaded()

    mod.noteDeviceToken('kiosk', PLAIN)

    expect(mod.usesAdminToken(ADMIN, 'kiosk')).toBe(true)
    await expect(mod.selectSendToken(ADMIN, 'kiosk', async () => PLAIN)).resolves.toBe(ADMIN)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect((await reloaded()).isDevDevice('kiosk')).toBe(false)
  })

  it("保存された値が '1' 以外なら印なし", async () => {
    localStorage.setItem(KEY, 'true')
    expect((await reloaded()).isDevDevice('kiosk')).toBe(false)
  })

  it('localStorage が読みで例外を投げても落ちず、印なしで始まる (memory の印は動く)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const mod = await reloaded()

    expect(mod.isDevDevice('kiosk')).toBe(false)
    expect(mod.usesAdminToken(ADMIN, 'kiosk')).toBe(true)
  })

  it('localStorage が書きで例外を投げても落ちず、memory の印だけで動く', async () => {
    const mod = await reloaded()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('quota') })

    expect(() => mod.noteDeviceToken('kiosk', DEV)).not.toThrow()
    expect(mod.isDevDevice('kiosk')).toBe(true)
    expect(() => mod.noteDeviceToken('kiosk', PLAIN)).not.toThrow()
    expect(mod.isDevDevice('kiosk')).toBe(false)
  })

  it('localStorage 自体が無い環境 (SSR) でも読み込める', async () => {
    vi.stubGlobal('localStorage', undefined)
    const mod = await reloaded()

    expect(mod.isDevDevice('kiosk')).toBe(false)
    expect(() => mod.noteDeviceToken('kiosk', DEV)).not.toThrow()
    expect(mod.isDevDevice('kiosk')).toBe(true)
  })
})

describe('clearDevDeviceMark — 画面から dev の印を外す', () => {
  const KEY = 'alc_dev_device_kiosk'

  it('memory と localStorage の両方が消え、管理者のトークンに戻る', async () => {
    noteDeviceToken('kiosk', DEV)
    expect(isDevDevice('kiosk')).toBe(true)
    expect(localStorage.getItem(KEY)).toBe('1')

    clearDevDeviceMark('kiosk')

    expect(isDevDevice('kiosk')).toBe(false)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(usesAdminToken(ADMIN, 'kiosk')).toBe(true)
    await expect(selectSendToken(ADMIN, 'kiosk', async () => DEV)).resolves.toBe(ADMIN)
  })

  it('★ 鍵を抜いたあと (memory の印は下りているが保存した印が残っている) でも保存した印が消える', async () => {
    noteDeviceToken('kiosk', DEV)
    noteDeviceToken('kiosk', null)
    expect(localStorage.getItem(KEY)).toBe('1')

    clearDevDeviceMark('kiosk')

    expect(localStorage.getItem(KEY)).toBeNull()
    // 次の起動でも dev として始まらない
    vi.resetModules()
    expect((await import('~/utils/token-selection')).isDevDevice('kiosk')).toBe(false)
  })

  it('外すのはその種類の印だけ', () => {
    noteDeviceToken('kiosk', DEV)
    noteDeviceToken('manager-device', DEV)

    clearDevDeviceMark('kiosk')

    expect(isDevDevice('manager-device')).toBe(true)
    expect(localStorage.getItem('alc_dev_device_manager-device')).toBe('1')
  })

  it('dev の鍵が挿さったままなら、次にトークンを取った時点でまた印が立つ', () => {
    noteDeviceToken('kiosk', DEV)
    clearDevDeviceMark('kiosk')

    noteDeviceToken('kiosk', DEV)

    expect(isDevDevice('kiosk')).toBe(true)
    expect(localStorage.getItem(KEY)).toBe('1')
  })

  it('localStorage が例外を投げても落ちず、memory の印は消える', () => {
    noteDeviceToken('kiosk', DEV)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })

    expect(() => clearDevDeviceMark('kiosk')).not.toThrow()
    expect(isDevDevice('kiosk')).toBe(false)
  })
})

describe('devSignalingToken — dev端末が signaling へ付けるトークン (取れなければ繋がない)', () => {
  it('端末のトークンが取れたら、それを返す', async () => {
    const getter = vi.fn(async () => DEV)

    await expect(devSignalingToken(getter)).resolves.toBe(DEV)
    expect(getter).toHaveBeenCalledTimes(1)
  })

  it('getter が null を返したら throw する (管理者のトークンへも token なしへも落とさない)', async () => {
    await expect(devSignalingToken(async () => null)).rejects.toThrow(DEV_SIGNALING_TOKEN_UNAVAILABLE_MESSAGE)
  })

  it.each([[null], [undefined]])('getter が無い (%s) なら throw する', async (getter) => {
    await expect(devSignalingToken(getter)).rejects.toThrow(DEV_SIGNALING_TOKEN_UNAVAILABLE_MESSAGE)
  })
})
