/**
 * 本番が flip された (= 新しい Service Worker が waiting になった) ときに、
 * **いつ新版へ入れ替えるか**だけを決める純ロジック。
 *
 * ## なぜ要るか (Refs #338 の項目 5)
 *
 * キオスクは 24 時間タブを開いたまま運用されるので、deploy と必ず衝突する。
 * ところが `registerType: 'autoUpdate'` のままだと次の二択にしかならなかった:
 *
 * - **気づかない** — `@vite-pwa/nuxt` が `registration.update()` を呼ぶのは
 *   `client.periodicSyncForUpdates > 0` のときだけ。既定は `0` なので定期チェックが
 *   1 度も走らず、ナビゲーションしないタブは flip を永久に知らない。
 *   古い app shell を掴み続け、遅延ロードする chunk が 404 になる。
 * - **気づいた瞬間に壊れる** — `autoUpdate` の register は
 *   `wb.addEventListener('activated', … window.location.reload())` なので、
 *   新 SW が activate した瞬間に**問答無用でリロードする**。測定中・入力中でも飛ぶ。
 *
 * そこで `nuxt.config.ts` 側を `registerType: 'prompt'` + `periodicSyncForUpdates` に変え、
 * 「**検知はするが、適用するのはここが許したとき**」という形に分ける。
 *
 * ## いつ許すか — 「点呼の最初の画面に居るとき」だけ
 *
 * 無操作時間のしきい値では判定しない。無操作は**点呼の途中でも起こる**
 * (乗務員が席を外す / 血圧計の再ペアリングで手間取る / 運行管理者の応答待ち) ので、
 * そこでリロードすると走っている点呼が飛ぶ。
 *
 * 代わりに {@link KIOSK_FIRST_STEP} — **まだ何も始まっていない画面** — に居ることを条件にする。
 * この瞬間はリロードで失うものが構造的に無い。
 *
 * ## キオスクが載っていない画面 — 申告した画面だけ (Refs #345)
 *
 * 運行管理者席は遠隔点呼の呼び出しを待って**画面を開いたまま待機する**ので、キオスクと
 * まったく同じ形で古い app shell を掴み続ける。「人が開いて操作するのでナビゲーションが
 * 起きる」という前提は成り立たない。
 *
 * かといって「キオスクが載っていなければ安全」にすると**逆に倒れすぎる** — 編集中・
 * 保存中のシステム管理画面まで問答無用でリロードしてしまい、ここが避けたはずの事故を
 * 別の画面で再現する。なので **opt-in**: 画面が
 * {@link ~/composables/useKioskScreen.useKioskScreen} の口で「いま失うものが無い」と
 * 申告したときだけ安全とし、同じ画面の中の「いまは困る」が 1 件でもあれば止める。
 * **誰も申告しなければ従来どおり安全ではない** (fail-closed)。
 *
 * DOM / Nuxt に触る wiring は `~/plugins/app-update.client.ts` 側。ここは副作用を
 * すべて {@link AppUpdateGateDeps} で受け取る純ロジックに保つ。
 */

/** 「まだ何も始まっていない画面」= `useTenkoKiosk` の `step` の初期値 (NFC 待ち)。 */
export const KIOSK_FIRST_STEP = 'nfc'

/** 新版が出ていないかを見に行く間隔 (ms)。 */
export const APP_UPDATE_TICK_MS = 30 * 1000

/** 告知を出してから実際に入れ替えるまでの猶予 (ms)。無言で飛ばさないための間。 */
export const APP_UPDATE_NOTICE_MS = 4 * 1000

/** 入れ替えの直前に画面へ出す文言。**次に何が起きるかまで書く** (Refs #329)。 */
export const APP_UPDATE_NOTICE_MESSAGE = '新しいバージョンがあります。読み込み直します'

/** リロード理由の記録に使う種別 (`[RELOAD-DETECT]` のログに出る)。 */
export const APP_UPDATE_RELOAD_REASON = 'pwa-update'

