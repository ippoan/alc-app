// 送るトークンの選び方 (Refs ippoan/alc-app#387)。
//
// 規則は 1 つ: **その送信で使える端末の鍵のトークンに claim `dev_device` があれば、管理者の
// トークンより先にそれを使う。無ければ今までの優先順位 (管理者 → 端末) のまま。**
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  isDevDevice, isDevDeviceToken, noteDeviceToken, selectSendToken, usesAdminToken,
  type DeviceTokenKind,
} from '~/utils/token-selection'
import { browserJwt, devDeviceJwt, dummyJwt, plainDeviceJwt } from '../helpers/dummy-jwt'

const ADMIN = browserJwt()
const DEV = devDeviceJwt()
const PLAIN = plainDeviceJwt()
const KINDS: DeviceTokenKind[] = ['kiosk', 'manager-device', 'bp-station']

afterEach(() => {
  for (const kind of KINDS) noteDeviceToken(kind, null)
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
