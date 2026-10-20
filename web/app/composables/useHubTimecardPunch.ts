import type { LatestPunch } from '~/types'
import type { UsbHubKind } from '~/composables/useUsbHub'
import { lookupEmployeeByCard, punchTimecard } from '~/utils/api'
import { deviceSendsPunch } from '~/utils/device-line'
import { usesAdminToken } from '~/utils/token-selection'
import { failureStatus } from '~/utils/employee-lookup-messages'
import { evtArg } from '~/composables/useCoreS3Serial'

/**
 * USB でつないだ機体 (CoreS3・Vein Station・血圧測定台の ATOM S3) が読んだ IC カードを、
 * **USB シリアルから直接**受けて、免許証と同じく**そのまま測定へ進める**
 * (Refs ippoan/rust-alc-api#644, ippoan/alc-app#436)。
 *
 * firmware は読み取りの瞬間に
 * `EVT TIMECARD card_id=<生値> card_kind=<felica_idm|nfca_uid|license>` を USB へ流す。
 * 受け口は `useUsbHub().nfc` (どの機体から来た行かが分かる)。
 * **`card_kind=license` は捨てる** — 免許証は `EVT NFC_LICENSE` の流れ (`NormalMeasurement` の
 * `onNfcRead`) が既に処理する (Vein Station は免許証でも TIMECARD を出すので、拾うと二重になる)。
 *
 * # 打刻を書くのは「機体が自分で送らないとき」だけ
 *
 * 機体が自分で打刻を送る構成 (CoreS3・LAN 版の打刻端末) では、ここで書くと同じタップが 2 行に
 * なる。送らない構成 (Vein Station 版など) では、**ここで書かないと打刻が消える**。
 * 判定は `deviceSendsPunch` (`~/utils/device-line`) の 1 か所。
 *
 * 画面が書く構成で持ち主が引けたら、測定を始める口 (`startIc`) に card_id を渡し、
 * `NormalMeasurement` が測定の id を載せて打刻する (打刻と点呼が 1 対 1 で結ばれる)。
 * 測定を始められなかった (測定中・IT点呼・別のタブ) ときと、持ち主が引けないカードは、
 * ここが打刻だけを書く (オフラインなら見送る。今の免許証と同じくキューは無い)。
 *
 * # 案内のボタンは出さない
 *
 * 機体で読んだカードは即測定へ進むので、`latest` (IcPunchAlcoholPrompt のボタン) には載せない。
 * ボタンは**別の端末の打刻** (`setFromServer` = 打刻の一覧から来た行) のときだけ。
 * ただし機体が自分で送った同じタップも一覧から遅れて届くので、**同じ社員・近い時刻の
 * サーバ由来の行は捨てる** (`fromSerial` の印で見分ける)。
 *
 * # 持ち主は、まずサーバーに照会して引く (Refs ippoan/alc-app#387)
 *
 * オンラインなら `lookupEmployeeByCard` (読み取りだけ。打刻は書かない) で「このカードは
 * 誰のものか」を照会する。手元の写し (`useTimecardCardIndex` のカード台帳 + 社員の一覧) は
 * リロードの直後に揃っていないので、それだけに頼ると直後のタッチが引けなかった。
 *
 * - **見つかった (200)** → 応答の社員で測定を始める
 * - **見つからない (404・400)** → 測定は始めない。**手元の写しへは倒さない** (サーバーの答えを採る)
 * - **それ以外の失敗・上限 ({@link LOOKUP_TIMEOUT_MS}) 切れ・端末の鍵が無い・オフライン**
 *   → 手元の写しで引く。写しの鮮度の上限は `useTimecardCardIndex` が持つ
 *
 * 新しい読み取りが来たら、前の照会の結果は捨てる (unmount の後に届いた結果も)。
 *
 * # card_id の行き先
 *
 * **照会と打刻の body にだけ載せる**。ログ・診断・警告には出さない (社員の ID・氏名も)。
 * 引けなかったときは、黙って倒れると気づけない (Refs ippoan/alc-app#387) ので理由だけを 1 行 warn に残す。
 */

/**
 * この端末の機体で読んだタップとサーバ由来の行を「同じタップ」と見なす時間差。
 *
 * **ボタンの寿命 (`IcPunchAlcoholPrompt` の `FRESH_WINDOW_MS` = 10 秒) より
 * 長くしてある。** WS が切れているとサーバ由来の行は数分遅れて届くので、
 * 短くすると**同じタップが「別の端末の打刻」として通り、ボタンに出てしまう**。
 *
 * 窓の外で届いたぶんは通すが、その行の `punchedAt` はタップ時刻なので
 * `FRESH_WINDOW_MS` を既に過ぎており、**ボタンは出ない** (寿命は延びない)。
 */