/** キオスク画面の現在地。載っていなければ `null` で表す。 */
export interface KioskScreen {
  /** `useTenkoKiosk` の `step`。 */
  step: string
  /**
   * 最初の画面に見えても手が離せない状態か。
   *
   * - 入口で止まっている (`bpRequirementUnknown`) — リロードすると**止めた理由が消える**
   * - 読み込み中 (`isLoading`) — NFC の照会などが飛ぶ
   *
   * 入口で止まっているときの `step` は `face_auth` のままなので
   * {@link KIOSK_FIRST_STEP} の判定だけでも弾けるが、**「最初の画面に見える状態」の
   * 定義が後から動いても誤認しない**よう明示的に持つ。
   */
  busy: boolean
}

/** {@link isSafeToReload} が見る材料をひとまとめにしたもの。 */
export interface ReloadContext {
  /** いま載っているキオスク画面。載っていなければ `null`。 */
  screen: KioskScreen | null
  /** 「いまリロードして失うものが無い」と申告している component の数 (Refs #345)。 */
  safe: number
  /** 「いまリロードされると困る」と申告している component の数 (Refs #345)。 */
  blocked: number
}

/**
 * いまリロードして失うものが無いか。
 *
 * - キオスクが載っている → 従来どおり「最初の画面かつ手が離せる」ときだけ
 * - 載っていない → **安全の申告が 1 件以上あり、拒否が 0 件**のときだけ
 *   (誰も申告していない画面は従来どおり対象外)
 */
export function isSafeToReload(context: ReloadContext): boolean {
  if (context.screen !== null) {
    return context.screen.step === KIOSK_FIRST_STEP && !context.screen.busy
  }
  return context.safe > 0 && context.blocked === 0
}

export interface AppUpdateGateDeps {
  /** いまの判定材料 (キオスクの現在地と、画面からの申告数)。 */
  context: () => ReloadContext
  /** 告知から入れ替えまでの猶予 (ms)。既定は {@link APP_UPDATE_NOTICE_MS}。 */
  noticeMs: number
  /** 新版がある旨を画面に出す。 */
  notice: (message: string) => void
  /** 入れ替え (= リロード) の直前にやること。grace 送信とリロード理由の記録。 */
  beforeApply: () => void
  /** 待機中の Service Worker を実際に有効化する (これがページをリロードする)。 */
  apply: () => void
  /** `noticeMs` 後に呼び出す予約。 */
  schedule: (fn: () => void, ms: number) => void
}

/** {@link AppUpdateGate.tick} の判定結果。ログとテストのために返す。 */
export type AppUpdateTickResult =
  /** 新版はまだ無い。 */
  | 'no-update'
  /** 新版はあるが、いま飛ばすと失うものがある (点呼の途中 / 誰も安全と申告していない画面)。 */
  | 'not-safe'
  /** 告知を出して入れ替えを予約した (この tick で 1 回だけ)。 */
  | 'applying'
  /** 既に予約済み。 */
  | 'already-applying'

export interface AppUpdateGate {
  /** 新しい Service Worker が waiting になった。 */
  markUpdateAvailable: () => void
  /** 条件が揃っていれば告知 → 入れ替えを予約する。 */
  tick: () => AppUpdateTickResult
}

/**
 * 「新版があり、かつ {@link isSafeToReload} が許す」ときだけ入れ替えを予約するゲートを作る。
 *
 * 一度 `applying` に入ったら二度と戻らない — 予約の直後に人が触り始めても入れ替えは
 * 取り消さない。告知から {@link AppUpdateGateDeps.noticeMs} 待つのは
 * 「**無言で飛ばさない**」ためで、操作を受け付けるためではない。
 */
export function createAppUpdateGate(deps: AppUpdateGateDeps): AppUpdateGate {
  let updateAvailable = false
  let applying = false

  return {
    markUpdateAvailable: () => {
      updateAvailable = true
    },

    tick: () => {
      if (applying) return 'already-applying'
      if (!updateAvailable) return 'no-update'
      if (!isSafeToReload(deps.context())) return 'not-safe'

      applying = true
      deps.notice(APP_UPDATE_NOTICE_MESSAGE)
      deps.beforeApply()
      deps.schedule(() => deps.apply(), deps.noticeMs)
      return 'applying'
    },
  }
}
