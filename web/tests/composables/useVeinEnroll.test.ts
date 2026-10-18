import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly, defineComponent, h } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useVeinEnroll } from '~/composables/useVeinEnroll'

/**
 * 指静脈の登録手順 (Refs ippoan/vein-match#20)。画面からは押せない呼び方
 * (未接続・読み取り中の 2 度押し・Error でない失敗) をここで確かめる。
 * 画面の手順そのものは register.test.ts / VeinRegistration.test.ts。
 */

const veinIsConnected = ref(true)
const veinCapture = vi.fn(async () => 'AABBCC')
const veinSay = vi.fn(async () => {})

mockNuxtImport('useVeinSerial', () => () => ({
  isSupported: true,
  isConnected: readonly(veinIsConnected),
  connect: vi.fn(async () => true),
  capture: veinCapture,
  say: veinSay,
}))

const { putVeinTemplateMock } = vi.hoisted(() => ({ putVeinTemplateMock: vi.fn() }))
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  putVeinTemplate: putVeinTemplateMock,
}))

async function setup() {
  let vein!: ReturnType<typeof useVeinEnroll>
  await mountSuspended(defineComponent({
    setup() { vein = useVeinEnroll(); return () => h('div') },
  }))
  return vein
}

describe('useVeinEnroll', () => {
  beforeEach(() => {
    veinIsConnected.value = true
    veinCapture.mockReset().mockResolvedValue('AABBCC')
    veinSay.mockReset().mockResolvedValue(undefined)
    putVeinTemplateMock.mockReset().mockResolvedValue({ employee_id: 'emp-test-1', updated_at: '2026-10-18T00:00:00Z' })
  })

  it('未接続なら何もしない', async () => {
    veinIsConnected.value = false
    const vein = await setup()
    await vein.enroll('emp-test-1')
    expect(veinSay).not.toHaveBeenCalled()
  })

  it('読み取り中の 2 度目は無視する', async () => {
    const vein = await setup()
    const first = vein.enroll('emp-test-1')
    await vein.enroll('emp-test-1')
    await first
    expect(putVeinTemplateMock).toHaveBeenCalledTimes(1)
    expect(vein.registered.value).toBe(true)
  })

  it('Error でない失敗は既定の文言にし、FAILED の案内が失敗しても握り潰す', async () => {
    const vein = await setup()
    putVeinTemplateMock.mockRejectedValueOnce('boom')
    veinSay.mockImplementation(async (x: string) => { if (x === 'FAILED') throw new Error('NO_PORT') })
    await vein.enroll('emp-test-1')
    await flushPromises()
    expect(vein.error.value).toBe('指静脈登録エラー')
    expect(vein.registering.value).toBe(false)
    vein.reset()
    expect(vein.error.value).toBeNull()
  })
})
