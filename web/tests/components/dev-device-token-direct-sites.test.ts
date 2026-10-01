// トークンを直に選んでいた 3 か所 (Refs ippoan/alc-app#387)。
//
// どれも api.ts を通らずに自前でトークンを付けていたので、api.ts と同じ規則
// (`selectSendToken`) に乗せた。ここで固定するのは「dev端末のとき、送信に付くのはどれか」と
// 「dev でない端末は今までどおり」の 2 つ:
//
//   - TodayPunchHistory.vue … 打刻更新の購読 (WS) に使うトークン
//   - GuidanceRecordNode.vue … 添付の取得に付ける Authorization
//   - pages/print.vue … 印刷の server route に付ける Authorization
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TodayPunchHistory from '~/components/TodayPunchHistory.vue'
import GuidanceRecordNode from '~/components/GuidanceRecordNode.vue'
import PrintPage from '~/pages/print.vue'
import { noteDeviceToken } from '~/utils/token-selection'
import { browserJwt, devDeviceJwt, plainDeviceJwt } from '../helpers/dummy-jwt'

const ADMIN_JWT = browserJwt()
const DEV_JWT = devDeviceJwt()
const PLAIN_JWT = plainDeviceJwt()

vi.mock('~/utils/api', () => ({
  listTimePunches: vi.fn(async () => ({ punches: [] })),
  getEmployees: vi.fn(async () => []),
}))

const accessToken = ref<string | null>(null)
mockNuxtImport('useAuth', () => () => ({
  accessToken,
  deviceTenantId: ref('test-tenant'),
}))

const getDeviceJwt = vi.fn(async () => null as string | null)
mockNuxtImport('useDeviceToken', () => () => ({
  getDeviceJwt,
  hasDeviceJwt: ref(false),
}))

let watchOptions: { getToken: () => unknown } | null = null
mockNuxtImport('useTimecardWatch', () => (options: { getToken: () => unknown }) => {
  watchOptions = options
  return { isConnected: ref(false), connect: vi.fn(async () => {}), stop: vi.fn() }
})

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  accessToken.value = null
  getDeviceJwt.mockReset()
  getDeviceJwt.mockResolvedValue(null)
  watchOptions = null
})

afterEach(() => {
  noteDeviceToken('kiosk', null)
  localStorage.removeItem('alc_dev_device_kiosk')
  vi.unstubAllGlobals()
})

describe('TodayPunchHistory — 打刻更新の購読に使うトークン', () => {
  async function tokenForWatch(): Promise<unknown> {
    const wrapper = await mountSuspended(TodayPunchHistory)
    const token = await watchOptions!.getToken()
    wrapper.unmount()
    return token
  }

  it('★ 管理者ログイン + dev のキオスク → 端末の鍵のトークン', async () => {
    accessToken.value = ADMIN_JWT
    getDeviceJwt.mockResolvedValue(DEV_JWT)
    noteDeviceToken('kiosk', DEV_JWT)

    expect(await tokenForWatch()).toBe(DEV_JWT)
  })

  it('管理者ログイン + dev でないキオスク → 管理者のトークン (今までどおり)', async () => {
    accessToken.value = ADMIN_JWT
    getDeviceJwt.mockResolvedValue(PLAIN_JWT)
    noteDeviceToken('kiosk', PLAIN_JWT)

    expect(await tokenForWatch()).toBe(ADMIN_JWT)
    expect(getDeviceJwt).not.toHaveBeenCalled()
  })

  it('管理者ログイン無し → 端末の鍵のトークン (今までどおり)', async () => {
    getDeviceJwt.mockResolvedValue(PLAIN_JWT)

    expect(await tokenForWatch()).toBe(PLAIN_JWT)
  })

  it('どちらも無ければ null (WS を張らずポーリングに落ちる)', async () => {
    expect(await tokenForWatch()).toBeNull()
  })
})

