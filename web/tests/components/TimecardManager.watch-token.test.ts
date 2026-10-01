// 打刻の管理画面 (TimecardManager) が打刻更新の購読に使うトークン (Refs ippoan/alc-app#387)。
//
// 打刻の合図は dev / 本番で分かれている (cf-alc-recorder)。dev端末 (開発用の鍵) では
// 管理者ログインがあっても端末のトークンで購読しないと、本番の打刻で引き直しに行き、
// 自分の打刻では引き直さない。規則は送信と同じ `selectSendToken`。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TimecardManager from '~/components/TimecardManager.vue'
import { noteDeviceToken } from '~/utils/token-selection'
import { browserJwt, devDeviceJwt, plainDeviceJwt } from '../helpers/dummy-jwt'

const ADMIN = browserJwt()
const DEV = devDeviceJwt()
const PLAIN = plainDeviceJwt()

vi.mock('~/utils/api', () => ({
  getEmployees: vi.fn(async () => []),
  listTimecardCards: vi.fn(async () => []),
  createTimecardCard: vi.fn(async () => ({})),
  deleteTimecardCard: vi.fn(async () => {}),
  listTimePunches: vi.fn(async () => ({ punches: [], total: 0 })),
  downloadTimePunchesCsv: vi.fn(async () => {}),
}))

const accessToken = ref<string | null>(null)
mockNuxtImport('useAuth', () => () => ({ accessToken }))

const getDeviceJwtMock = vi.fn(async (): Promise<string | null> => null)
mockNuxtImport('useDeviceToken', () => () => ({ getDeviceJwt: getDeviceJwtMock }))

let getToken: (() => string | null | Promise<string | null>) | null = null
mockNuxtImport('useTimecardWatch', () => (options: { getToken: () => string | null | Promise<string | null> }) => {
  getToken = options.getToken
  return { isConnected: ref(false), connect: vi.fn(async () => {}), stop: vi.fn() }
})

beforeEach(() => {
  getToken = null
  accessToken.value = null
  getDeviceJwtMock.mockReset()
  getDeviceJwtMock.mockResolvedValue(null)
})

afterEach(() => {
  noteDeviceToken('kiosk', null)
  localStorage.clear()
})

describe('TimecardManager — 購読のトークン', () => {
  it('dev の印が無ければ管理者のトークン (従来どおり。端末のトークンは取りに行かない)', async () => {
    accessToken.value = ADMIN
    const wrapper = await mountSuspended(TimecardManager)

    await expect(Promise.resolve(getToken!())).resolves.toBe(ADMIN)
    expect(getDeviceJwtMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('dev でない端末のトークンが取れている端末でも管理者のトークン (従来どおり)', async () => {
    accessToken.value = ADMIN
    noteDeviceToken('kiosk', PLAIN)
    getDeviceJwtMock.mockResolvedValue(PLAIN)
    const wrapper = await mountSuspended(TimecardManager)

    await expect(Promise.resolve(getToken!())).resolves.toBe(ADMIN)
    wrapper.unmount()
  })

  it('★ dev の印がある端末では、管理者ログインがあっても端末のトークン', async () => {
    accessToken.value = ADMIN
    noteDeviceToken('kiosk', DEV)
    getDeviceJwtMock.mockResolvedValue(DEV)
    const wrapper = await mountSuspended(TimecardManager)

    await expect(Promise.resolve(getToken!())).resolves.toBe(DEV)
    wrapper.unmount()
  })

  it('dev端末で端末のトークンが取れなくても管理者のトークンへは戻さない (本番の合図を購読しない)', async () => {
    accessToken.value = ADMIN
    noteDeviceToken('kiosk', DEV)
    getDeviceJwtMock.mockResolvedValue(null)
    const wrapper = await mountSuspended(TimecardManager)

    await expect(Promise.resolve(getToken!())).resolves.toBeNull()
    wrapper.unmount()
  })
})
