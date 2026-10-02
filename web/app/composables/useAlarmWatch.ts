/**
 * 据置警告デバイス (Atom VoiceS3R / USB) の見張りを、ロールタブに関わらずアプリで 1 本だけ動かす。
 *
 * 見張り = 着信購読 (useActiveRooms.start) と警告デバイスへの接続 (useAlarmDevice.connect)。
 * **この 2 つは必ず対で動かす** — 購読せずに接続すると heartbeat が `HB NG signaling` になり
 * デバイスが鳴る (useAlarmDevice 冒頭の規約)。止めるときも対で止める。
 *
 * 呼び口はトップ画面 (pages/index.vue) の 1 か所。運行管理者の PC は運行者などのタブを
 * ログイン無しで使うので、運行管理者タブ (ManagerAlarmBar) に入るまで繋がないと、
 * 警告デバイスが未接続のままになる (Refs #231)。ManagerAlarmBar は表示と「接続」ボタンだけ。
 *
 * 動かすのは「この端末で使う」(useAlarmDeviceSetting が true) かつ Web Serial が使えるときだけ。
 * 止めるのは設定を off にしたときだけ — ロールタブ切替やトップ画面の unmount では止めない (#205)。
 *
 * ## 運行管理者の鍵のトークンの先取り (Refs ippoan/alc-app#387)
 *
 * 警告デバイスが繋がるたびに、運行管理者の鍵のトークンを 1 回取りに行く。開発用の印
 * (`isDevDevice('manager-device')`) は鍵のトークンを 1 度取ったときに立つが、Google ログイン済みの
 * 席は管理者のトークンで足りてしまい、取りに行く引き金が他に無い (測定台とキオスクには
 * 同じ先取りが既にある — `useBpStationDeviceToken` / `useHubClaim`)。
 * トークンの cache が有効なあいだは通信しない。失敗しても何も起こさない
 * (`useManagerDeviceToken().prefetchManagerJwt`)。
 *
 * 繋がった直後は警告デバイスの準備が間に合わず、先取りが失敗することがある。席にはほかに取り直す
 * 引き金が無い (heartbeat はトークンに触らない) ので、**その接続につき 1 回だけ**
 * `PREFETCH_RETRY_DELAY_MS` 後に先取りを呼び直す。2 回目も失敗したらそれ以上は試さない
 * (定周期の取り直しにはしない)。待っているあいだに切れたとき・見張りをやめたときは取り消す。
 * 繋がり直せば、また 1 回ぶん試せる。取れれば `managerJwtRecoveredCount` が増え、席の鍵で読む
 * 画面が自分で読み直す。
 *
 * ## 切断の猶予 (Refs ippoan/alc-app#387)
 *
 * 繋がっていた警告デバイスが切れたら、`SEAT_DISCONNECT_GRACE_MS` 後を期限として運行管理者の鍵の
 * トークンに入れ (`setDisconnectDeadline`)、それまでの残り秒を `useSeatDisconnectGrace()` に出す
 * (`ManagerAlarmBar` が読む)。期限までに繋がり直せば期限を外し、何も起きない。期限を切るのは
 * トークンの側で、ここの 1 秒ごとの処理は表示の残り秒のためだけ。**起動直後・リロード直後の
 * 「まだ繋がっていない」では始めない** (一度繋がってから切れたときだけ)。設定を off にして
 * 見張りをやめたときは、猶予なしでその場で期限を切る。
 *
 * 猶予の 2 分が過ぎてから繋がり直すまでのあいだは `useSeatDisconnectGrace().expired` が true
 * (IT点呼 の受け画面が、開いている点呼を閉じて理由を出すのに読む)。設定を off にして自分で
 * 見張りをやめた席では true にしない (警告デバイスを使わない席と同じ表示のままにする)。
 */

/** 警告デバイスが切れてから、運行管理者の鍵のトークンを使えなくするまでの猶予 (ms) */
export const SEAT_DISCONNECT_GRACE_MS = 120_000

/**
 * 接続時の先取りが失敗してから、1 回だけ試し直すまでの待ち (ms)。
 *
 * 数え始めるのは**失敗が確定した時点** (接続の時点ではない) なので、1 回目の署名の待ち
 * (`utils/alarm-sign.ts` の 10 秒) とは重ならない。値を 10 秒ちょうどにしないのは、警告デバイスが
 * 署名に応えずに待ちが切れた直後 (応答が遅れて届きうる間合い) に次の署名を頼まないため。
 * 利用者が「更新」を押すより先に直る程度の短さに留める。
 */
export const PREFETCH_RETRY_DELAY_MS = 15_000

/** 猶予の残り秒。数えていないときは null (アプリ全体で 1 つ) */
const disconnectRemainingSeconds = ref<number | null>(null)
let countdownTimer: ReturnType<typeof setInterval> | null = null
/** 猶予が切れたままか (2 分たっても繋がり直していない)。繋がり直したら false (アプリ全体で 1 つ) */
const disconnectExpired = ref(false)

function stopCountdown(): void {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
  disconnectRemainingSeconds.value = null
}

