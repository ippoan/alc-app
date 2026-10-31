import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly, defineComponent, h } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { addThisDeviceFinger, useVeinAddDevice, VEIN_ADD_NO_RECORD_MESSAGE } from '~/composables/useVeinAddDevice'
import { VEIN_ENROLL_FULL_MESSAGE, VEIN_ENROLL_RETAKE_MESSAGE } from '~/composables/useVeinEnroll'
import { VEIN_RECORD_BROKEN } from '~/composables/useVeinSerial'

/**
 * 「この端末の指を足す」(Refs ippoan/alc-app#558)。サーバーの口・対応表・同期は差し替え、
 * 手順 (撮る → 預ける → 設定に従って置く) と失敗のときの後始末を確かめる。従業員は合成値
 */

const api = vi.hoisted(() => ({ putVeinModuleDeviceRecord: vi.fn() }))
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
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

const sync = vi.hoisted(() => ({ syncVeinModule: vi.fn() }))
vi.mock('~/utils/vein-module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/vein-module')>()),
  ...sync,
}))

const diag = vi.hoisted(() => ({ appendDiag: vi.fn() }))
vi.mock('~/utils/serialDiagLog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/serialDiagLog')>()),
  ...diag,
}))

const RECORD = new Uint8Array([0xDE, 0xED, 0xDE, 0xED])

function makePort() {
  return {
    isConnected: ref(true),
    syncWrite: vi.fn(async () => {}),
    syncClear: vi.fn(async () => {}),
    say: vi.fn(async () => {}),
    enroll: vi.fn(async () => RECORD),
  }
}

beforeEach(() => {
  localStorage.clear()
  api.putVeinModuleDeviceRecord.mockReset().mockResolvedValue({ employee_id: 'emp-test-1', updated_at: 'v-server' })
  db.loadVeinModuleEntries.mockReset().mockResolvedValue([
    { employeeId: 'emp-other', moduleId: 10, updatedAt: 'v1', approved: true },
    { employeeId: 'emp-test-1', moduleId: 11, updatedAt: 'v0', approved: true },
  ])
  db.putVeinModuleEntry.mockReset().mockResolvedValue(undefined)
  db.deleteVeinModuleEntry.mockReset().mockResolvedValue(undefined)
  sync.syncVeinModule.mockReset().mockResolvedValue(true)
  diag.appendDiag.mockReset()
})

const connected = ref(true)
const enroll = vi.fn()
const say = vi.fn()
const syncClear = vi.fn()

mockNuxtImport('useVeinSerial', () => () => ({
  isSupported: true,
  isConnected: readonly(connected),
  say,
  enroll,
  syncClear,
  syncWrite: vi.fn(),
}))

