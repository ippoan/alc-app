import type { MaybeRefOrGetter } from 'vue'

/** ロック名の接頭辞。role ごと (driver / manager は別) に 1 つ */
export const SINGLE_INSTANCE_LOCK_PREFIX = 'alc-pwa:'
/** 再試行の間隔 (ms) */
export const SINGLE_INSTANCE_RETRY_MS = 250
/** 再試行の回数 (250 ms × 8 = 2 秒) */
export const SINGLE_INSTANCE_MAX_TRIES = 8

export function singleInstanceLockName(role: string): string {
  return SINGLE_INSTANCE_LOCK_PREFIX + role
}

/**
 * `ifAvailable` で 1 回だけロックを試す。取れたらページが閉じるまで握り続ける
 * (callback が resolve するとロックは解放されるので、resolve しない Promise を返す)。
 * 取得の成否は callback に渡る `lock` の有無で判定して外へ返す。
 * `request` 自体が reject したとき (仕様外の環境) は判定不能なので「取れた」扱い = 案内を出さない。
 */
function tryAcquire(name: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    navigator.locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false)
          return
        }
        resolve(true)
        return new Promise<void>(() => {})
      })
      .catch(() => resolve(true))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 同じ PC で同じ role の PWA / タブが 2 つ開くのを検知する (Refs #204)。
 * CoreS3 / 警告デバイスのシリアルポートは片方しか握れず、もう片方が誤った警告を出すため。
 * この奪い合いは運行者 (driver。CoreS3 / 警告デバイスを使う) 側だけの事情なので、
 * 検知した二重起動を自動で `window.close()` するのも driver のときだけにする
 * (Refs #314)。運行管理者はシリアルポートを使わないので自動 close の理由が無く、
 * 無言で閉じると利用者は原因も復旧手段も分からない。
 *
 * - `navigator.locks` (Web Locks) が無い環境では何もしない
 * - `alc-pwa:<role>` のロックを 250 ms 間隔で最大 8 回 (2 秒) 試す。reload や chunk 復旧の
 *   自動 reload (`plugins/reload-grace.client.ts`) では旧ページの解放が新ページの mount より
 *   遅れることがあるので、即断せず待つ
 * - 8 回とも取れなければ `duplicate` を true にする (role によらず、案内 UI を出すため)。
 *   **fail-open**: 自動で閉じるのは role が `driver` かつ PWA ウィンドウ
 *   (`display-mode: standalone`) かつ `history.length === 1` のときだけ。
 *   それ以外 (driver 以外の role・通常タブ) では案内だけ出し、利用者がボタンを押したときに
 *   `closeWindow()` で閉じる (履歴が 2 以上のタブでは `window.close()` は仕様上無視される)
 * - 取れた側はページが閉じる (unload) まで握り続ける
 */
export function useSingleInstance(role: MaybeRefOrGetter<string>) {
  const duplicate = ref(false)

  async function detect(): Promise<void> {
    if (!navigator.locks) return
    const resolvedRole = toValue(role)
    const name = singleInstanceLockName(resolvedRole)
    for (let i = 0; i < SINGLE_INSTANCE_MAX_TRIES; i++) {
      if (i > 0) await delay(SINGLE_INSTANCE_RETRY_MS)
      if (await tryAcquire(name)) return
    }
    duplicate.value = true
    if (resolvedRole !== 'driver') return
    const standalone = window.matchMedia('(display-mode: standalone)').matches
    if (standalone && window.history.length === 1) window.close()
  }

  function closeWindow(): void {
    window.close()
  }

  onMounted(() => { void detect() })

  return { duplicate, closeWindow }
}
