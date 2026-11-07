/**
 * 運行管理者席でかざしたカード (社員証の IC カード / 運転免許証) を、**読み取り口を問わず 1 つの合図**で受ける
 * (Refs ippoan/alc-app-s3#352)。
 *
 * 席のカードの読み取り口は 2 つある:
 * - 警告デバイス (`useAlarmDevice().cardRead`。`EVT NFC_LOGIN` / `EVT NFC_LICENSE`)
 * - USB でつないだ機体 (席の Vein Base / CoreS3。`useUsbHub().nfc` の `EVT TIMECARD` / `EVT NFC_LICENSE`)
 *
 * 画面ごとにどちらを受けるかを書くと、同じ席でもタブによって反応が違ってしまった (IT点呼 は警告デバイスだけ、
 * 運行管理者のタブは免許証の行だけ)。席のカードを受ける画面はここを通す。
 *
 * - `onCard` には社員の照会 (`lookupEmployeeByCard`) に送る id を渡す。照会と、結果を使ってよいかの判断は呼び手
 * - 呼んだ component の setup の中で使う。unmount で受け口を外し、それ以降の合図は渡さない
 * - 呼んだ後に届いたタッチだけを渡す (mount より前のタッチは拾わない)
 */
import { cardEventLookupId } from '~/composables/useAlarmDevice'

export function useSeatCardRead(onCard: (lookupId: string) => void): void {
  let unmounted = false
  const deliver = (lookupId: string | null) => {
    if (lookupId && !unmounted) onCard(lookupId)
  }
  watch(useAlarmDevice().cardRead, read => deliver(read?.lookupId ?? null))
  const offHub = useUsbHub().nfc.onEvent((name, args) => deliver(cardEventLookupId(name, args)))
  onUnmounted(() => {
    unmounted = true
    offHub()
  })
}
