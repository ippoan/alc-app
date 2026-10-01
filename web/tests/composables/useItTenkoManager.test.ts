import { describe, it, expect, vi, beforeEach } from 'vitest'

// IT点呼 の受け画面専用の「この席の運行管理者」(Refs ippoan/alc-app#387)。
// 席 (localStorage) に覚えさせるのは社員の id だけ。名前と権限は load のたびに取り直す。

const getEmployeeByIdMock = vi.fn()
const getEmployeeByCodeMock = vi.fn()
const lookupEmployeeByCardMock = vi.fn()

vi.mock('~/utils/api', async importOriginal => ({
  // 席の鍵が取れないときに `request()` が投げる文言。実物の定数をそのまま使う
  MANAGER_DEVICE_AUTH_FAILED_MESSAGE: (await importOriginal<typeof import('~/utils/api')>()).MANAGER_DEVICE_AUTH_FAILED_MESSAGE,
  getEmployeeById: (...args: unknown[]) => getEmployeeByIdMock(...args),
  getEmployeeByCode: (...args: unknown[]) => getEmployeeByCodeMock(...args),
  lookupEmployeeByCard: (...args: unknown[]) => lookupEmployeeByCardMock(...args),
}))

import { MANAGER_DEVICE_AUTH_FAILED_MESSAGE } from '~/utils/api'
import {
  IT_TENKO_CARD_LOOKUP_FAILED_MESSAGE,
  IT_TENKO_CARD_NOT_REGISTERED_MESSAGE,
  IT_TENKO_MANAGER_STORAGE_KEY,
  clearStoredItTenkoManager,
  useItTenkoManager,
} from '~/composables/useItTenkoManager'

const KEY = 'alc_it_tenko_manager_id'
const MANAGER = { id: 'mgr-1', code: '001', name: '運行 管理', role: ['driver', 'manager'] }
const ADMIN = { id: 'adm-1', code: '002', name: '管理 者', role: ['admin'] }
const DRIVER = { id: 'emp-1', code: '003', name: '山田 太郎', role: ['driver'] }

function apiError(status?: number) {
  return Object.assign(new Error(`API エラー (${status})`), status === undefined ? {} : { status })
}

/** localStorage の 3 つの口が全部 throw する環境 (private mode 等) で fn を走らせる */
async function withBrokenStorage(fn: () => Promise<void>) {
  // happy-dom の localStorage は prototype spy が効かないので、window のプロパティごと差し替える
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage')!
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('QuotaExceededError') },
      removeItem: () => { throw new Error('SecurityError') },
    },
  })
  try {
    await fn()
  }
  finally {
    Object.defineProperty(window, 'localStorage', original)
  }
}