describe('addThisDeviceFinger', () => {
  it('その人の ID に VEIN ENROLL → 端末の鍵で預ける。native の設定ならその場の記録を native で残し、同期は走らせない', async () => {
    localStorage.setItem('alc-vein-added-finger', 'native')
    const port = makePort()
    const onPlace = vi.fn()
    await addThisDeviceFinger(port, 'emp-test-1', 'manager-device', onPlace)

    // 登録は ENROLL が先にその ID を消すので、対応表から先に外す
    expect(db.deleteVeinModuleEntry).toHaveBeenCalledWith('emp-test-1')
    expect(port.say).toHaveBeenCalledWith('PLACE')
    expect(port.enroll).toHaveBeenCalledWith(11, onPlace)
    expect(api.putVeinModuleDeviceRecord).toHaveBeenCalledWith('emp-test-1', RECORD, 'manager-device')
    expect(db.putVeinModuleEntry).toHaveBeenCalledWith({
      employeeId: 'emp-test-1', moduleId: 11, updatedAt: 'v-server', approved: true, native: true,
    })
    expect(sync.syncVeinModule).not.toHaveBeenCalled()
    expect(port.syncClear).not.toHaveBeenCalled()
  })

  it('mixed (既定) なら、続けて同期を走らせて混ぜた記録を書かせる (同じ鍵で)', async () => {
    const port = makePort()
    await addThisDeviceFinger(port, 'emp-test-1', 'bp-station')
    expect(db.putVeinModuleEntry).toHaveBeenCalledWith(expect.objectContaining({ moduleId: 11, native: true }))
    expect(sync.syncVeinModule).toHaveBeenCalledWith(port, { scope: 'bp-station' })
    // 対応表に入れてから同期する (同期が native の記録を書き直す)
    expect(db.putVeinModuleEntry.mock.invocationCallOrder[0]).toBeLessThan(sync.syncVeinModule.mock.invocationCallOrder[0]!)
  })

  it('対応表に無い人は空いている ID に撮る (外すものが無いので delete しない)', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([])
    const port = makePort()
    await addThisDeviceFinger(port, 'emp-test-1', 'default')
    expect(db.deleteVeinModuleEntry).not.toHaveBeenCalled()
    expect(port.enroll).toHaveBeenCalledWith(10, undefined)
  })

  it('ID が空いていなければ撮らずに「これ以上登録できません」', async () => {
    db.loadVeinModuleEntries.mockResolvedValue(
      Array.from({ length: 91 }, (_, i) => ({ employeeId: `emp-${i}`, moduleId: 10 + i, updatedAt: 'v', approved: true })),
    )
    const port = makePort()
    await expect(addThisDeviceFinger(port, 'emp-test-1', 'default')).rejects.toThrow(VEIN_ENROLL_FULL_MESSAGE)
    expect(port.enroll).not.toHaveBeenCalled()
  })

  it('409 no_approved_module_record は日本語の案内にし、モジュールの記録を消す', async () => {
    api.putVeinModuleDeviceRecord.mockRejectedValue(new Error('API エラー (409): {"error":"no_approved_module_record"}'))
    const port = makePort()
    await expect(addThisDeviceFinger(port, 'emp-test-1', 'default')).rejects.toThrow(VEIN_ADD_NO_RECORD_MESSAGE)
    expect(port.syncClear).toHaveBeenCalledWith(11)
    expect(db.putVeinModuleEntry).not.toHaveBeenCalled()
    expect(sync.syncVeinModule).not.toHaveBeenCalled()
  })

  it('その他の預け失敗 (422 など) もモジュールを消して、そのまま投げる。消すのに失敗しても握り潰す', async () => {
    const err = new Error('API エラー (422): {"error":"bad_record","message":"記録が壊れています"}')
    api.putVeinModuleDeviceRecord.mockRejectedValue(err)
    const port = makePort()
    port.syncClear.mockRejectedValue(new Error('RC=01'))
    await expect(addThisDeviceFinger(port, 'emp-test-1', 'default')).rejects.toBe(err)
    expect(port.syncClear).toHaveBeenCalledWith(11)
  })

  it('重複 (RC=0A) は理由のまま投げる (画面の文言は veinErrorMessage)。預けない・対応表に入れない', async () => {
    const port = makePort()
    port.enroll.mockRejectedValue(new Error('RC=0A'))
    await expect(addThisDeviceFinger(port, 'emp-test-1', 'default')).rejects.toThrow('RC=0A')
    expect(api.putVeinModuleDeviceRecord).not.toHaveBeenCalled()
    expect(db.putVeinModuleEntry).not.toHaveBeenCalled()
  })

  it('置き直しの照合が外れた (RETAKE) は撮り直しの案内。モジュールからは消えているので消さない', async () => {
    const port = makePort()
    port.enroll.mockRejectedValue(new Error('RETAKE'))
    await expect(addThisDeviceFinger(port, 'emp-test-1', 'default')).rejects.toThrow(VEIN_ENROLL_RETAKE_MESSAGE)
    expect(port.syncClear).not.toHaveBeenCalled()
  })

  it('行が壊れて受け取れなかった記録はモジュールに残さず、撮り直しの案内', async () => {
    const port = makePort()
    port.enroll.mockRejectedValue(new Error(VEIN_RECORD_BROKEN))
    await expect(addThisDeviceFinger(port, 'emp-test-1', 'default')).rejects.toThrow(VEIN_ENROLL_RETAKE_MESSAGE)
    expect(port.syncClear).toHaveBeenCalledWith(11)
    expect(api.putVeinModuleDeviceRecord).not.toHaveBeenCalled()
  })
})

