import type { LatestPunch } from '~/types'
import { cardKindOf } from '~/utils/card-kind'
import { lookupEmployeeByCard } from '~/utils/api'
import { usesAdminToken } from '~/utils/token-selection'
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
 * という形 (Refs `#293`) を崩さない。ここがやるのは**画面を出すことだけ**
 * (下の照会も読み取りだけ)。
 *
 * # 同じタップで 2 回出さない
 *
 * 同じタップについて、① シリアル由来 (いま) と ② サーバ由来 (あとで一覧を
 * 引き直したぶん) の 2 つが届く。`IcPunchAlcoholPrompt` は `id` が変わると
 * ボタンを出し直すので、**利用者がもう押した後にもう一度出てしまう**。
 * `setFromServer` で、**同じ社員・近い時刻なら捨てる**。
 *
 * # 持ち主は、まずサーバーに照会して引く (Refs ippoan/alc-app#387)
 *
 * オンラインなら `lookupEmployeeByCard` (読み取りだけ。打刻は書かない) で「このカードは
 * 誰のものか」を照会する。手元の写し (`useTimecardCardIndex` のカード台帳 + 社員の一覧) は
 * リロードの直後に揃っていないので、それだけに頼ると直後のタッチが引けなかった。機体
 * (CoreS3) 自身の LAN / Wi-Fi はいずれ無くなり、USB → 画面 → サーバーの道だけが残る。
 *
 * - **見つかった (200)** → 応答の社員で印 (`readOnThisDevice`) 付きの行を出す。カード台帳で
 *   見つかったか社員の「NFC ID」で見つかったかは区別しない
 * - **見つからない (404・400)** → 何も出さない。**手元の写しへは倒さない** (サーバーの答えを採る)
 * - **それ以外の失敗・上限 ({@link LOOKUP_TIMEOUT_MS}) 切れ・端末の鍵が無い・オフライン**
 *   → 手元の写しで引く (印付き)。写しの鮮度の上限は `useTimecardCardIndex` が持つ
 *
 * 行の時刻は**読み取りを受けた時刻** (照会の決着時刻にしない = ボタンの寿命は延びない)。
 * 新しい読み取りが来たら、前の照会の結果は捨てる (unmount の後に届いた結果も)。
 *
 * # card_id の行き先
 *
 * **照会の body にだけ載せる** (`lookupEmployeeByCard`)。ログ・診断・警告には出さない
 * (社員の ID・氏名も)。
 *
 * # 引けなかったときは従来どおりに倒す
 *
 * サーバーにも手元の写しにも無いカード・写しが古すぎるとき・氏名が引けないときは
 * **ボタンを出さない**。サーバ由来のボタンが従来どおり出るので、**遅くなるだけで壊れない**。
 * 黙って倒れると気づけない (Refs ippoan/alc-app#387) ので、理由だけを 1 行 warn に残す。
 */

/**
 * シリアル由来とサーバ由来を「同じタップ」と見なす時間差。
 *
 * **ボタンの寿命 (`IcPunchAlcoholPrompt` の `FRESH_WINDOW_MS` = 10 秒) より
 * 長くしてある。** WS が切れているとサーバ由来の行は数分遅れて届くので、
 * 短くすると**同じタップが「別のタップ」として通り、ボタンが出し直される**。
 *
 * 窓の外で届いたぶんは通すが、その行の `punchedAt` はタップ時刻なので
 * `FRESH_WINDOW_MS` を既に過ぎており、**ボタンは出ない** (寿命は延びない)。
 */
const MERGE_WINDOW_MS = 60_000

/**
 * サーバーへの照会を待つ上限。**端末の鍵の取得待ちを含む。**
 *
 * 案内のボタンの寿命は読み取りから 10 秒 (`IcPunchAlcoholPrompt` の `FRESH_WINDOW_MS`)。
 * リロードの直後は端末の鍵の取得に数秒掛かるので 6 秒まで待ち、残りの 4 秒で押せるように
 * する。決着しなければ手元の写しへ倒す (`request()` 自体の上限 30 秒は長すぎて使えない)。
 */
const LOOKUP_TIMEOUT_MS = 6_000

/** USB で受けた 1 回の読み取り。 */
interface CardRead {
  cardId: string
  cardKind: LatestPunch['cardKind']
  /** 読み取りを受けた時刻 (ISO8601) */
  readAt: string
}

/** サーバーへの照会の結果。`reason` は警告に出す語 (番号・社員の ID・氏名を含めない)。 */
type LookupOutcome
  = | { kind: 'found', employeeId: string, name: string }
    | { kind: 'not-found' }
    | { kind: 'unavailable', reason: string }

/**
 * 手元の写しで引けなかったことを残す。**カードの番号・社員の ID・氏名は出さない**
 * (理由の語だけ)。
 */
function warnUnresolved(reason: string): void {
  console.warn(`[HubTimecardPunch] 手元の台帳で引けないカード (${reason}。サーバ経由の案内に任せる)`)
}

export function useHubTimecardPunch(resolveName: (employeeId: string) => string | null) {
  const coreS3 = useCoreS3Serial()
  const cards = useTimecardCardIndex()
  const { accessToken } = useAuth()

  const latest = ref<LatestPunch | null>(null)
  /** 直近にシリアル由来で出したぶん (サーバ由来の同じタップを捨てる判定に使う) */
  let fromSerial: LatestPunch | null = null
  let seq = 0
  /** 読み取りの世代。新しい読み取り・unmount で進め、古い照会の結果を捨てる */
  let generation = 0
  let unsubscribe: (() => void) | null = null

  /** 印付きの行を新しく置く (`serial:<n>`)。 */
  function showSerial(read: CardRead, employeeId: string, name: string): void {
    const punch: LatestPunch = {
      id: `serial:${++seq}`,
      employeeId,
      name,
      cardKind: read.cardKind,
      // **かざした瞬間**。サーバの `created_at` より正確 (往復を含まない)
      punchedAt: read.readAt,
      // この機体で読んだ打刻の印。サーバ由来の行 (`setFromServer`) には付かない
      readOnThisDevice: true,
    }
    fromSerial = punch
    latest.value = punch
  }

  /** 手元の写し (カード台帳 + 社員の一覧) で引く。オフライン・照会の失敗のときの倒れ先 */
  function showFromLocal(read: CardRead): void {
    const employeeId = cards.resolve(read.cardId)
    if (!employeeId) {
      warnUnresolved(cards.isFresh() ? '台帳に無い' : '台帳が古い')
      return
    }
    const name = resolveName(employeeId)
    if (!name) {
      warnUnresolved('名前が無い')
      return
    }
    showSerial(read, employeeId, name)
  }

  /**
   * サーバーに持ち主を照会する。**端末の鍵が無いときは照会しない** — `request()` は鍵が
   * 取れないと無認証の直 fetch に落ちるので、同じ規則 (`usesAdminToken` → キオスクの鍵) を
   * 先になぞって、送れるトークンが在るときだけ呼ぶ (鍵は cache されるので取得は 1 回)。
   * `useDeviceToken()` は `initApi` に渡す getter (`pages/index.vue`) と同じく使うときに呼ぶ。
   */
  async function lookupOnServer(cardId: string): Promise<LookupOutcome> {
    try {
      if (!usesAdminToken(accessToken.value, 'kiosk') && !(await useDeviceToken().getDeviceJwt())) {
        return { kind: 'unavailable', reason: '端末の鍵が無い' }
      }
      const employee = await lookupEmployeeByCard(cardId, 'default')
      return { kind: 'found', employeeId: employee.id, name: employee.name }
    }
    catch (e) {
      const status = (e as { status?: number } | null)?.status
      if (status === 404 || status === 400) return { kind: 'not-found' }
      return { kind: 'unavailable', reason: status ? `http ${status}` : '通信の失敗' }
    }
  }

  /**
   * 照会の決着を待って行を出す。`latestIdAtRead` は読み取りを受けた時点の最新行の id
   * (待つあいだに届いたサーバ由来の行を見分けるため)。
   */
  async function showFromServer(read: CardRead, gen: number, latestIdAtRead: string | null): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<LookupOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'unavailable', reason: '上限切れ' }), LOOKUP_TIMEOUT_MS)
    })
    // 上限で決着した後に遅れて届いた応答は、ここで誰にも読まれずに捨てられる
    const outcome = await Promise.race([lookupOnServer(read.cardId), timeout])
    clearTimeout(timer)
    // 新しい読み取りが来た / unmount された
    if (gen !== generation) return

    if (outcome.kind === 'not-found') {
      console.warn('[HubTimecardPunch] サーバーの照会で持ち主が見つからないカード (案内を出さない)')
      return
    }
    if (outcome.kind === 'unavailable') {
      console.warn(`[HubTimecardPunch] サーバーに照会できない (${outcome.reason}。手元の写しで引く)`)
      showFromLocal(read)
      return
    }
    // 待つあいだに同じタップのサーバ由来の行 (印なし) が先に届いていたら、**その行に印だけを
    // 足す**。`id` を変えないので、ボタンの出し直しも寿命の測り直しも起きない。
    // 読み取りの前から在った行には足さない (前のタップの行で、ボタンの寿命が切れている)
    const current = latest.value
    if (
      current
      && current.id !== latestIdAtRead
      && !current.readOnThisDevice
      && current.employeeId === outcome.employeeId
      && Math.abs(Date.parse(current.punchedAt) - Date.parse(read.readAt)) < MERGE_WINDOW_MS
    ) {
      const marked: LatestPunch = { ...current, readOnThisDevice: true }
      fromSerial = marked
      latest.value = marked
      return
    }
    showSerial(read, outcome.employeeId, outcome.name)
  }

  function onEvent(name: string, args: string[]): void {
    if (name !== 'TIMECARD') return
    const cardId = evtArg(args, 'card_id')
    if (!cardId) return
    const gen = ++generation
    const read: CardRead = {
      cardId,
      cardKind: cardKindOf(evtArg(args, 'card_kind')),
      readAt: new Date().toISOString(),
    }
    // オフラインなら照会しない (`navigator.onLine` は疎通の保証ではないが、false なら確実に届かない)
    if (!navigator.onLine) {
      showFromLocal(read)
      return
    }
    void showFromServer(read, gen, latest.value?.id ?? null)
  }

  /**
   * サーバ由来 (`TodayPunchHistory` が一覧を引き直したぶん) の最新行を受ける。
   * **同じタップなら捨てる** — 捨てないと押した後のボタンが出し直される。
   * 照会の応答を待つあいだに届いた行は保留しない (そのまま出す。印は照会が決着してから足す)。
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
    // 経過時間での定期同期。**取り消されたカードを手元から消す唯一の経路**
    // (`useTimecardCardIndex` の doc 参照)
    cards.startPeriodicRefresh()
    unsubscribe = coreS3.onEvent(onEvent)
  })
  onUnmounted(() => {
    generation += 1
    cards.stopPeriodicRefresh()
    unsubscribe?.()
    unsubscribe = null
  })

  return { latest: readonly(latest), setFromServer }
}
