/**
 * 「この端末の指を足す」(Refs ippoan/alc-app#558)。指静脈の記録は、撮った端末と違う端末では通りにくい。
 * 本人が決まったのにその端末で通らなかった人 (血圧測定台)・運行管理者の入口で入った人が、
 * **この端末で撮った指を、この端末の分としてサーバーへ足す**。承認は挟まない。
 *
 * 手順: その人のモジュールの ID に `VEIN ENROLL` (その場で登録) → 記録を `PUT …/module/devices` で預ける →
 * 端末の設定 (`vein-added-finger-mode`) に従ってモジュールに置く:
 * - `native` … その場で撮った記録のまま置く。対応表に `native: true` で残し、同期は書き換えない
 * - `mixed` (既定) … 続けて同期を走らせ、サーバーが組んだ記録 (この端末の 3 本 + 他端末の新しい 3 本) を書く
 *
 * 失敗したらモジュールに残さない (`VEIN SYNC CLEAR`)。対応表からも外してあるので、次の同期が
 * サーバーの記録を書き直す。
 */
import { apiErrorCode, putVeinModuleDeviceRecord } from '~/utils/api'
import type { RequestTokenScope } from '~/utils/api'
import { deleteVeinModuleEntry, loadVeinModuleEntries, putVeinModuleEntry } from '~/utils/vein-db'
import { allocateVeinModuleId, syncVeinModule } from '~/utils/vein-module'
import type { VeinModulePort } from '~/utils/vein-module'
import { readVeinAddedFingerMode } from '~/utils/vein-added-finger-mode'
import { VEIN_RECORD_BROKEN } from '~/composables/useVeinSerial'
import { VEIN_ENROLL_FULL_MESSAGE, VEIN_ENROLL_RETAKE_MESSAGE, veinErrorMessage } from '~/composables/useVeinEnroll'
import { appendDiag } from '~/utils/serialDiagLog'

/** その人に承認済みのモジュールの記録がまだ無い (サーバーの 409 `no_approved_module_record`) */
export const VEIN_ADD_NO_RECORD_MESSAGE
  = 'この人は、承認済みの指静脈の登録がまだありません。先に指静脈を登録し、運行管理者の承認を受けてください'

/** 足す手順が使うモジュールの口 (`useVeinSerial` の一部) */
export interface VeinAddFingerPort extends VeinModulePort {
  say: (x: 'PLACE' | 'FAILED' | 'ENROLLED') => Promise<void>
  enroll: (id: number, onPlace?: (n: number, total?: number) => void) => Promise<Uint8Array>
}

/**
 * `employeeId` の指を、この端末で撮ってサーバーへ足し、モジュールに置く。失敗は Error (理由は
 * {@link veinErrorMessage} で画面の文言になる)。`scope` はどの端末の鍵で送るか
 */
export async function addThisDeviceFinger(
  port: VeinAddFingerPort,
  employeeId: string,
  scope: RequestTokenScope,
  onPlace?: (n: number, total?: number) => void,
): Promise<void> {
  const entries = await loadVeinModuleEntries()
  const id = allocateVeinModuleId(entries, employeeId)
  if (id === null) throw new Error(VEIN_ENROLL_FULL_MESSAGE)
  // `VEIN ENROLL` は先にその ID を消す。途中で落ちた記録を承認済みとして引かないよう、対応表から先に外す
  if (entries.some(e => e.employeeId === employeeId)) await deleteVeinModuleEntry(employeeId)
  await port.say('PLACE')
  // 以降の失敗は、モジュールに半端な記録を残さない (消せなくても対応表に無いので照合は外れる)
  const clear = () => port.syncClear(id).catch(() => {})
  let record: Uint8Array
  try {
    record = await port.enroll(id, onPlace)
  }
  catch (e) {
    const reason = (e as Error).message
    if (reason === VEIN_RECORD_BROKEN) {
      await clear()
      throw new Error(VEIN_ENROLL_RETAKE_MESSAGE)
    }
    if (reason === 'RETAKE') throw new Error(VEIN_ENROLL_RETAKE_MESSAGE)
    // 重複 (RC=0A) などはファームの理由のまま (veinErrorMessage が文言にする)
    throw e
  }
  let saved: { updated_at: string }
  try {
    saved = await putVeinModuleDeviceRecord(employeeId, record, scope)
  }
  catch (e) {
    await clear()
    if (apiErrorCode(e) === 'no_approved_module_record') throw new Error(VEIN_ADD_NO_RECORD_MESSAGE)
    throw e
  }
  // どちらの設定でも、まず「その場の記録を置いた」と対応表に残す。設定が mixed なら、続く同期が
  // この人を (native の記録は版が同じでも) 書き直す。書き直せなくても次の同期が直す
  await putVeinModuleEntry({ employeeId, moduleId: id, updatedAt: saved.updated_at, approved: true, native: true })
  if (readVeinAddedFingerMode() === 'mixed') await syncVeinModule(port, { scope })
}

/** 画面用: 足す操作の状態。`scope` はその画面がサーバーへ送るときの鍵 */
export function useVeinAddDevice(opts: { scope: RequestTokenScope }) {
  const veinSerial = useVeinSerial()
  const adding = ref(false)
  const error = ref<string | null>(null)
  /** 足し終えた (画面は「足しました」を出す) */
  const added = ref(false)
  /** 途中の案内 (置き直し)。終わったら null */
  const notice = ref<string | null>(null)

  /** Vein Station / Vein Base が繋がっていて足せる */
  const available = computed(() => veinSerial.isSupported && veinSerial.isConnected.value)

  /** 足せたら true。失敗は `error` に出す */
  async function add(employeeId: string): Promise<boolean> {
    if (!available.value || adding.value) return false
    adding.value = true
    error.value = null
    added.value = false
    try {
      await addThisDeviceFinger(veinSerial, employeeId, opts.scope, (n, total) => {
        notice.value = total === undefined ? `もう一度置いてください (${n} 回目)` : `もう一度置いてください (${n}/${total})`
      })
      await veinSerial.say('ENROLLED').catch(() => {})
      added.value = true
      return true
    }
    catch (e) {
      error.value = veinErrorMessage(e)
      // 画面の文言は次の操作で消えるので診断ログに残す (氏名・社員 id・記録の中身は出さない)
      const msg = `[vein] この端末の指を足せませんでした: ${e instanceof Error ? e.message : String(e)}`
      console.warn(msg)
      appendDiag(msg)
      await veinSerial.say('FAILED').catch(() => {})
      return false
    }
    finally {
      notice.value = null
      adding.value = false
    }
  }

  function reset(): void {
    error.value = null
    added.value = false
  }

  return {
    adding: readonly(adding),
    error: readonly(error),
    added: readonly(added),
    notice: readonly(notice),
    available,
    add,
    reset,
  }
}