function startCountdown(deadlineMs: number): void {
  // 残り秒は期限と今の差分から出す (処理が遅れて飛んでも、回数ではなく時刻に合う)
  const tick = () => {
    const seconds = Math.ceil((deadlineMs - Date.now()) / 1000)
    if (seconds <= 0) {
      stopCountdown()
      disconnectExpired.value = true
    }
    else {
      disconnectRemainingSeconds.value = seconds
    }
  }
  countdownTimer = setInterval(tick, 1000)
  tick()
}

/**
 * 切断の猶予の状態 (読むだけ)。
 * - `remainingSeconds`: 猶予の残り秒。数えていないときは null
 * - `expired`: 猶予が切れたままか。繋がり直すまで true
 */
export function useSeatDisconnectGrace() {
  return {
    remainingSeconds: readonly(disconnectRemainingSeconds),
    expired: readonly(disconnectExpired),
  }
}

/**
 * 見張りを始めたか (アプリ全体で 1 つ)。トップ画面の再 mount で二重に始めないため
 * module スコープで持つ — start() は参照カウント (対になる stop が無いと下がらない)、
 * connect() も no-op ではない (installNgWatch / arbiter.register / 再接続の印の削除)
 */
let started = false
/** 先取りの見張りを止める関数。start() が入れ、stop() が呼ぶ (stop は始めた後にしか進まない) */
let stopPrefetchWatch!: () => void
/** 先取りの試し直しの待ち。待っていなければ null */
let prefetchRetryTimer: ReturnType<typeof setTimeout> | null = null
/** 接続の世代。切断・見張りの停止で進め、古い接続の先取りの結果から試し直しを始めない */
let connectionGeneration = 0

/** 先取りの試し直しをやめる (待っている分を取り消し、まだ返っていない先取りの結果も捨てる) */
function cancelPrefetchRetry(): void {
  connectionGeneration += 1
  if (prefetchRetryTimer !== null) {
    clearTimeout(prefetchRetryTimer)
    prefetchRetryTimer = null
  }
}

export function useAlarmWatch(): void {
  const alarm = useAlarmDevice()
  // Web Serial の無いブラウザでは購読も heartbeat も立てない
  if (!alarm.isSupported) return
  const rooms = useActiveRooms()
  const { enabled } = useAlarmDeviceSetting()
  const seat = useManagerDeviceToken()

  function start(): void {
    if (started) return
    started = true
    rooms.start()
    // BLE ゲートウェイと同居しない PC なので、ポートの取り合いを待つ必要が無い
    alarm.connect(0)
    // トップ画面の unmount で止まらないよう、component から切り離した scope で見張る。
    // immediate: 始めた時点で既に繋がっていれば、そのとき 1 回
    const scope = effectScope(true)
    scope.run(() => watch(alarm.isConnected, (connected, wasConnected) => {
      if (connected) {
        // 繋がり直した: 猶予をやめる (期限を外してから取りに行く)
        seat.clearDisconnectDeadline()
        stopCountdown()
        disconnectExpired.value = false
        const generation = connectionGeneration
        void seat.prefetchManagerJwt().then((obtained) => {
          // 取れた / 返るまでに切れた・見張りをやめた: 試し直さない
          if (obtained || generation !== connectionGeneration) return
          prefetchRetryTimer = setTimeout(() => {
            prefetchRetryTimer = null
            // 1 回だけ。結果は見ない (失敗してもそれ以上は試さない)
            void seat.prefetchManagerJwt()
          }, PREFETCH_RETRY_DELAY_MS)
        })
      }
      else if (wasConnected) {
        // 繋がっていたものが切れた: 先取りの試し直しをやめ、猶予を始める
        cancelPrefetchRetry()
        const deadlineMs = Date.now() + SEAT_DISCONNECT_GRACE_MS
        seat.setDisconnectDeadline(deadlineMs)
        startCountdown(deadlineMs)
      }
    }, { immediate: true }))
    stopPrefetchWatch = () => scope.stop()
  }

  function stop(): void {
    if (!started) return
    started = false
    stopPrefetchWatch()
    cancelPrefetchRetry()
    // 利用者が自分で見張りをやめた: 猶予なしでその場で期限を切る。見張りは上で止めたので、
    // 下の切断は見張りに届かない (ここで明示的に切る)
    stopCountdown()
    disconnectExpired.value = false
    seat.setDisconnectDeadline(Date.now())
    void alarm.disconnect()
    // 参照カウントなので、遠隔点呼タブの子が先に stop していても WebSocket は残る
    rooms.stop()
  }

  // 探索は「使う」と決まってから。未設定のあいだは ManagerAlarmBar の問いかけカードだけを出す
  onMounted(() => {
    if (enabled.value === true) start()
  })
  watch(enabled, (v) => {
    // 問いかけカードで [つなぐ] を選んだ瞬間に始める
    if (v === true) start()
    // 設定を off にしたときだけ止める (unmount では止めない = ロールタブ切替で鳴らさない)
    else if (v === false) stop()
  })
}