describe('GuidanceRecordNode — 添付の取得に付ける Authorization', () => {
  const record = {
    id: 'r1',
    title: '指導',
    depth: 0,
    children: [],
    attachments: [{ id: 'a1', record_id: 'r1', file_name: 'a.png', file_type: 'image/png', file_size: 10 }],
  }

  async function headersOfAttachmentFetch(): Promise<Headers> {
    const fetchMock = vi.fn(async () => ({ ok: false }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = await mountSuspended(GuidanceRecordNode, {
      props: { record: record as never, depth: 0, expandedIds: new Set<string>(), uploadingId: null },
    })
    await flush()
    wrapper.unmount()
    const call = fetchMock.mock.calls.find(c => String((c as unknown[])[0]).includes('/api/guidance-records/r1/attachments/a1'))
    expect(call).toBeDefined()
    return new Headers(((call as unknown[])[1] as RequestInit).headers)
  }

  it('★ 管理者ログイン + dev のキオスク → 管理者のトークンを付けない', async () => {
    accessToken.value = ADMIN_JWT
    noteDeviceToken('kiosk', DEV_JWT)

    const h = await headersOfAttachmentFetch()
    expect(h.get('Authorization')).toBeNull()
  })

  it('管理者ログイン + dev でないキオスク → 管理者のトークン (今までどおり)', async () => {
    accessToken.value = ADMIN_JWT
    noteDeviceToken('kiosk', PLAIN_JWT)

    const h = await headersOfAttachmentFetch()
    expect(h.get('Authorization')).toBe(`Bearer ${ADMIN_JWT}`)
    expect(h.get('X-Tenant-ID')).toBe('test-tenant')
  })

  it('管理者ログイン無し → Authorization 無し・X-Tenant-ID だけ (今までどおり)', async () => {
    const h = await headersOfAttachmentFetch()
    expect(h.get('Authorization')).toBeNull()
    expect(h.get('X-Tenant-ID')).toBe('test-tenant')
  })
})

describe('pages/print.vue — 印刷の server route に付ける Authorization', () => {
  async function headersOfDeviceList(): Promise<Record<string, string>> {
    const fetchMock = vi.fn(async () => ({ devices: [] }))
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = await mountSuspended(PrintPage)
    await flush()
    wrapper.unmount()
    const call = fetchMock.mock.calls.find(c => (c as unknown[])[0] === '/api/print/devices')
    expect(call).toBeDefined()
    return ((call as unknown[])[1] as { headers: Record<string, string> }).headers
  }

  it('★ 管理者ログイン + dev のキオスク → 管理者のトークンを付けない', async () => {
    accessToken.value = ADMIN_JWT
    noteDeviceToken('kiosk', DEV_JWT)

    expect(await headersOfDeviceList()).toEqual({})
  })

  it('管理者ログイン + dev でないキオスク → 管理者のトークン (今までどおり)', async () => {
    accessToken.value = ADMIN_JWT

    expect(await headersOfDeviceList()).toEqual({ Authorization: `Bearer ${ADMIN_JWT}` })
  })

  it('管理者ログイン無し → Authorization 無し (今までどおり)', async () => {
    expect(await headersOfDeviceList()).toEqual({})
  })

  it('印刷の送信にも同じ規則が効く (dev でなければ管理者のトークン + Content-Type)', async () => {
    accessToken.value = ADMIN_JWT
    const fetchMock = vi.fn(async (url: string) => url === '/api/print/devices' ? { devices: ['p1'] } : { ok: true })
    vi.stubGlobal('$fetch', fetchMock)
    localStorage.setItem('alc-print:last-pdf', JSON.stringify({ name: 'a.pdf', base64: 'AAAA' }))
    const wrapper = await mountSuspended(PrintPage)
    await flush()

    const buttons = wrapper.findAll('button')
    await buttons.find(b => b.text().includes('前回のファイルを使う'))!.trigger('click')
    await buttons.find(b => b.text().includes('印刷する'))!.trigger('click')
    await flush()
    wrapper.unmount()
    localStorage.removeItem('alc-print:last-pdf')

    const call = fetchMock.mock.calls.find(c => (c as unknown[])[0] === '/api/print/p1')
    expect(call).toBeDefined()
    expect(((call as unknown[])[1] as { headers: Record<string, string> }).headers).toEqual({
      'Authorization': `Bearer ${ADMIN_JWT}`,
      'Content-Type': 'application/json',
    })
  })
})
