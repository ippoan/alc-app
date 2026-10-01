import type { ApiEmployee } from '~/types'
import { getEmployeeByCode, getEmployeeById } from '~/utils/api'
import { employeeNotFoundByCode } from '~/utils/employee-lookup-messages'

/**
 * IT点呼 の受け画面 (`TenkoItAdminView.vue`) 専用の「この席の運行管理者」(Refs ippoan/alc-app#387)。
 *
 * 運行管理者タブの入口・遠隔点呼モニターが共有する `useManagerAuth` とは**別の状態** —
 * あちらの ID は引き継がないし、ここからあちらへも書き込まない。顔認証もしない。
 *
 * 席 (ブラウザ) に覚えさせるのは**社員の id だけ** (名前・社員番号は保存しない)。
 * 登録は「変更」(`clear`) を押すまで残り、名前と権限は `load` のたびにサーバから取り直す。
 */
export const IT_TENKO_MANAGER_STORAGE_KEY = 'alc_it_tenko_manager_id'

export interface ItTenkoManager {
  id: string
  /** 取り直せなかったときは null (id は残す) */
  name: string | null
}

/** 登録の結果。失敗のときは画面にそのまま出せる文言を返す */
export type ItTenkoManagerRegisterResult = { ok: true } | { ok: false, message: string }

function readStored(): string | null {
  try {
    return localStorage.getItem(IT_TENKO_MANAGER_STORAGE_KEY) || null
  }
  catch {
    // private mode 等で localStorage が使えない環境では未登録扱い
    return null
  }
}

function writeStored(id: string) {
  try {
    localStorage.setItem(IT_TENKO_MANAGER_STORAGE_KEY, id)
  }
  catch {
    // 保存できなくても、画面を開いているあいだは登録を保つ
  }
}

/** 席に覚えさせた運行管理者の id を消す (端末登録リセットからも呼ぶ) */
export function clearStoredItTenkoManager() {
  try {
    localStorage.removeItem(IT_TENKO_MANAGER_STORAGE_KEY)
  }
  catch {
    // 消せない環境では保存もできていない
  }
}

function canJudge(emp: ApiEmployee): boolean {
  return emp.role.includes('manager') || emp.role.includes('admin')
}

export function useItTenkoManager() {
  // 利用者は受け画面 1 つなので、画面をまたいで共有しない
  const manager = ref<ItTenkoManager | null>(null)
  /** 保存された id の名前と権限を取り直している途中 */
  const loading = ref(false)
  // load() を待つあいだに登録・変更が来たら、待っていた古い load() の結果は捨てる
  let generation = 0

  /** 状態と保存を消す (未登録に戻す) */
  function clear() {
    generation += 1
    loading.value = false
    manager.value = null
    clearStoredItTenkoManager()
  }

  /** 保存された id が在れば、名前と権限を取り直す */
  async function load() {
    const id = readStored()
    if (!id) return
    const gen = ++generation
    // id は保存されたものをすぐ使えるようにする (名前は取れてから)
    manager.value = { id, name: null }
    loading.value = true
    try {
      const emp = await getEmployeeById(id, 'tenko-monitor')
      if (gen !== generation) return
      if (!canJudge(emp)) {
        // 運行管理者の権限を失った
        clear()
        return
      }
      manager.value = { id: emp.id, name: emp.name }
    }
    catch (e) {
      if (gen !== generation) return
      // 社員が居なくなった (404) ときだけ消す。通信・席の鍵の失敗では id を残す
      if ((e as { status?: number } | null)?.status === 404) {
        clear()
        return
      }
    }
    loading.value = false
  }

  /** 社員番号で運行管理者を登録し、席に覚えさせる */
  async function registerByCode(code: string): Promise<ItTenkoManagerRegisterResult> {
    let emp: ApiEmployee
    try {
      emp = await getEmployeeByCode(code, 'tenko-monitor')
    }
    catch {
      return { ok: false, message: employeeNotFoundByCode(code) }
    }
    if (!canJudge(emp)) {
      return { ok: false, message: `${emp.name}さんには運行管理者の権限がありません` }
    }
    generation += 1
    loading.value = false
    manager.value = { id: emp.id, name: emp.name }
    writeStored(emp.id)
    return { ok: true }
  }

  return {
    /** この席の運行管理者。未登録は null */
    manager: readonly(manager),
    loading: readonly(loading),
    load,
    registerByCode,
    clear,
  }
}
