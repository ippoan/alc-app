import type { LatestPunch } from '~/types'
import { cardKindOf } from '~/utils/card-kind'
import { evtArg } from '~/composables/useCoreS3Serial'

/**
 * ハブ端末 (CoreS3) の IC 打刻を、**USB シリアルから直接**受けて画面を動かす
 * (Refs ippoan/rust-alc-api#644)。
 *
 * # 何を解くのか
 *
 * これまで IC 打刻の案内ボタンは、**クラウドを一周してから**出ていた:
 *
 * ```
 * CoreS3 が読む → WS で cf-alc-recorder → rust-alc-api → DB
 *   → /watch-timecard の合図 → タブレットが一覧を引き直す → ボタン
 * ```
 *
 * **目の前のケーブルで届いている事実を、クラウドを回ってから受け取っていた。**
 * WS が切れている間 (実測で 1 回あたり約 5 分 15 秒) はボタンが出ず、
 * 正常時でも往復ぶん遅れる。
 *
 * firmware は読み取りの瞬間に
 * `EVT TIMECARD card_id=<生値> card_kind=<felica_idm|nfca_uid>` を USB へ流すので、
 * **それを直接受けて出す。**
 *
 * # 記録は増やさない
 *
 * **`punchTimecard()` を呼ばない。** 打刻を書くのは CoreS3 の WS uplink 1 本だけ、
 * という形 (Refs `#293`) を崩さない。ここがやるのは**画面を出すことだけ**。
 *
 * # 同じタップで 2 回出さない
 *
 * 同じタップについて、① シリアル由来 (いま) と ② サーバ由来 (あとで一覧を
 * 引き直したぶん) の 2 つが届く。`IcPunchAlcoholPrompt` は `id` が変わると
 * ボタンを出し直すので、**利用者がもう押した後にもう一度出てしまう**。
 * `setFromServer` で、**同じ社員・近い時刻なら捨てる**。
 *
 * # 引けなかったときは従来どおりに倒す
 *
 * 台帳に無いカード (未登録 / 登録直後) と、氏名が引けないときは**何もしない**。
 * サーバ由来のボタンが従来どおり出るので、**遅くなるだけで壊れない**。
 */

/**
 * シリアル由来とサーバ由来を「同じタップ」と見なす時間差。
 * `IcPunchAlcoholPrompt` の `FRESH_WINDOW_MS` と同値 — あちらがボタンを
 * 出しておく時間より長い窓で重複を消しても意味が無い。
 */
const MERGE_WINDOW_MS = 60_000

export function useHubTimecardPunch(resolveName: (employeeId: string) => string | null) {
  const coreS3 = useCoreS3Serial()
  const cards = useTimecardCardIndex()

  const latest = ref<LatestPunch | null>(null)
  /** 直近にシリアル由来で出したぶん (サーバ由来の同じタップを捨てる判定に使う) */
  let fromSerial: LatestPunch | null = null
  let seq = 0
  let unsubscribe: (() => void) | null = null

  function onEvent(name: string, args: string[]): void {
    if (name !== 'TIMECARD') return
    const cardId = evtArg(args, 'card_id')
    if (!cardId) return
    // **card_id はここから外へ出さない。** 突き合わせは手元の台帳だけで行う
    const employeeId = cards.resolve(cardId)
    if (!employeeId) return
    const name_ = resolveName(employeeId)
    if (!name_) return
    const punch: LatestPunch = {
      id: `serial:${++seq}`,
      employeeId,
      name: name_,
      cardKind: cardKindOf(evtArg(args, 'card_kind')),
      // **かざした瞬間**。サーバの `created_at` より正確 (往復を含まない)
      punchedAt: new Date().toISOString(),
    }
    fromSerial = punch
    latest.value = punch
  }

  /**
   * サーバ由来 (`TodayPunchHistory` が一覧を引き直したぶん) の最新行を受ける。
   * **同じタップなら捨てる** — 捨てないと押した後のボタンが出し直される。
   */
  function setFromServer(punch: LatestPunch | null): void {
    if (
      punch
      && fromSerial
      && punch.employeeId === fromSerial.employeeId
      && Math.abs(Date.parse(punch.punchedAt) - Date.parse(fromSerial.punchedAt)) < MERGE_WINDOW_MS
    ) {
      return
    }
    latest.value = punch
  }

  onMounted(() => {
    void cards.restore()
    unsubscribe = coreS3.onEvent(onEvent)
  })
  onUnmounted(() => {
    unsubscribe?.()
    unsubscribe = null
  })

  return { latest: readonly(latest), setFromServer }
}