const MERGE_WINDOW_MS = 60_000

/**
 * サーバーへの照会を待つ上限。**端末の鍵の取得待ちを含む。**
 *
 * カードをかざした人は画面が測定へ進むのを待っている。リロードの直後は端末の鍵の取得に
 * 数秒掛かるので 6 秒まで待ち、決着しなければ手元の写しへ倒す (`request()` 自体の上限
 * 30 秒は長すぎて使えない)。
 */
const LOOKUP_TIMEOUT_MS = 6_000

/** USB で受けた 1 回の読み取り。 */
interface CardRead {
  cardId: string
  /** 読み取りを受けた時刻 (ISO8601) */
  readAt: string
  /** 機体が自分で打刻を送る構成か (`deviceSendsPunch`)。false なら画面が書く */
  deviceSends: boolean
}

/** 持ち主が引けたカードで測定を始める口。`punchCardId` を渡したら測定に載せて打刻する。始められたかを返す */
export type StartIcMeasurement = (employeeId: string, name: string, punchCardId: string | null) => Promise<boolean>

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
  console.warn(`[HubTimecardPunch] 手元の台帳で引けないカード (${reason})`)
}

export function useHubTimecardPunch(
  resolveName: (employeeId: string) => string | null,
  startIc: StartIcMeasurement,
) {
  // USB でつないだ NFC を読める機体ならどれでも受ける (Refs ippoan/alc-app#436)
  const nfc = useUsbHub().nfc
  const vein = useVeinSerial()
  const cards = useTimecardCardIndex()
  const { accessToken } = useAuth()

  /** 案内のボタンに出す行。**サーバ由来 (別の端末の打刻) だけ** */
  const latest = ref<LatestPunch | null>(null)
  /** 直近にこの端末の機体で読んだタップ (サーバ由来の同じタップを捨てる判定に使う) */
  let fromSerial: { employeeId: string, punchedAt: string } | null = null
  /** 読み取りの世代。新しい読み取り・unmount で進め、古い照会の結果を捨てる */
  let generation = 0
  /**
   * サーバーへの照会 (端末の鍵の取得待ちを含む) の決着を待っているか。待つあいだに画面が
   * 新しい版へ自動でリロードされると、この機体で読んだ回を失う。
   * だから**待つあいだはリロードを止める申告を出す** (`useKioskScreen` の doc)。
   * どの決着でも下ろす: 見つかった / 見つからない / 失敗・上限で写しへ倒した / unmount。
   * 新しい読み取りで世代が替わったときは、その読み取りが持ち直す (オフラインなら下ろす)
   */
  const lookingUp = ref(false)
  useKioskScreen().declareReloadBlocked(lookingUp)
  let unsubscribe: (() => void) | null = null

  /**
   * 打刻だけを書く (測定と結ばない)。オフラインなら見送る (今の免許証と同じくキューは無い)。
   * 失敗は投げない — 理由だけを warn に残す (番号は出さない)
   */
  async function punchOnly(cardId: string): Promise<void> {
    if (!navigator.onLine) return
    try {
      await punchTimecard(cardId)
    }
    catch (e) {
      const status = failureStatus(e)
      console.warn(`[HubTimecardPunch] 打刻に失敗 (${status === null ? '通信の失敗' : `http ${status}`})`)
    }
  }

  /** 持ち主が引けた: 測定を始める。画面が書く構成では打刻も (始められなければ打刻だけ) */
  async function startFor(read: CardRead, employeeId: string, name: string): Promise<void> {
    fromSerial = { employeeId, punchedAt: read.readAt }
    const punchCardId = read.deviceSends ? null : read.cardId
    const started = await startIc(employeeId, name, punchCardId)
    if (!started && punchCardId !== null) await punchOnly(punchCardId)
  }

  /** 持ち主が引けない: 画面が書く構成なら打刻だけ書く (機体が送る構成でも未登録のカードは打刻に残る) */
  async function punchUnresolved(read: CardRead): Promise<void> {
    if (!read.deviceSends) await punchOnly(read.cardId)
  }

  /** 手元の写し (カード台帳 + 社員の一覧) で引く。オフライン・照会の失敗のときの倒れ先 */
  async function resolveFromLocal(read: CardRead): Promise<void> {
    const employeeId = cards.resolve(read.cardId)
    if (!employeeId) {
      warnUnresolved(cards.isFresh() ? '台帳に無い' : '台帳が古い')
      return punchUnresolved(read)
    }
    const name = resolveName(employeeId)
    if (!name) {
      warnUnresolved('名前が無い')
      return punchUnresolved(read)
    }
    return startFor(read, employeeId, name)
  }

  /**
   * サーバーに持ち主を照会する。**端末の鍵が無いときは照会しない** — `request()` は鍵が
   * 取れないと無認証の直 fetch に落ちるので、同じ規則 (`usesAdminToken` → キオスクの鍵) を
   * 先になぞって、送れるトークンが在るときだけ呼ぶ (鍵は cache されるので取得は 1 回)。
   * `useDeviceToken()` は `initApi` に渡す getter (`pages/index.vue`) と同じく使うときに呼ぶ。
   *
   * **`api.ts` の `request()` の `'default'` scope の選び方と揃えている。そちらを変えたらここも。**
   *
   * `stillWanted` は鍵が取れた時点で聞く — false (上限を過ぎた / 新しい読み取りが来た /
   * unmount された) なら、遅れて取れた鍵では照会しない。そのときの戻りは誰にも使われない
   */
  async function lookupOnServer(cardId: string, stillWanted: () => boolean): Promise<LookupOutcome> {
    try {
      if (!usesAdminToken(accessToken.value, 'kiosk')) {
        if (!(await useDeviceToken().getDeviceJwt())) return { kind: 'unavailable', reason: '端末の鍵が無い' }
        if (!stillWanted()) return { kind: 'unavailable', reason: '上限切れ' }
      }
      const employee = await lookupEmployeeByCard(cardId, 'default')
      return { kind: 'found', employeeId: employee.id, name: employee.name }
    }
    catch (e) {
      const status = failureStatus(e)
      if (status === 404 || status === 400) return { kind: 'not-found' }
      return { kind: 'unavailable', reason: status === null ? '通信の失敗' : `http ${status}` }
    }
  }

  /** 照会の決着を待って、測定を始める / 打刻だけ書く */
  async function resolveFromServer(read: CardRead, gen: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timeout = new Promise<LookupOutcome>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        resolve({ kind: 'unavailable', reason: '上限切れ' })
      }, LOOKUP_TIMEOUT_MS)
    })
    // 上限で決着した後に遅れて届いた応答は、ここで誰にも読まれずに捨てられる
    const outcome = await Promise.race([
      lookupOnServer(read.cardId, () => !timedOut && gen === generation),
      timeout,
    ])
    clearTimeout(timer)
    // 新しい読み取りが来た / unmount された (`lookingUp` はそちらが持つ)
    if (gen !== generation) return
    lookingUp.value = false

    if (outcome.kind === 'not-found') {
      console.warn('[HubTimecardPunch] サーバーの照会で持ち主が見つからないカード (測定は始めない)')
      return punchUnresolved(read)
    }
    if (outcome.kind === 'unavailable') {
      console.warn(`[HubTimecardPunch] サーバーに照会できない (${outcome.reason}。手元の写しで引く)`)
      return resolveFromLocal(read)
    }
    return startFor(read, outcome.employeeId, outcome.name)
  }

  function onEvent(name: string, args: string[], source: UsbHubKind): void {
    if (name !== 'TIMECARD') return
    // 免許証は `EVT NFC_LICENSE` の流れが処理する (二重にしない)
    if (evtArg(args, 'card_kind') === 'license') return
    const cardId = evtArg(args, 'card_id')
    if (!cardId) return
    const gen = ++generation
    const read: CardRead = {
      cardId,
      readAt: new Date().toISOString(),
      deviceSends: deviceSendsPunch(source, vein.deviceInfo.value?.flavor),
    }
    // オフラインなら照会しない (`navigator.onLine` は疎通の保証ではないが、false なら確実に届かない)
    if (!navigator.onLine) {
      // 前の読み取りの照会を待っていたなら、その結果はもう使わない
      lookingUp.value = false
      void resolveFromLocal(read)
      return
    }
    lookingUp.value = true
    void resolveFromServer(read, gen)
  }

  /**
   * サーバ由来 (`TodayPunchHistory` が一覧を引き直したぶん) の最新行を受ける。
   * **この端末の機体で読んだ同じタップなら捨てる** — 機体が自分で送った打刻が遅れて届いたもので、
   * その人は既に測定へ進んでいる。ボタンに出すのは別の端末の打刻だけ。
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
    unsubscribe = nfc.onEvent(onEvent)
  })
  onUnmounted(() => {
    generation += 1
    lookingUp.value = false
    cards.stopPeriodicRefresh()
    unsubscribe?.()
    unsubscribe = null
  })

  return { latest: readonly(latest), setFromServer }
}
