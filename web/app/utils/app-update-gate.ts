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
 * この瞬間はリロードで失うものが構造的に無い。キオスクが載っていない画面
 * (管理画面など) は `null` になり、**適用しない**。あちらは人が開いて操作するので
 * ナビゲーションが起き、ブラウザ標準の Service Worker 更新チェックで自然に新版へ移る。
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

/** いまリロードして失うものが無いか。 */
export function isSafeToReload(screen: KioskScreen | null): boolean {
  if (screen === null) return false
  return screen.step === KIOSK_FIRST_STEP && !screen.busy
}

export interface AppUpdateGateDeps {
  /** いまのキオスク画面 (載っていなければ `null`)。 */
  screen: () => KioskScreen | null
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
  /** 新版はあるが、いま飛ばすと失うものがある (点呼の途中 / 管理画面)。 */
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
 * 「新版があり、かつ点呼の最初の画面に居る」ときだけ入れ替えを予約するゲートを作る。
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
      if (!isSafeToReload(deps.screen())) return 'not-safe'

      applying = true
      deps.notice(APP_UPDATE_NOTICE_MESSAGE)
      deps.beforeApply()
      deps.schedule(() => deps.apply(), deps.noticeMs)
      return 'applying'
    },
  }
}
