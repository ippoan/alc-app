import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoDriverInfoPanel from '~/components/TenkoDriverInfoPanel.vue'

// 運転者情報パネルが**どの資格で読むか** (Refs ippoan/alc-app#387)。
// 遠隔点呼モニターからは `'tenko-monitor'`、それ以外の画面 (日次の健康状態) は既定のまま。

const getDriverInfoMock = vi.fn(async (..._args: unknown[]) => null)

vi.mock('~/utils/api', () => ({
  getDriverInfo: (...args: unknown[]) => getDriverInfoMock(...args),
}))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const EMPLOYEE_ID = 'aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa'

describe('TenkoDriverInfoPanel — 読むときの scope', () => {
  beforeEach(() => {
    getDriverInfoMock.mockClear()
  })

  it('scope を渡さなければ既定 (\'default\') で読む', async () => {
    const wrapper = await mountSuspended(TenkoDriverInfoPanel, { props: { employeeId: EMPLOYEE_ID } })
    await flush()

    expect(getDriverInfoMock.mock.calls).toEqual([[EMPLOYEE_ID, 'default']])
    wrapper.unmount()
  })

  it('遠隔点呼モニターが渡した scope (\'tenko-monitor\') で読む', async () => {
    const wrapper = await mountSuspended(TenkoDriverInfoPanel, {
      props: { employeeId: EMPLOYEE_ID, scope: 'tenko-monitor' },
    })
    await flush()

    expect(getDriverInfoMock.mock.calls).toEqual([[EMPLOYEE_ID, 'tenko-monitor']])
    wrapper.unmount()
  })
})
