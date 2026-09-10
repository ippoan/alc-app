/**
 * CoreS3 が USB で繋がっていれば、管理者ログイン無しで自動的に端末登録する (#213)。
 *
 * 運行者タブの `TimePunchKiosk` は端末登録 (device-kiosk credential、`useDeviceToken`)
 * が無いと打刻一覧が空になる。端末登録 (`device-claim.vue`) には本来、管理者の Google
 * ログインが要るが、CoreS3 が USB で繋がっている PC はそれ自体が「その場に居る」証拠に
 * なるので、firmware 経由で 1 回限りの登録トークンを取り、無人で端末登録まで済ませる。
 *
 * プロトコル (firmware は ippoan/alc-app-s3#204、auth-worker は ippoan/auth-worker#519):
 *   host → dev  `AUTH TICKET`
 *   dev  → host `AUTH TICKET <ticket> EXPIRES=<秒>`  … 成功
 *   dev  → host `ERR AUTH TICKET: <理由>`            … 失敗
 * ticket を既存の `POST <authWorkerUrl>/device/pair/token` (body `{device_code}`) に
 * 渡すと `{device_id, device_secret, tenant_id, label}` が 1 回だけ返る。
 *
 * 保存は **device-claim.vue と同じ漏斗** (`useAuth().activateFromRegistration`) を使う —
 * kiosk credential の保存経路をここで新設しない。`device_id`/`device_secret` は
 * auth-worker の device-kiosk credential (`auth_device_id`/`device_secret` として渡す)。
 * rust-alc-api 側の device 行 id は CoreS3 auto-claim には無いので渡さない
 * (`activateDevice` の `devId` は省略可)。
 *
 * ここは CoreS3 の接続を自分で確立しない — `register`/`unregister` は呼ばない。
 * NFC (`useNfcReader`) 側が unregister すると BLE ゲートウェイ (体温計・血圧計) まで
 * 切れる実害があったため、既存の接続状態 (`useCoreS3Serial().isConnected`) と
 * 書き込み口 (`request`) だけを使う (Refs ippoan/alc-app#182)。
 */
import { autoClaimFailedMessage } from '~/utils/employee-lookup-messages'

/** firmware の `AUTH TICKET` 応答を待つ上限 (USB 記述子どおり 10 秒、契約は issue #213 参照) */
const TICKET_TIMEOUT_MS = 10_000
const TICKET_COMMAND = 'AUTH TICKET'
const TICKET_MATCH_PREFIX = 'AUTH TICKET '

/** `AUTH TICKET <ticket> EXPIRES=<秒>` を解く。マッチしなければ null */
function parseTicketLine(line: string): { ticket: string } | null {
  const ticket = line.match(/^AUTH TICKET (\S+) EXPIRES=\d+$/)?.[1]
  return ticket ? { ticket } : null
}

/** 直近の失敗理由 (画面表示用)。成功 / 未実行なら null */
const lastError = ref<string | null>(null)
/** 二重起動防止 (同時に 1 回だけ) */
let claiming = false
/** CoreS3 の再接続ごとに 1 回だけ試すための onOpen 登録 (module 内で 1 度だけ) */
let listenerInstalled = false

export function useHubClaim() {
  const { isDeviceActivated, activateFromRegistration } = useAuth()
  const coreS3 = useCoreS3Serial()
  const config = useRuntimeConfig()

  /**
   * `!isDeviceActivated && coreS3.isConnected` の条件が揃った瞬間に呼ばれる想定。
   * 既に端末登録済み、または同時実行中なら何もしない。
   */
  async function attemptClaim(): Promise<void> {
    if (claiming) return
    if (isDeviceActivated.value) return
    if (!coreS3.isConnected.value) return

    claiming = true
    lastError.value = null
    try {
      const line = await coreS3.request(TICKET_COMMAND, TICKET_MATCH_PREFIX, TICKET_TIMEOUT_MS)
      const parsed = parseTicketLine(line)
      if (!parsed) {
        lastError.value = autoClaimFailedMessage(`予期しない応答: ${line}`)
        return
      }

      // nuxt.config.ts が public.authWorkerUrl に既定値を持つので、ここでの fallback は
      // 不要 (useAuth.ts の authWorkerUrl 参照と同じ流儀 — 到達不能な分岐を作らない)
      const authWorkerUrl = (config.public.authWorkerUrl as string).replace(/\/$/, '')
      const res = await fetch(`${authWorkerUrl}/device/pair/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: parsed.ticket }),
      })
      if (!res.ok) {
        lastError.value = autoClaimFailedMessage(`http ${res.status}`)
        return
      }

      const data = await res.json() as { device_id?: string, device_secret?: string, tenant_id?: string }
      if (!data.tenant_id || !data.device_id || !data.device_secret) {
        lastError.value = autoClaimFailedMessage('応答が不完全です')
        return
      }

      // device-claim.vue と同じ漏斗。auth_device_id/device_secret が kiosk credential
      activateFromRegistration({
        tenant_id: data.tenant_id,
        auth_device_id: data.device_id,
        device_secret: data.device_secret,
      })
    }
    catch (e) {
      // request() の ERR/タイムアウト、または fetch の通信エラー
      lastError.value = autoClaimFailedMessage(e instanceof Error ? e.message : String(e))
    }
    finally {
      claiming = false
    }
  }

  // CoreS3 の接続 (再接続含む) のたびに 1 回試す。listenerInstalled で二重登録を避ける
  // (useHubClaim() は app.vue と TimePunchKiosk.vue の双方から呼ばれる想定)
  if (!listenerInstalled) {
    listenerInstalled = true
    coreS3.onOpen(() => { void attemptClaim() })
  }

  return {
    /** 直近の失敗理由。成功 / 未実行なら null */
    lastError: readonly(lastError),
    attemptClaim,
  }
}
