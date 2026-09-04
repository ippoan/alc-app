/**
 * 打刻更新の購読 (Refs ippoan/alc-app-s3#134)。
 *
 * cf-alc-recorder の `GET /watch-timecard` に WS で繋ぎ、打刻が入ったら
 * `{"type":"timecard_punch"}` の**合図だけ**を受け取る。**行の中身は来ない** ので、
 * 受けた側は打刻一覧 (`GET /api/timecard/punches`) を引き直す。
 * 行の形 (区分 / card_id / 社員解決の凍結 / JST 境界) は rust-alc-api が持っており、
 * 画面や Worker に 2 実装目を作ると必ずズレるため。
 *
 * **管理画面 (TimecardManager) とキオスク (TimePunchKiosk) で共有する。**
 * どちらも「打刻が入ったら一覧を引き直す」だけなので、2 実装目を作らない。
 *
 * # 取りこぼさないための 3 点
 *
 * - **`onopen` で無条件に 1 回引き直す。** 切断中に入った打刻は合図が届かない
 * - **WS が繋がっていない間だけポーリングする** (既定 30 秒)。繋がったら止める
 *   ので二重取得にならない
 * - **トークンが取れなくても画面を壊さない** (未ペアリングのキオスク)。
 *   WS を張らずポーリングだけで動く
 *
 * トークンは `Sec-WebSocket-Protocol` の 2 つ目に載せる
 * (`["alc.timecard.v1", "<jwt>"]`)。ブラウザは WS にヘッダーを付けられず、
 * `?token=` にすると常時表示のキオスクが 1 時間ごとに mint する device 資格情報が
 * Worker のログと分析に残り続けるため。
 */
import { isClient } from '~/utils/env'

/** 購読 WS のサブプロトコル名 (cf-alc-recorder の `WATCH_SUBPROTOCOL` と一致)。 */
export const TIMECARD_WATCH_SUBPROTOCOL = 'alc.timecard.v1'

/** WS 未接続のあいだだけ回すポーリング間隔 (ms)。 */
const POLL_INTERVAL_MS = 30_000

/** 再接続の初期待ち時間 (ms)。切断のたびに 2 倍にし、上限で頭打ちにする。 */
const RECONNECT_BASE_MS = 3_000
const RECONNECT_MAX_MS = 60_000

/** keepalive の間隔 (ms)。 */
const PING_INTERVAL_MS = 30_000

/**
 * keepalive の ping。**この文字列と完全一致**する必要がある — DO の
 * `setWebSocketAutoResponse` が一致したものだけを `webSocketMessage` を通さずに
 * 返すため。ずれると購読 WS は「上りを送った」と見なされて 1011 で切られる
 * (再接続とポーリングで復帰はするが、無駄に切れ続ける)。
 */
const PING_FRAME = '{"type":"ping"}'

export interface TimecardWatchOptions {
  /**
   * 購読に使う JWT を返す。管理画面は `useAuth` の access token、キオスクは
   * `useDeviceToken().getDeviceJwt()`。**取れなければ null** (未ログイン /
   * 未ペアリング) — その場合は WS を張らずポーリングに落ちる。
   */
  getToken: () => string | null | Promise<string | null>
  /** 引き直しの実処理 (打刻一覧の再取得)。 */
  onChange: () => unknown
}

/**
 * `https://…` / `http://…` を購読 WS の URL に直す (末尾スラッシュは落とす)。
 * **空文字なら空文字を返す** — 未設定のまま `new WebSocket()` に渡さない。
 */
export function toTimecardWatchUrl(base: string): string {
  const trimmed = base.replace(/\/$/, '')
  if (!trimmed) return ''
  return `${trimmed.replace(/^http/, 'ws')}/watch-timecard`
}

export function useTimecardWatch(options: TimecardWatchOptions) {
  const config = useRuntimeConfig()
  // nuxt.config.ts が既定値を持つので常に文字列 (空なら購読しない = ポーリングのみ)
  const url = toTimecardWatchUrl(config.public.recorderUrl as string)

  const isConnected = ref(false)

  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let reconnectDelay = RECONNECT_BASE_MS
  let stopped = false
  /** token 取得 (await) 中の二重接続を防ぐ。 */
  let connecting = false

  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(() => { options.onChange() }, POLL_INTERVAL_MS)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function stopPing() {
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
  }

  function scheduleReconnect() {
    // 呼び出し側が stopped を見てから呼ぶ (二重予約だけをここで弾く)
    if (reconnectTimer) return
    const delay = reconnectDelay
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delay)
  }

  /**
   * 購読を開始する。**トークンが無ければ WS を張らずポーリングだけ**で続ける
   * (キオスクのペアリングは後から行われることがあるので、再試行はする)。
   */
  async function connect(): Promise<void> {
    if (!isClient || stopped) return
    if (ws || connecting) return
    // 未接続のあいだは常にポーリングで拾う (張れなかった場合もここで担保)
    startPolling()

    connecting = true
    // getToken は同期でも Promise でもよい (mint 失敗は null 扱いにする)
    const token = await Promise.resolve(options.getToken()).catch(() => null)
    connecting = false
    if (stopped) return
    // url が空 = recorderUrl 未設定。**ポーリングだけで動かす** (画面は壊さない)
    if (!url || !token) {
      scheduleReconnect()
      return
    }

    let sock: WebSocket
    try {
      sock = new WebSocket(url, [TIMECARD_WATCH_SUBPROTOCOL, token])
    }
    catch {
      scheduleReconnect()
      return
    }
    ws = sock

    sock.onopen = () => {
      isConnected.value = true
      reconnectDelay = RECONNECT_BASE_MS
      // **切断中の打刻は合図が届かない。** 繋がった時点で必ず 1 回引き直す
      stopPolling()
      options.onChange()
      pingTimer = setInterval(() => sock.send(PING_FRAME), PING_INTERVAL_MS)
    }

    sock.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as { type?: string }
        // 合図以外 (pong 等) は無視する
        if (data.type === 'timecard_punch') options.onChange()
      }
      catch {
        // 非 JSON は無視
      }
    }

    sock.onclose = () => {
      isConnected.value = false
      ws = null
      stopPing()
      // **stop() 由来の close ではポーリングも再接続も再開しない。**
      // ここを忘れると「止めたのに引き直し続ける」画面になる
      if (stopped) return
      startPolling()
      scheduleReconnect()
    }
  }

  /** 購読を止める (再接続もポーリングもしない)。 */
  function stop() {
    stopped = true
    stopPolling()
    stopPing()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (ws) {
      ws.close()
      ws = null
    }
    isConnected.value = false
  }

  onUnmounted(stop)

  return {
    /** WS が繋がっているか (false のあいだはポーリングで拾っている)。 */
    isConnected: readonly(isConnected),
    connect,
    stop,
  }
}