describe('useItTenkoManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('保存の key は alc_it_tenko_manager_id', () => {
    expect(IT_TENKO_MANAGER_STORAGE_KEY).toBe(KEY)
  })

  describe('load', () => {
    it('保存が無ければ未登録のまま、サーバへも聞かない', async () => {
      const { manager, loading, load } = useItTenkoManager()
      await load()
      expect(manager.value).toBeNull()
      expect(loading.value).toBe(false)
      expect(getEmployeeByIdMock).not.toHaveBeenCalled()
    })

    it('保存された id の名前を席の鍵の口 (manager-device) で取り直す。待つあいだも id は使える', async () => {
      localStorage.setItem(KEY, 'mgr-1')
      let resolve!: (v: unknown) => void
      getEmployeeByIdMock.mockImplementation(() => new Promise((r) => { resolve = r }))
      const { manager, loading, load } = useItTenkoManager()
      const done = load()
      expect(manager.value).toEqual({ id: 'mgr-1', name: null })
      expect(loading.value).toBe(true)

      resolve(MANAGER)
      await done
      expect(getEmployeeByIdMock).toHaveBeenCalledWith('mgr-1', 'manager-device')
      expect(manager.value).toEqual({ id: 'mgr-1', name: '運行 管理' })
      expect(loading.value).toBe(false)
      expect(localStorage.getItem(KEY)).toBe('mgr-1')
    })

    it('admin も運行管理者として残る', async () => {
      localStorage.setItem(KEY, 'adm-1')
      getEmployeeByIdMock.mockResolvedValue(ADMIN)
      const { manager, load } = useItTenkoManager()
      await load()
      expect(manager.value).toEqual({ id: 'adm-1', name: '管理 者' })
    })

    it('404 (社員が居なくなった) なら保存を消して未登録に戻す', async () => {
      localStorage.setItem(KEY, 'mgr-1')
      getEmployeeByIdMock.mockRejectedValue(apiError(404))
      const { manager, loading, load } = useItTenkoManager()
      await load()
      expect(manager.value).toBeNull()
      expect(loading.value).toBe(false)
      expect(localStorage.getItem(KEY)).toBeNull()
    })

    it('manager も admin も失っていたら保存を消して未登録に戻す', async () => {
      localStorage.setItem(KEY, 'emp-1')
      getEmployeeByIdMock.mockResolvedValue(DRIVER)
      const { manager, loading, load } = useItTenkoManager()
      await load()
      expect(manager.value).toBeNull()
      expect(loading.value).toBe(false)
      expect(localStorage.getItem(KEY)).toBeNull()
    })

    it.each([
      ['status の無い失敗 (通信・席の鍵が取れない)', apiError()],
      ['500', apiError(500)],
      ['Error でない値', null],
    ])('%s では id を残し、名前は null', async (_label, error) => {
      localStorage.setItem(KEY, 'mgr-1')
      getEmployeeByIdMock.mockRejectedValue(error)
      const { manager, loading, load } = useItTenkoManager()
      await load()
      expect(manager.value).toEqual({ id: 'mgr-1', name: null })
      expect(loading.value).toBe(false)
      expect(localStorage.getItem(KEY)).toBe('mgr-1')
    })

    it('待つあいだに登録し直されたら、古い取り直しの結果 (成功) は捨てる', async () => {
      localStorage.setItem(KEY, 'emp-1')
      let resolve!: (v: unknown) => void
      getEmployeeByIdMock.mockImplementation(() => new Promise((r) => { resolve = r }))
      getEmployeeByCodeMock.mockResolvedValue(MANAGER)
      const { manager, loading, load, registerByCode } = useItTenkoManager()
      const done = load()
      await registerByCode('001')
      expect(loading.value).toBe(false)

      // 古い id は権限を失っていた — が、もう登録し直されているので消さない
      resolve(DRIVER)
      await done
      expect(manager.value).toEqual({ id: 'mgr-1', name: '運行 管理' })
      expect(localStorage.getItem(KEY)).toBe('mgr-1')
    })

    it('待つあいだに「変更」されたら、古い取り直しの結果 (失敗) は捨てる', async () => {
      localStorage.setItem(KEY, 'mgr-1')
      let reject!: (e: unknown) => void
      getEmployeeByIdMock.mockImplementation(() => new Promise((_r, rj) => { reject = rj }))
      const { manager, loading, load, clear } = useItTenkoManager()
      const done = load()
      clear()
      expect(loading.value).toBe(false)

      reject(apiError(500))
      await done
      expect(manager.value).toBeNull()
      expect(loading.value).toBe(false)
    })
  })

  describe('registerByCode', () => {
    it('manager を登録し、id だけを保存する', async () => {
      getEmployeeByCodeMock.mockResolvedValue(MANAGER)
      const { manager, registerByCode } = useItTenkoManager()
      expect(await registerByCode('001')).toEqual({ ok: true })
      expect(getEmployeeByCodeMock).toHaveBeenCalledWith('001', 'manager-device')
      expect(manager.value).toEqual({ id: 'mgr-1', name: '運行 管理' })
      expect(localStorage.getItem(KEY)).toBe('mgr-1')
      // 名前・社員番号は保存しない
      expect(localStorage.length).toBe(1)
    })

    it('admin も登録できる', async () => {
      getEmployeeByCodeMock.mockResolvedValue(ADMIN)
      const { manager, registerByCode } = useItTenkoManager()
      expect(await registerByCode('002')).toEqual({ ok: true })
      expect(manager.value).toEqual({ id: 'adm-1', name: '管理 者' })
    })

    it('見つからなければ文言を返し、登録も保存もしない', async () => {
      getEmployeeByCodeMock.mockRejectedValue(apiError(404))
      const { manager, registerByCode } = useItTenkoManager()
      const res = await registerByCode('999')
      expect(res).toEqual({
        ok: false,
        message: '社員番号「999」の乗務員が見つかりません。社員番号を確認するか、管理者に乗務員登録を依頼してください',
      })
      expect(manager.value).toBeNull()
      expect(localStorage.getItem(KEY)).toBeNull()
    })

    it('★ 席の鍵が取れなかったら、その文言をそのまま返す (「見つかりません」にしない)', async () => {
      getEmployeeByCodeMock.mockRejectedValue(new Error(MANAGER_DEVICE_AUTH_FAILED_MESSAGE))
      const { manager, registerByCode } = useItTenkoManager()
      expect(await registerByCode('001')).toEqual({ ok: false, message: MANAGER_DEVICE_AUTH_FAILED_MESSAGE })
      expect(manager.value).toBeNull()
      expect(localStorage.getItem(KEY)).toBeNull()
    })

    it('Error でない値が投げられたら「見つかりません」の文言', async () => {
      getEmployeeByCodeMock.mockRejectedValue('boom')
      const { registerByCode } = useItTenkoManager()
      const res = await registerByCode('999')
      expect(res.ok).toBe(false)
      expect(res).toMatchObject({ message: expect.stringContaining('社員番号「999」の乗務員が見つかりません') })
    })

    it('manager / admin でなければ文言を返し、前の登録を変えない', async () => {
      getEmployeeByCodeMock.mockResolvedValueOnce(MANAGER).mockResolvedValueOnce(DRIVER)
      const { manager, registerByCode } = useItTenkoManager()
      await registerByCode('001')
      const res = await registerByCode('003')
      expect(res).toEqual({ ok: false, message: '山田 太郎さんには運行管理者の権限がありません' })
      expect(manager.value).toEqual({ id: 'mgr-1', name: '運行 管理' })
      expect(localStorage.getItem(KEY)).toBe('mgr-1')
    })
  })

  // 警告デバイスにタッチしたカード (社員証の IC カード / 運転免許証) で登録する。打刻はしない
  describe('registerByCardId', () => {
    const CARD = '0123456789abcdef'

    it('文言は固定 (カードの id を入れる場所が無い)', () => {
      expect(IT_TENKO_CARD_NOT_REGISTERED_MESSAGE).toBe('このカードは登録されていません。社員番号で登録してください')
      expect(IT_TENKO_CARD_LOOKUP_FAILED_MESSAGE).toBe('カードを確認できませんでした。もう一度タッチしてください')
    })

    it('manager を席の鍵の口 (manager-device) で引いて登録し、社員の id だけを保存する', async () => {
      lookupEmployeeByCardMock.mockResolvedValue(MANAGER)
      const { manager, registerByCardId } = useItTenkoManager()
      expect(await registerByCardId(CARD)).toEqual({ ok: true })
      expect(lookupEmployeeByCardMock).toHaveBeenCalledWith(CARD, 'manager-device')
      expect(manager.value).toEqual({ id: 'mgr-1', name: '運行 管理' })
      expect(localStorage.getItem(KEY)).toBe('mgr-1')
      // カードの id は保存しない
      expect(localStorage.length).toBe(1)
      expect(getEmployeeByCodeMock).not.toHaveBeenCalled()
    })

    it('admin も登録できる', async () => {
      lookupEmployeeByCardMock.mockResolvedValue(ADMIN)
      const { manager, registerByCardId } = useItTenkoManager()
      expect(await registerByCardId(CARD)).toEqual({ ok: true })
      expect(manager.value).toEqual({ id: 'adm-1', name: '管理 者' })
    })

    it('登録済みの席でも、別の人のカードでそのまま切り替わる', async () => {
      getEmployeeByCodeMock.mockResolvedValue(MANAGER)
      lookupEmployeeByCardMock.mockResolvedValue(ADMIN)
      const { manager, registerByCode, registerByCardId } = useItTenkoManager()
      await registerByCode('001')
      expect(await registerByCardId(CARD)).toEqual({ ok: true })
      expect(manager.value).toEqual({ id: 'adm-1', name: '管理 者' })
      expect(localStorage.getItem(KEY)).toBe('adm-1')
    })

    it('404 (未登録・退職) は「登録されていません」。登録も保存もしない', async () => {
      lookupEmployeeByCardMock.mockRejectedValue(apiError(404))
      const { manager, registerByCardId } = useItTenkoManager()
      expect(await registerByCardId(CARD)).toEqual({ ok: false, message: IT_TENKO_CARD_NOT_REGISTERED_MESSAGE })
      expect(manager.value).toBeNull()
      expect(localStorage.getItem(KEY)).toBeNull()
    })

    it('manager / admin でなければ権限なしの文言を返し、前の登録を変えない', async () => {
      lookupEmployeeByCardMock.mockResolvedValueOnce(MANAGER).mockResolvedValueOnce(DRIVER)
      const { manager, registerByCardId } = useItTenkoManager()
      await registerByCardId(CARD)
      expect(await registerByCardId('04a1b2c3')).toEqual({
        ok: false,
        message: '山田 太郎さんには運行管理者の権限がありません',
      })
      expect(manager.value).toEqual({ id: 'mgr-1', name: '運行 管理' })
      expect(localStorage.getItem(KEY)).toBe('mgr-1')
    })

    it('席の鍵が取れなかったら、その文言をそのまま返す', async () => {
      lookupEmployeeByCardMock.mockRejectedValue(new Error(MANAGER_DEVICE_AUTH_FAILED_MESSAGE))
      const { manager, registerByCardId } = useItTenkoManager()
      expect(await registerByCardId(CARD)).toEqual({ ok: false, message: MANAGER_DEVICE_AUTH_FAILED_MESSAGE })
      expect(manager.value).toBeNull()
    })

    it.each([
      ['500', apiError(500)],
      ['status の無い失敗 (通信)', apiError()],
      ['Error でない値', 'boom'],
      ['null', null],
    ])('そのほかの失敗 (%s) は「確認できませんでした」', async (_label, error) => {
      lookupEmployeeByCardMock.mockRejectedValue(error)
      const { manager, registerByCardId } = useItTenkoManager()
      expect(await registerByCardId(CARD)).toEqual({ ok: false, message: IT_TENKO_CARD_LOOKUP_FAILED_MESSAGE })
      expect(manager.value).toBeNull()
      expect(localStorage.getItem(KEY)).toBeNull()
    })

    it('★ どの失敗の文言にもカードの id が入らない', async () => {
      const { registerByCardId } = useItTenkoManager()
      const failures = [apiError(404), apiError(500), new Error(MANAGER_DEVICE_AUTH_FAILED_MESSAGE), 'boom']
      for (const failure of failures) {
        lookupEmployeeByCardMock.mockRejectedValueOnce(failure)
        expect(JSON.stringify(await registerByCardId(CARD))).not.toContain(CARD)
      }
      lookupEmployeeByCardMock.mockResolvedValueOnce(DRIVER)
      expect(JSON.stringify(await registerByCardId(CARD))).not.toContain(CARD)
    })

    it('★ 応答が返った時点で「もう要らない」なら登録しない (前の登録も保存も変えない)', async () => {
      getEmployeeByCodeMock.mockResolvedValue(MANAGER)
      lookupEmployeeByCardMock.mockResolvedValue(ADMIN)
      const { manager, registerByCode, registerByCardId } = useItTenkoManager()
      await registerByCode('001')
      const stillWanted = vi.fn(() => false)
      expect((await registerByCardId(CARD, stillWanted)).ok).toBe(false)
      expect(stillWanted).toHaveBeenCalledTimes(1)
      expect(manager.value).toEqual({ id: 'mgr-1', name: '運行 管理' })
      expect(localStorage.getItem(KEY)).toBe('mgr-1')
    })

    it('応答が返った時点でまだ要るなら登録する。照会が失敗したときは聞かない', async () => {
      lookupEmployeeByCardMock.mockResolvedValueOnce(MANAGER).mockRejectedValueOnce(apiError(404))
      const { manager, registerByCardId } = useItTenkoManager()
      const stillWanted = vi.fn(() => true)
      expect(await registerByCardId(CARD, stillWanted)).toEqual({ ok: true })
      expect(stillWanted).toHaveBeenCalledTimes(1)
      expect(manager.value).toEqual({ id: 'mgr-1', name: '運行 管理' })

      await registerByCardId(CARD, stillWanted)
      expect(stillWanted).toHaveBeenCalledTimes(1)
    })

    it('待つあいだの古い取り直し (load) の結果は、カードの登録の後では捨てる', async () => {
      localStorage.setItem(KEY, 'emp-1')
      let resolve!: (v: unknown) => void
      getEmployeeByIdMock.mockImplementation(() => new Promise((r) => { resolve = r }))
      lookupEmployeeByCardMock.mockResolvedValue(MANAGER)
      const { manager, loading, load, registerByCardId } = useItTenkoManager()
      const done = load()
      await registerByCardId(CARD)
      expect(loading.value).toBe(false)

      resolve(DRIVER)
      await done
      expect(manager.value).toEqual({ id: 'mgr-1', name: '運行 管理' })
      expect(localStorage.getItem(KEY)).toBe('mgr-1')
    })
  })

  describe('clear', () => {
    it('状態と保存を消す', async () => {
      getEmployeeByCodeMock.mockResolvedValue(MANAGER)
      const { manager, registerByCode, clear } = useItTenkoManager()
      await registerByCode('001')
      clear()
      expect(manager.value).toBeNull()
      expect(localStorage.getItem(KEY)).toBeNull()
    })

    it('clearStoredItTenkoManager は保存だけを消す (端末登録リセット用)', () => {
      localStorage.setItem(KEY, 'mgr-1')
      localStorage.setItem('other', 'x')
      clearStoredItTenkoManager()
      expect(localStorage.getItem(KEY)).toBeNull()
      expect(localStorage.getItem('other')).toBe('x')
    })
  })

  it('状態は呼び出しごとに別 (画面をまたいで共有しない)', async () => {
    getEmployeeByCodeMock.mockResolvedValue(MANAGER)
    const a = useItTenkoManager()
    const b = useItTenkoManager()
    await a.registerByCode('001')
    expect(b.manager.value).toBeNull()
  })

  it('localStorage が throw する環境でも、画面を開いているあいだはメモリだけで動く', async () => {
    getEmployeeByCodeMock.mockResolvedValue(MANAGER)
    await withBrokenStorage(async () => {
      const { manager, load, registerByCode, clear } = useItTenkoManager()
      // getItem が throw → 未登録扱い
      await load()
      expect(manager.value).toBeNull()
      expect(getEmployeeByIdMock).not.toHaveBeenCalled()
      // setItem が throw → 登録は保つ
      expect(await registerByCode('001')).toEqual({ ok: true })
      expect(manager.value).toEqual({ id: 'mgr-1', name: '運行 管理' })
      // removeItem が throw → 落ちずに未登録へ戻る
      expect(() => clear()).not.toThrow()
      expect(manager.value).toBeNull()
    })
  })
})
