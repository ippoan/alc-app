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
 * デバイス (CoreS3 / 警告デバイスのシリアルポート) を握るロール。二重起動時に自動で
 * `window.close()` するのはこのロールだけ (Refs #204, #314)。
 * - `driver`: 点呼キオスクで CoreS3 / 警告デバイスを直接使う
 * - `bp`: 血圧測定端末。`BloodPressureMeasurement.vue` → `useBleGateway()` →
 *   `useCoreS3Serial()` で同じ CoreS3 のシリアルを使う
 *
 * `manager` / `admin` / `general` はデバイスを握らないのでここに含めない —
 * 増えるロールは既定で自動 close されない (閉じる側を列挙する向き)。
 */
const DEVICE_HOLDING_ROLES = new Set(['driver', 'bp'])

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
 * この奪い合いは `DEVICE_HOLDING_ROLES` (driver / bp) 側だけの事情なので、
 * 検知した二重起動を自動で `window.close()` するのもこのロールのときだけにする
 * (Refs #314)。manager / admin / general はデバイスを握らないので自動 close の理由が無く、
 * 無言で閉じると利用者は原因も復旧手段も分からない。
 *
 * - `navigator.locks` (Web Locks) が無い環境では何もしない
 * - `alc-pwa:<role>` のロックを 250 ms 間隔で最大 8 回 (2 秒) 試す。reload や chunk 復旧の
 *   自動 reload (`plugins/reload-grace.client.ts`) では旧ページの解放が新ページの mount より
 *   遅れることがあるので、即断せず待つ
 * - 8 回とも取れなければ `duplicate` を true にする (role によらず、案内 UI を出すため)。
 *   **fail-open**: 自動で閉じるのは role が `DEVICE_HOLDING_ROLES` に含まれ、かつ PWA
 *   ウィンドウ (`display-mode: standalone`) かつ `history.length === 1` のときだけ。
 *   それ以外 (デバイスを握らない role・通常タブ) では案内だけ出し、利用者がボタンを押したときに
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
    if (!DEVICE_HOLDING_ROLES.has(resolvedRole)) return
    const standalone = window.matchMedia('(display-mode: standalone)').matches
    if (standalone && window.history.length === 1) window.close()
  }

  function closeWindow(): void {
    window.close()
  }

  onMounted(() => { void detect() })

  return { duplicate, closeWindow }
}
