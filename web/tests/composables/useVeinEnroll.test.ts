import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly, defineComponent, h } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useVeinEnroll, VEIN_ENROLL_FULL_MESSAGE, VEIN_ENROLL_RETAKE_MESSAGE } from '~/composables/useVeinEnroll'
import { VEIN_RECORD_BROKEN } from '~/composables/useVeinSerial'

/**
 * 指静脈の登録手順 (Refs ippoan/vein-match#20)。画面からは押せない呼び方
 * (未接続・読み取り中の 2 度押し・Error でない失敗) をここで確かめる。
 * 画面の手順そのものは register.test.ts / VeinRegistration.test.ts。
 */

const veinIsConnected = ref(true)
const veinCapture = vi.fn(async () => 'AABBCC')
const veinSay = vi.fn(async () => {})

const veinEnroll = vi.fn()
const veinSyncClear = vi.fn()

mockNuxtImport('useVeinSerial', () => () => ({
  isSupported: true,
  isConnected: readonly(veinIsConnected),
  connect: vi.fn(async () => true),
  capture: veinCapture,
  say: veinSay,
  enroll: veinEnroll,
  syncClear: veinSyncClear,
}))

const { putVeinTemplateMock, putVeinModuleRecordMock } = vi.hoisted(() => ({
  putVeinTemplateMock: vi.fn(),
  putVeinModuleRecordMock: vi.fn(),
}))
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  putVeinTemplate: putVeinTemplateMock,
  putVeinModuleRecord: putVeinModuleRecordMock,
}))

// モジュール経路の判定 (usesVeinModule) と手元の対応表 (Refs ippoan/alc-app#436)。ID の割り振りは本物 (vein-module.test.ts)
const viaModule = vi.hoisted(() => ({ on: false }))
vi.mock('~/utils/vein-module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/vein-module')>()),
  usesVeinModule: () => viaModule.on,
}))
const db = vi.hoisted(() => ({
  loadVeinModuleEntries: vi.fn(),
  putVeinModuleEntry: vi.fn(),
  deleteVeinModuleEntry: vi.fn(),
}))
vi.mock('~/utils/vein-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/vein-db')>()),
  ...db,
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
    viaModule.on = false
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

  describe('測定台以外の端末: モジュールに登録する (M-b、Refs ippoan/alc-app#436)', () => {
    const RECORD = new Uint8Array([0xDE, 0xED, 0xDE, 0xED])

    beforeEach(() => {
      viaModule.on = true
      veinEnroll.mockReset().mockResolvedValue(RECORD)
      veinSyncClear.mockReset().mockResolvedValue(undefined)
      putVeinModuleRecordMock.mockReset().mockResolvedValue({ employee_id: 'emp-test-1', updated_at: '2026-10-21T00:00:00Z' })
      db.loadVeinModuleEntries.mockReset().mockResolvedValue([
        { employeeId: 'emp-other', moduleId: 10, updatedAt: 'v1', approved: true },
      ])
      db.putVeinModuleEntry.mockReset().mockResolvedValue(undefined)
      db.deleteVeinModuleEntry.mockReset().mockResolvedValue(undefined)
    })

    it('空いている ID に VEIN ENROLL → 記録を預ける → 対応表に承認待ちで入れる。置き直しの案内を出す', async () => {
      const vein = await setup()
      let seenNotice: string | null = null
      veinEnroll.mockImplementation(async (_id: number, onPlace: (n: number) => void) => {
        onPlace(2)
        seenNotice = vein.notice.value
        return RECORD
      })
      await vein.enroll('emp-test-1')

      expect(veinEnroll).toHaveBeenCalledWith(11, expect.any(Function))
      expect(seenNotice).toBe('もう一度置いてください (2/3)')
      expect(db.deleteVeinModuleEntry).toHaveBeenCalledWith('emp-test-1')
      expect(putVeinModuleRecordMock).toHaveBeenCalledWith('emp-test-1', RECORD)
      expect(db.putVeinModuleEntry).toHaveBeenCalledWith({
        employeeId: 'emp-test-1', moduleId: 11, updatedAt: '2026-10-21T00:00:00Z', approved: false,
      })
      expect(veinSay.mock.calls.map(c => c[0])).toEqual(['PLACE', 'ENROLLED'])
      expect(veinCapture).not.toHaveBeenCalled()
      expect(putVeinTemplateMock).not.toHaveBeenCalled()
      expect(vein.registered.value).toBe(true)
      expect(vein.notice.value).toBeNull()
    })

    it('10〜100 が埋まっていれば読み取らずに「これ以上登録できません」', async () => {
      db.loadVeinModuleEntries.mockResolvedValue(
        Array.from({ length: 91 }, (_, i) => ({ employeeId: `e${i}`, moduleId: 10 + i, updatedAt: 'v1', approved: true })),
      )
      const vein = await setup()
      await vein.enroll('emp-test-1')
      expect(veinEnroll).not.toHaveBeenCalled()
      expect(vein.error.value).toBe(VEIN_ENROLL_FULL_MESSAGE)
    })

    it('ERR VEIN RETAKE は「もう一度、最初から登録してください」で終える (繰り返さない)', async () => {
      veinEnroll.mockRejectedValue(new Error('RETAKE'))
      const vein = await setup()
      await vein.enroll('emp-test-1')
      expect(veinEnroll).toHaveBeenCalledTimes(1)
      expect(vein.error.value).toBe(VEIN_ENROLL_RETAKE_MESSAGE)
      expect(veinSyncClear).not.toHaveBeenCalled()
      expect(veinSay).toHaveBeenLastCalledWith('FAILED')
    })

    it('記録の行が壊れていたらモジュールから消して撮り直し (消せなくても続ける)', async () => {
      veinEnroll.mockRejectedValue(new Error(VEIN_RECORD_BROKEN))
      veinSyncClear.mockRejectedValue(new Error('RC=01'))
      const vein = await setup()
      await vein.enroll('emp-test-1')
      expect(veinSyncClear).toHaveBeenCalledWith(11)
      expect(vein.error.value).toBe(VEIN_ENROLL_RETAKE_MESSAGE)
    })

    it('ほかの読み取りの失敗は reason のまま', async () => {
      veinEnroll.mockRejectedValue(new Error('TIMEOUT'))
      const vein = await setup()
      await vein.enroll('emp-test-1')
      expect(vein.error.value).toBe('TIMEOUT')
      expect(putVeinModuleRecordMock).not.toHaveBeenCalled()
    })

    it('上限の 409 は「これ以上登録できません」。預からなかった記録はモジュールから消す', async () => {
      putVeinModuleRecordMock.mockRejectedValue(
        new Error('API エラー (409): {"error":"too_many_module_records","message":"上限です"}'),
      )
      const vein = await setup()
      await vein.enroll('emp-test-1')
      expect(veinSyncClear).toHaveBeenCalledWith(11)
      expect(vein.error.value).toBe(VEIN_ENROLL_FULL_MESSAGE)
      expect(db.putVeinModuleEntry).not.toHaveBeenCalled()
    })

    it('ほかの保存の失敗はサーバーの理由を出す (記録はモジュールから消す)', async () => {
      putVeinModuleRecordMock.mockRejectedValue(
        new Error('API エラー (422): {"error":"invalid_module_record","message":"記録が空です"}'),
      )
      const vein = await setup()
      await vein.enroll('emp-test-1')
      expect(veinSyncClear).toHaveBeenCalledWith(11)
      expect(vein.error.value).toBe('記録が空です')
    })
  })
})