describe('useVeinAddDevice', () => {
  async function setup(scope: 'manager-device' | 'default' = 'default') {
    let add!: ReturnType<typeof useVeinAddDevice>
    await mountSuspended(defineComponent({
      setup() { add = useVeinAddDevice({ scope }); return () => h('div') },
    }))
    return add
  }

  beforeEach(() => {
    connected.value = true
    enroll.mockReset().mockResolvedValue(RECORD)
    say.mockReset().mockResolvedValue(undefined)
    syncClear.mockReset().mockResolvedValue(undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('足せたら案内 ENROLLED を鳴らして added。置き直しの案内を出し、終わったら消す', async () => {
    localStorage.setItem('alc-vein-added-finger', 'native')
    const add = await setup('manager-device')
    expect(add.available.value).toBe(true)
    let seen: Array<string | null> = []
    enroll.mockImplementation(async (_id: number, onPlace: (n: number, total?: number) => void) => {
      onPlace(2)
      seen.push(add.notice.value)
      onPlace(3, 6)
      seen.push(add.notice.value)
      return RECORD
    })
    expect(await add.add('emp-test-1')).toBe(true)
    expect(seen).toEqual(['もう一度置いてください (2 回目)', 'もう一度置いてください (3/6)'])
    expect(add.notice.value).toBeNull()
    expect(add.added.value).toBe(true)
    expect(add.adding.value).toBe(false)
    expect(say).toHaveBeenCalledWith('ENROLLED')
    expect(api.putVeinModuleDeviceRecord).toHaveBeenCalledWith('emp-test-1', RECORD, 'manager-device')
    add.reset()
    expect(add.added.value).toBe(false)
  })

  it('失敗は画面の文言 (重複は RC=0A の案内) にして、診断ログに残し、案内 FAILED を鳴らす (鳴らせなくても握り潰す)', async () => {
    const add = await setup()
    enroll.mockRejectedValue(new Error('RC=0A'))
    say.mockImplementation(async (x: string) => { if (x === 'FAILED') throw new Error('NO_PORT') })
    expect(await add.add('emp-test-1')).toBe(false)
    expect(add.error.value).toContain('この指は、この端末にすでに別の登録があります')
    expect(add.error.value).toContain('(RC=0A)')
    expect(add.added.value).toBe(false)
    expect(diag.appendDiag).toHaveBeenCalledWith('[vein] この端末の指を足せませんでした: RC=0A')
    add.reset()
    expect(add.error.value).toBeNull()
  })

  it('Error でない失敗も文字列にして残す。ENROLLED が鳴らせなくても足せたことにする', async () => {
    const add = await setup()
    enroll.mockRejectedValueOnce('boom')
    expect(await add.add('emp-test-1')).toBe(false)
    expect(diag.appendDiag).toHaveBeenCalledWith('[vein] この端末の指を足せませんでした: boom')
    say.mockImplementation(async (x: string) => { if (x === 'ENROLLED') throw new Error('NO_PORT') })
    expect(await add.add('emp-test-1')).toBe(true)
    expect(add.error.value).toBeNull()
  })

  it('未接続・足している最中は何もしない', async () => {
    const add = await setup()
    connected.value = false
    expect(add.available.value).toBe(false)
    expect(await add.add('emp-test-1')).toBe(false)
    expect(enroll).not.toHaveBeenCalled()

    connected.value = true
    const first = add.add('emp-test-1')
    expect(await add.add('emp-test-1')).toBe(false)
    await first
    expect(enroll).toHaveBeenCalledTimes(1)
  })
})
