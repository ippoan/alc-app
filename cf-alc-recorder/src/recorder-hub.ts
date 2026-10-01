import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { DEV_HEADER_VALUE, RECORDER_DEV_HEADER, resolveSecret } from "./auth";
import {
  buildTimecardPunch,
  CRASH_LOG_KIND,
  forwardMeasurements,
  notifyCrashByEmail,
  parseMeasurementItem,
  storeCrashLog,
  TIMECARD_KIND,
  type TimecardPunchInput,
} from "./measurements";

/**
 * RecorderHub — テナント単位の Durable Object (Hibernatable WebSockets)。
 *
 * 上り (CoreS3 → server):
 *   - `{ type: "measurement", seq, recorded_at_ms?, kind?, session_id?, payload }`
 *       → auth-worker `/alc-internal-proxy` 経由で rust-alc-api
 *         `POST /api/hub/measurements` へ転送 → `{ type: "ack", seq }` を返す。
 *       転送失敗時は `{ type: "error", seq, message }` (端末は同じ seq で再送する。
 *       rust 側 `UNIQUE (tenant_id, device_id, seq)` が重複を冪等に吸収する)。
 *       tenant_id / device_id は WS attachment (= introspect 済み JWT claims) から
 *       注入する — ペイロード値は信用しない。
 *   - `{ type: "command_result", id, payload? }` → DO storage に保存 (10 分 TTL、
 *       `GET /command-result/:id` で取得)。
 *   - `{ type: "ping" }` → `{ type: "pong" }` (setWebSocketAutoResponse で
 *       hibernation を起こさず応答。完全一致しない serialization は handler fallback)。
 *
 * 上り (ブラウザ → server、Refs ippoan/alc-app-s3#134):
 *   - `POST /timecard-punch` (worker の内部 HTTP API から) → 端末の WS 打刻と
 *     **同じ 1 か所**で ingest 転送 + 購読者への合図を行う。
 *
 * 下り (server → CoreS3、issue #106 設計レビュー決定):
 *   - `POST /command` (worker の内部 HTTP API から) → 接続中デバイスへ
 *     `{ type: "command", id, payload }` を push。
 *
 * ファームの更新の状態 (Refs ippoan/alc-app#403):
 *   - `POST /ota-report` (worker の内部 HTTP API から) → キオスクが繋いでいる端末の
 *     版・更新の状態を DO storage に保存 (端末ごとに 1 件、7 日 TTL、200 件まで)。
 *   - `GET /ota-status` → 保存した報告の一覧。
 *
 * Hibernation 復帰: 接続 identity は in-memory に持たず、毎メッセージ
 * `ws.deserializeAttachment()` から読む (= 復帰後も転送先 tenant/device が壊れない)。
 * dev端末かどうか (Refs ippoan/alc-app#387) も同じ attachment に持つ。
 *
 * 下り (server → browser、device/setup ページの live update、Refs auth-worker
 * live update 要望): `GET /events` は SSE で接続中デバイス一覧の変化を push する。
 * `sseControllers` は in-memory (DO storage 非永続) — SSE は接続維持中しか
 * hibernation しない (ハンドラの fetch が生きている間は isolate も生きる) ため
 * 一覧を毎回 `getWebSockets()` から再計算すれば問題ない。SSE 接続自体が切れたら
 * (タブを閉じる等) controller を配列から外すだけで DO 側の状態は増えない。
 */

/** WS attachment。hibernation を跨いで identity を保持する。 */
interface WsAttachment {
  tenantId: string;
  /**
   * device 接続のみ。**購読 (watcher) 接続では未設定にする** —
   * `currentDeviceIds()` が全ソケットから拾うので、載せるとブラウザが
   * 「接続中デバイス」一覧に現れる (Refs ippoan/alc-app-s3#134)。
   */
  deviceId?: string;
  /**
   * dev端末の接続なら `true` (Refs ippoan/alc-app#387)。**本番では欄ごと載せない。**
   * 値は worker が introspect の結果から立てたもので、接続の間は変わらない。
   */
  dev?: true;
}

/** attachment を組み立てる (dev は true のときだけ欄を作る)。 */
function buildAttachment(tenantId: string, deviceId: string | undefined, dev: boolean): WsAttachment {
  return {
    tenantId,
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(dev ? { dev: true as const } : {}),
  };
}

/**
 * device 接続の attachment (`deviceId` が必ずある)。
 *
 * `WsAttachment.deviceId` は watcher のために optional なので、device 経路の
 * ハンドラはこちらを受け取る。**`webSocketMessage` の guard を通った後だけ**
 * 作れる — guard を消すと型でも落ちる。
 */
type DeviceAttachment = WsAttachment & { deviceId: string };

/** 上りメッセージ (JSON parse 後、field は全て untrusted)。 */
interface InboundMessage {
  type?: unknown;
  seq?: unknown;
  recorded_at_ms?: unknown;
  session_id?: unknown;
  kind?: unknown;
  payload?: unknown;
  id?: unknown;
}

/** getWebSockets の device 絞り込み用 tag。 */
const DEVICE_TAG_PREFIX = "device:";

/**
 * 打刻更新の購読者 (ブラウザ) の tag。**device とは別の tag にする** —
 * 下り command は `getWebSockets(DEVICE_TAG_PREFIX + ...)` で配るので、
 * 別 tag にしておけば watcher には構造的に届かない (Refs ippoan/alc-app-s3#134)。
 */
const WATCH_TAG = "watch:timecard";

/**
 * 同じ購読者のうち **dev端末** の tag (Refs ippoan/alc-app#387)。
 *
 * dev端末の打刻は backend で本番の行と分けて持たれるので、合図も分ける:
 * dev の打刻は dev の購読者にだけ、本番の打刻は本番の購読者にだけ届く。
 * **購読者はどちらか片方の tag しか持たない** — 両方に付けると、本番の画面が
 * dev の打刻のたびに引き直しに行く (逆も)。
 */
const WATCH_DEV_TAG = "watch:timecard:dev";

/** 打刻した側 / 購読する側の dev に対応する tag。 */
function watchTagFor(dev: boolean): string {
  return dev ? WATCH_DEV_TAG : WATCH_TAG;
}

/**
 * シリアル OTA の合図 (`POST /serial-ota`) を受けるキオスク購読者だけの tag。
 * **別 tag にしておけば、キオスク以外の購読者と device には構造的に届かない**
 * (Refs ippoan/alc-app-s3#279)。
 */
const KIOSK_TAG = "watch:kiosk";

/**
 * 購読 WS のサブプロトコル名。ブラウザは `["alc.timecard.v1", "<jwt>"]` を送り、
 * サーバはこちらだけを echo し返す (トークンを応答ヘッダーに乗せない)。
 */
export const WATCH_SUBPROTOCOL = "alc.timecard.v1";

/** command_result の storage key prefix。 */
const CMD_RESULT_PREFIX = "cmdres:";

/** command_result の保持期間 (この時間を過ぎたら次の書き込み時に prune)。 */
const CMD_RESULT_TTL_MS = 10 * 60 * 1000;

/** ファームの更新の報告 (`POST /ota-report`) の storage key prefix。 */
const OTA_STATE_PREFIX = "ota-state:";

/** 更新の報告の保持期間 (過ぎたものは一覧に出さず、次の書き込み時に prune)。 */
const OTA_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 更新の報告の件数の上限 (1 テナント = 1 DO あたり)。超える書き込みは古いものから消す。 */
const OTA_STATE_MAX = 200;

/** `storage.delete(keys)` に 1 回で渡せる key の数 (Durable Objects の KV API の上限)。 */
const STORAGE_DELETE_BATCH = 128;

/** 更新の合図・報告に載る端末の指定の字種と長さ (Refs ippoan/alc-app#403)。 */
const OTA_DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 更新の合図 (`serial_ota`) と報告で受け付ける `device_id` か。 */
export function isOtaDeviceId(value: unknown): value is string {
  return typeof value === "string" && OTA_DEVICE_ID_RE.test(value);
}

/** 更新の報告の `phase` で受け付ける値。 */
const OTA_PHASES = [
  "idle",
  "downloading",
  "writing",
  "rebooting",
  "confirming",
  "done",
  "failed",
  "skipped",
] as const;
type OtaPhase = (typeof OTA_PHASES)[number];

/** 更新の報告の `kind` の長さ上限。 */
const OTA_KIND_MAX_LEN = 32;

/** 更新の報告の任意の文字列の欄と、その長さ上限。 */
const OTA_TEXT_KEYS = ["board", "flavor", "version", "target_version", "reason"] as const;
const OTA_TEXT_MAX_LEN = 64;

/** 更新の報告 1 件 (検査済み)。**無い値は key ごと持たない。** */
export interface OtaReport {
  device_id: string;
  kind: string;
  board?: string;
  flavor?: string;
  version?: string;
  target_version?: string;
  phase: OtaPhase;
  pct?: number;
  reason?: string;
}

/** DO storage に置く形 (`GET /ota-status` はこれをそのまま返す)。 */
type OtaState = OtaReport & { reported_at_ms: number };

export type ParseOtaReportResult =
  | { ok: true; report: OtaReport }
  | { ok: false; error: "invalid_body" | "invalid_device_id" | "invalid_kind" | "invalid_phase" };

/**
 * 更新の報告の body を検査する (Refs ippoan/alc-app#403)。
 *
 * - 必須 (`device_id` / `kind` / `phase`) は形が外れたら報告ごと弾く。
 * - 任意の欄は形が外れたら**その欄だけ捨てる** — 飾りの欄 1 つを理由に、更新の状態
 *   (`phase`) の報告そのものを失わないため (`normalizeSessionId` と同じ倒し方)。
 * - ここに挙げた key だけを取り出す。未知の key は保存しない。
 */
export function parseOtaReport(body: unknown): ParseOtaReportResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_body" };
  }
  const src = body as Record<string, unknown>;
  const deviceId = src.device_id;
  if (!isOtaDeviceId(deviceId)) {
    return { ok: false, error: "invalid_device_id" };
  }
  const kind = src.kind;
  if (typeof kind !== "string" || kind.length < 1 || kind.length > OTA_KIND_MAX_LEN) {
    return { ok: false, error: "invalid_kind" };
  }
  const phase = OTA_PHASES.find((p) => p === src.phase);
  if (phase === undefined) {
    return { ok: false, error: "invalid_phase" };
  }
  const report: OtaReport = { device_id: deviceId, kind, phase };
  for (const key of OTA_TEXT_KEYS) {
    const value = src[key];
    if (typeof value === "string" && value.length <= OTA_TEXT_MAX_LEN) report[key] = value;
  }
  const pct = src.pct;
  if (typeof pct === "number" && Number.isInteger(pct) && pct >= 0 && pct <= 100) {
    report.pct = pct;
  }
  return { ok: true, report };
}

/** 保存した時刻 (`stampKey` の欄) が無い、または TTL を過ぎた記録か。 */
function isExpired(value: unknown, stampKey: string, ttlMs: number, now: number): boolean {
  const stamp = (value as Record<string, unknown> | null | undefined)?.[stampKey];
  return typeof stamp !== "number" || !stamp || now - stamp > ttlMs;
}

/** 上り 1 メッセージの上限 (これ以上は parse せず reject)。 */
const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * `ws.close()` に**渡せない** close code。
 *
 * - `1005` … 相手が close frame に status を載せなかった
 * - `1006` … close frame 無しで切れた (異常終了)
 *
 * どちらも「受け取る側が状況を表すための値」で、送ることはできない。
 * workerd は `TypeError: Invalid WebSocket close code: 1005.` を投げる。
 */
const RESERVED_CLOSE_CODES = new Set([1005, 1006]);

/**
 * 相手の close code を、そのまま `ws.close()` へ渡せる値に丸める。
 *
 * **これは異常系の保険ではなく、定常的に通る経路。** ブラウザの
 * `ws.close()` を**引数なし**で呼ぶと相手側は `1005` になる — キオスクの購読は
 * まさにそれ (`web/app/composables/useTimecardWatch.ts` の `stop()`)。回線が
 * 黙って切れれば `1006`。
 *
 * 丸めずに投げると `webSocketClose` がそこで止まり、**続きの
 * `broadcastDevices()` に到達しない** → `/events` の「接続中デバイス一覧」が
 * 切断後も古いまま残る (Refs ippoan/rust-alc-api#644)。
 */
export function closeCodeForEcho(code: number): number {
  return RESERVED_CLOSE_CODES.has(code) ? 1000 : code;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export class RecorderHub extends DurableObject<Env> {
  /** 接続中の SSE クライアント (`/events`)。DO storage には持たない (in-memory のみ)。 */
  private readonly sseControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  /**
   * ブラウザ打刻に採番した直近の seq (in-memory)。**永続化しない** —
   * hibernation から復帰すると 0 に戻るが、そのときは `Date.now()` の方が
   * 大きいので単調性は壊れない。
   */
  private lastPunchSeq = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // keepalive ping は hibernation を起こさず runtime が応答する (文字列完全一致)。
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: "ping" }),
        JSON.stringify({ type: "pong" }),
      ),
    );
  }

  /**
   * worker (src/index.ts) からの内部呼び出しのみを想定。認証 (device JWT introspect /
   * INTERNAL_SHARED_SECRET) は worker 側で完了しており、identity は
   * `X-Recorder-Tenant-Id` / `X-Recorder-Device-Id` ヘッダーで受け取る。
   * dev端末かどうかは `X-Recorder-Dev` (worker が必ず上書きする) で受け取る。
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      return this.handleConnect(request);
    }
    if (url.pathname === "/watch") {
      return this.handleWatch(request);
    }
    if (url.pathname === "/serial-ota" && request.method === "POST") {
      return this.handleSerialOta(request);
    }
    if (url.pathname === "/ota-report" && request.method === "POST") {
      return this.handleOtaReport(request);
    }
    if (url.pathname === "/ota-status" && request.method === "GET") {
      return this.handleOtaStatus();
    }
    if (url.pathname === "/timecard-punch" && request.method === "POST") {
      return this.handleTimecardPunch(request);
    }
    if (url.pathname === "/command" && request.method === "POST") {
      return this.handleCommand(request);
    }
    if (url.pathname === "/devices" && request.method === "GET") {
      return this.handleDevices();
    }
    if (url.pathname === "/events" && request.method === "GET") {
      return this.handleEvents();
    }
    const resultMatch = url.pathname.match(/^\/command-result\/([^/]+)$/);
    if (resultMatch && request.method === "GET") {
      return this.handleCommandResultGet(decodeURIComponent(resultMatch[1]));
    }
    return json({ error: "not_found" }, 404);
  }

  // ── WS 受口 ────────────────────────────────────────────────────────────────

  /**
   * 打刻更新の購読 WS (読み取り専用)。
   *
   * **attachment に `deviceId` を載せない。** `currentDeviceIds()` は全ソケットを
   * 走査して `attachment.deviceId` を拾うので、載せると**キオスクが「接続中
   * デバイス」一覧に現れ、SSE で管理画面に配信される**。
   *
   * その結果 `webSocketMessage` は (deviceId が無いので) この接続からの上りを
   * 1011 で切る。**それが意図した挙動** — watcher は購読専用で、上りを受けると
   * 「ブラウザから DO を叩く口」になる。keep-alive の ping は constructor の
   * `setWebSocketAutoResponse` が `webSocketMessage` を通さずに返すので成立する。
   */
  private handleWatch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const tenantId = request.headers.get("X-Recorder-Tenant-Id") ?? "";
    if (!tenantId) {
      return json({ error: "missing_identity" }, 400);
    }
    // worker (src/index.ts) が introspect 済み判定から必ず上書きして付けるヘッダー
    // (Refs #279)。kiosk だけ `KIOSK_TAG` を足す — シリアル OTA の合図の宛先になる。
    const isKiosk = request.headers.get("X-Recorder-Watcher-Kind") === "kiosk";
    // 合図の tag は dev / 本番のどちらか片方だけ (Refs ippoan/alc-app#387)。
    // `KIOSK_TAG` (シリアル OTA の合図) は dev を問わない — 端末の firmware の話で、
    // 記録の区別とは関係が無い。
    const dev = request.headers.get(RECORDER_DEV_HEADER) === DEV_HEADER_VALUE;
    const watchTag = watchTagFor(dev);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], isKiosk ? [watchTag, KIOSK_TAG] : [watchTag]);
    pair[1].serializeAttachment(buildAttachment(tenantId, undefined, dev));
    // サブプロトコルを 1 つも返さないとブラウザが即座に閉じる。
    // **トークン側を返してはいけない** (応答ヘッダーに秘密が乗る)
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "Sec-WebSocket-Protocol": WATCH_SUBPROTOCOL },
    });
  }

  /**
   * 打刻が入ったことを購読者へ知らせる (**合図のみ**)。
   *
   * # 何が通知され、何が通知されないか
   *
   * 通知するのは **この DO を通った打刻**:
   *
   * - WS 経由の打刻 (NFC タイムカード端末) — `handleMeasurement`
   * - ブラウザ (キオスク / 管理画面) の打刻 — `handleTimecardPunch`。
   *   alc-app の server route (`POST /api/timecard/punch`) が RECORDER binding
   *   でここへ回す。**rust-alc-api を直に叩かせない**のは、直行させると
   *   この合図が鳴らないため (Refs ippoan/alc-app-s3#134)
   *
   * 通らないのは `POST /measurements` (Wi-Fi 客の上り) だけ — Worker 側で
   * 処理して DO を経由しない。あちらは打刻端末の経路ではない。
   *
   * **発生源はこの 1 メソッドのまま保つこと。** 呼び出し側を増やすのは
   * 「打刻を作る経路」がここを通るようにする形でだけ行う — 別の場所から
   * 合図を出し始めると、増えるたびに「鳴らない経路」が生まれる。
   *
   * # dev端末 (Refs ippoan/alc-app#387)
   *
   * `dev` は**打刻した側**の区別。同じ側の購読者 (`watchTagFor`) にだけ送る。
   */
  private notifyTimecardPunch(dev: boolean): void {
    for (const ws of this.ctx.getWebSockets(watchTagFor(dev))) {
      this.send(ws, { type: "timecard_punch" });
    }
  }

  /**
   * シリアル OTA の合図 (内部 route `POST /serial-ota`、worker 側で
   * `INTERNAL_SHARED_SECRET` 認証 + target allowlist を検査済み)。
   *
   * **`KIOSK_TAG` の購読者にだけ**送る — device の下り command 経路
   * (`DEVICE_TAG_PREFIX`) にも admin/manager の watcher にも届かない。
   * ユーザー決定により宛先はテナント内の全キオスクへ一斉、結果はサーバに
   * 返さない (送った本数だけ返す。Refs ippoan/alc-app-s3#279)。
   *
   * `device_id` (どの端末を更新するか、Refs ippoan/alc-app#403) が在るときは合図に
   * 載せる。**宛先はここでは絞らない** — 購読の attachment は端末を持たないので、
   * キオスクの側が「自分に繋がっている端末か」を見て実行する。`device_id` が無い
   * 合図は今までどおりの形で、key ごと足さない。
   */
  private async handleSerialOta(request: Request): Promise<Response> {
    let body: { target?: unknown; device_id?: unknown } = {};
    try {
      body = (await request.json()) as { target?: unknown; device_id?: unknown };
    } catch {
      // worker 側で JSON validity は検査済みだが、内部呼び出しの保険として fail-closed
      return json({ error: "invalid_json" }, 400);
    }
    const target = typeof body.target === "string" ? body.target : "";
    const deviceId = body.device_id;
    const sockets = this.ctx.getWebSockets(KIOSK_TAG);
    for (const ws of sockets) {
      this.send(ws, {
        type: "serial_ota",
        target,
        ...(isOtaDeviceId(deviceId) ? { device_id: deviceId } : {}),
      });
    }
    return json({ sent: sockets.length });
  }

  private handleConnect(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const tenantId = request.headers.get("X-Recorder-Tenant-Id") ?? "";
    const deviceId = request.headers.get("X-Recorder-Device-Id") ?? "";
    if (!tenantId || !deviceId) {
      return json({ error: "missing_identity" }, 400);
    }

    // 同一 device の旧接続 (ネットワーク断後のゾンビ) は閉じて置き換える。
    for (const old of this.ctx.getWebSockets(DEVICE_TAG_PREFIX + deviceId)) {
      try {
        old.close(1012, "replaced by new connection");
      } catch {
        // already closed
      }
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [DEVICE_TAG_PREFIX + deviceId]);
    // identity は attachment に載せ、hibernation 復帰後も deserializeAttachment で読む。
    const dev = request.headers.get(RECORDER_DEV_HEADER) === DEV_HEADER_VALUE;
    pair[1].serializeAttachment(buildAttachment(tenantId, deviceId, dev));
    this.send(pair[1], { type: "connected" });
    this.broadcastDevices();

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      this.send(ws, { type: "error", message: "binary_not_supported" });
      return;
    }
    if (message.length > MAX_MESSAGE_BYTES) {
      this.send(ws, { type: "error", message: "message_too_large" });
      return;
    }

    let msg: InboundMessage;
    try {
      msg = JSON.parse(message) as InboundMessage;
    } catch {
      this.send(ws, { type: "error", message: "invalid_json" });
      return;
    }

    const raw = ws.deserializeAttachment() as WsAttachment | null;
    if (!raw?.tenantId || !raw.deviceId) {
      // device 接続なら想定外 (accept 時に必ず載せている)。
      // **購読 (watcher) 接続はここに落ちるのが正しい** — deviceId を持たず、
      // 上りを一切受け付けないため (Refs ippoan/alc-app-s3#134)。
      ws.close(1011, "missing attachment");
      return;
    }
    const attachment: DeviceAttachment = {
      tenantId: raw.tenantId,
      deviceId: raw.deviceId,
      ...(raw.dev === true ? { dev: true as const } : {}),
    };

    switch (msg.type) {
      case "measurement":
        await this.handleMeasurement(ws, attachment, msg);
        return;
      case "command_result":
        await this.handleCommandResult(ws, attachment, msg);
        return;
      case "ping":
        // auto-response (文字列完全一致) に乗らない serialization 向け fallback。
        this.send(ws, { type: "pong" });
        return;
      default:
        this.send(ws, { type: "error", message: "unknown_type" });
    }
  }

  /**
   * 切断の後始末。**`broadcastDevices()` に必ず到達させること**が本体。
   *
   * 相手の close code をそのまま `ws.close()` へ渡すと `1005` / `1006` で
   * 投げる (`closeCodeForEcho` の doc 参照)。丸めたうえで **try/catch でも
   * 囲む** — 将来 workerd が別の code を拒むようになっても、デバイス一覧の
   * 更新だけは落とさない。
   *
   * `console.log` は切断の切り分け用。**サーバが切ったのか回線が切れたのか**は
   * この code / reason でしか分からず、端末側のログは両者を区別せず
   * 「サーバ側から切断」と書く (alc-app-s3 `ws_uplink.rs` の
   * `WebSocketEventType::Disconnected | Close(_) | Closed` が 1 つに潰れる)。
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    console.log(`[ws] close code=${code} clean=${wasClean} reason=${reason}`);
    try {
      ws.close(closeCodeForEcho(code), reason);
    } catch (e) {
      // 閉じ返せなくても一覧の更新は続ける (相手は既に居ない)
      console.log(`[ws] close echo failed code=${code}`, e);
    }
    this.broadcastDevices();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close(1011, "WebSocket error");
  }

  // ── 上り: ブラウザ打刻 → ingest 転送 + 合図 ───────────────────────────────

  /**
   * ブラウザ (キオスク / 管理画面) の打刻 (Refs ippoan/alc-app-s3#134)。
   *
   * 認証は worker 側で完了している (`INTERNAL_SHARED_SECRET` + browser/kiosk JWT
   * の introspect)。identity はヘッダーで受け取り、**body からは読まない**。
   *
   * **DO を経由させるのがこの経路の目的**: ingest 転送のあとに
   * `notifyTimecardPunch()` を呼ぶ 1 か所を、端末の WS 打刻と共有できる。
   *
   * 端末と違って再送の仕組みが無い (ブラウザは応答を見て諦める) ので、
   * seq は冪等キーではなく**衝突しない採番**でよい。`Date.now()` を基準に、
   * 同じミリ秒に 2 件来ても DO 内で単調増加させる
   * (`UNIQUE (tenant_id, device_id, seq)` に当たらないため)。
   */
  private async handleTimecardPunch(request: Request): Promise<Response> {
    const tenantId = request.headers.get("X-Recorder-Tenant-Id") ?? "";
    const deviceId = request.headers.get("X-Recorder-Device-Id") ?? "";
    if (!tenantId || !deviceId) {
      return json({ error: "missing_identity" }, 400);
    }
    // dev端末の打刻か (worker が caller の `X-Device-Dev: 1` から立てる、#387)
    const dev = request.headers.get(RECORDER_DEV_HEADER) === DEV_HEADER_VALUE;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    const built = buildTimecardPunch(body as TimecardPunchInput, this.nextPunchSeq(Date.now()));
    if (!built.ok) {
      return json({ error: built.error }, 400);
    }
    const sharedSecret = await resolveSecret(this.env.INTERNAL_SHARED_SECRET);
    if (!sharedSecret) {
      return json({ error: "server_error" }, 503);
    }
    const result = await forwardMeasurements(
      this.env.AUTH_WORKER,
      sharedSecret,
      tenantId,
      deviceId,
      [built.item],
      dev,
    );
    if (!result.ok) {
      // 詳細 (上流 body) は echo しない。ブラウザは打ち直せる
      return json({ error: result.error }, 502);
    }
    // 合図は backend が受理した後 (WS 経路の ack と同じ順序)
    this.notifyTimecardPunch(dev);
    return json({ seq: built.item.seq }, 202);
  }

  /** ブラウザ打刻の seq を採番する (同ミリ秒でも DO 内で単調増加)。 */
  private nextPunchSeq(nowMs: number): number {
    const seq = Math.max(nowMs, this.lastPunchSeq + 1);
    this.lastPunchSeq = seq;
    return seq;
  }

  // ── 上り: measurement → ingest 転送 ───────────────────────────────────────

  private async handleMeasurement(
    ws: WebSocket,
    attachment: DeviceAttachment,
    msg: InboundMessage,
  ): Promise<void> {
    // 検証 + 転送は POST /measurements (Wi-Fi 客の上り) と共有 (measurements.ts)。
    const parsed = parseMeasurementItem(msg);
    if (!parsed.ok) {
      this.send(
        ws,
        parsed.seq !== undefined
          ? { type: "error", seq: parsed.seq, message: parsed.error }
          : { type: "error", message: parsed.error },
      );
      return;
    }
    const seq = parsed.item.seq;

    // crash_log (CoreS3 の異常リセット復帰レポート、alc-app-s3#43) は backend へ
    // 転送せず R2 へ直接保存して ack する。key は seq ベースで再送冪等
    if (parsed.item.kind === CRASH_LOG_KIND) {
      try {
        await storeCrashLog(
          this.env.CRASH_LOGS,
          attachment.tenantId,
          attachment.deviceId,
          parsed.item,
          Date.now(),
        );
      } catch (e) {
        console.log(
          `[crash_log] R2 put failed tenant=${attachment.tenantId} device=${attachment.deviceId} seq=${seq}`,
          e,
        );
        this.send(ws, { type: "error", seq, message: "storage_error" });
        return;
      }
      this.send(ws, { type: "ack", seq });
      // メール通知は best-effort (ack 済み。失敗は log のみ)
      await notifyCrashByEmail(this.env, attachment.tenantId, attachment.deviceId, parsed.item);
      return;
    }

    const sharedSecret = await resolveSecret(this.env.INTERNAL_SHARED_SECRET);
    if (!sharedSecret) {
      this.send(ws, { type: "error", seq, message: "server_error" });
      return;
    }

    // tenant_id / device_id / dev は WS attachment (= introspect 済み JWT claims) から注入。
    // **frame の中身で dev を決めない** (Refs ippoan/alc-app#387)。
    const dev = attachment.dev === true;
    const result = await forwardMeasurements(
      this.env.AUTH_WORKER,
      sharedSecret,
      attachment.tenantId,
      attachment.deviceId,
      [parsed.item],
      dev,
    );
    if (!result.ok) {
      // 詳細 (body) は response に echo しない。status のみ端末へ返し log に残す。
      this.send(ws, { type: "error", seq, message: result.error });
      return;
    }
    this.send(ws, { type: "ack", seq });
    // 打刻だけ購読者へ合図を出す (ack の後 = backend が受理した後)
    if (parsed.item.kind === TIMECARD_KIND) {
      this.notifyTimecardPunch(dev);
    }
  }

  // ── 上り: command_result → storage 保存 ───────────────────────────────────

  private async handleCommandResult(
    ws: WebSocket,
    attachment: DeviceAttachment,
    msg: InboundMessage,
  ): Promise<void> {
    const id = typeof msg.id === "string" ? msg.id : "";
    if (!id || id.length > 128) {
      this.send(ws, { type: "error", message: "invalid_command_id" });
      return;
    }
    const now = Date.now();
    await this.pruneExpired<{ received_at_ms?: number }>(
      CMD_RESULT_PREFIX,
      CMD_RESULT_TTL_MS,
      "received_at_ms",
      now,
    );
    await this.ctx.storage.put(CMD_RESULT_PREFIX + id, {
      device_id: attachment.deviceId,
      received_at_ms: now,
      payload: msg.payload ?? null,
    });
  }

  /**
   * `prefix` の記録のうち TTL を過ぎたものを掃除し、残ったものを返す
   * (書き込みのたびに実行、件数は小さい)。command_result と更新の報告で共用する。
   * `stampKey` は保存した時刻 (ms) を持つ欄の名前。
   */
  private async pruneExpired<T>(
    prefix: string,
    ttlMs: number,
    stampKey: keyof T & string,
    now: number,
  ): Promise<Map<string, T>> {
    const entries = await this.ctx.storage.list<T>({ prefix });
    const kept = new Map<string, T>();
    const stale: string[] = [];
    for (const [key, value] of entries) {
      if (isExpired(value, stampKey, ttlMs, now)) stale.push(key);
      else kept.set(key, value);
    }
    await this.deleteKeys(stale);
    return kept;
  }

  /** storage の key をまとめて消す (1 回の上限ごとに分ける)。 */
  private async deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += STORAGE_DELETE_BATCH) {
      await this.ctx.storage.delete(keys.slice(i, i + STORAGE_DELETE_BATCH));
    }
  }

  // ── ファームの更新の状態 (内部 HTTP API、Refs ippoan/alc-app#403) ──────────

  /**
   * キオスクからの報告 (繋いでいる端末の版・更新の状態) を保存する。
   *
   * 認証は worker 側で完了している (`INTERNAL_SHARED_SECRET`)。呼び手 (alc-app の
   * server route) が検査済みの値を送ってくるが、ここでも形を検査する。
   *
   * **DO storage に置く** — メモリの状態は hibernation で消える。端末ごとに 1 件
   * (同じ `device_id` は上書き) で、履歴は持たない。
   */
  private async handleOtaReport(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const parsed = parseOtaReport(body);
    if (!parsed.ok) {
      return json({ error: parsed.error }, 400);
    }
    const now = Date.now();
    const key = OTA_STATE_PREFIX + parsed.report.device_id;
    const kept = await this.pruneExpired<OtaState>(
      OTA_STATE_PREFIX,
      OTA_STATE_TTL_MS,
      "reported_at_ms",
      now,
    );
    // 上限を超える書き込みは、いちばん古い報告を消してから入れる (上書きは件数が増えない)
    if (!kept.has(key) && kept.size >= OTA_STATE_MAX) {
      const oldest = [...kept]
        .sort(([, a], [, b]) => a.reported_at_ms - b.reported_at_ms)
        .slice(0, kept.size - OTA_STATE_MAX + 1)
        .map(([k]) => k);
      await this.deleteKeys(oldest);
    }
    const state: OtaState = { ...parsed.report, reported_at_ms: now };
    await this.ctx.storage.put(key, state);
    return json({ ok: true });
  }

  /** 保存した報告の一覧 (TTL 内のものだけ、`reported_at_ms` の新しい順)。 */
  private async handleOtaStatus(): Promise<Response> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<OtaState>({ prefix: OTA_STATE_PREFIX });
    const devices = [...entries.values()]
      .filter((state) => !isExpired(state, "reported_at_ms", OTA_STATE_TTL_MS, now))
      .sort(
        (a, b) =>
          b.reported_at_ms - a.reported_at_ms || (a.device_id < b.device_id ? -1 : 1),
      );
    return json({ devices });
  }

  // ── 下り: command push (内部 HTTP API) ────────────────────────────────────

  private async handleCommand(request: Request): Promise<Response> {
    const deviceId = request.headers.get("X-Recorder-Device-Id") ?? "";
    if (!deviceId) return json({ error: "missing_device_id" }, 400);

    let body: { id?: unknown; payload?: unknown } = {};
    try {
      body = (await request.json()) as { id?: unknown; payload?: unknown };
    } catch {
      // body なしは payload:null の command として扱う
    }
    const sockets = this.ctx.getWebSockets(DEVICE_TAG_PREFIX + deviceId);
    if (sockets.length === 0) {
      return json({ error: "device_not_connected" }, 404);
    }
    const id =
      typeof body.id === "string" && body.id && body.id.length <= 128
        ? body.id
        : crypto.randomUUID();
    const frame = { type: "command", id, payload: body.payload ?? null };
    for (const ws of sockets) {
      this.send(ws, frame);
    }
    return json({ id, delivered: sockets.length }, 202);
  }

  private currentDeviceIds(): string[] {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as WsAttachment | null;
      if (attachment?.deviceId) ids.add(attachment.deviceId);
    }
    return [...ids].sort();
  }

  private handleDevices(): Response {
    return json({ devices: this.currentDeviceIds() });
  }

  /** GET /events — 接続中デバイス一覧の変化を push する SSE ストリーム。 */
  private handleEvents(): Response {
    const encoder = new TextEncoder();
    const hub = this;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        hub.sseControllers.add(controller);
        // 接続直後に現在のスナップショットを送る (browser 側の初期表示用)。
        controller.enqueue(
          encoder.encode(`event: devices\ndata: ${JSON.stringify({ devices: hub.currentDeviceIds() })}\n\n`),
        );
      },
      cancel() {
        if (controllerRef) hub.sseControllers.delete(controllerRef);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      },
    });
  }

  /** 接続中デバイス一覧を全 SSE クライアントへ push する (接続/切断のたびに呼ぶ)。 */
  private broadcastDevices(): void {
    if (this.sseControllers.size === 0) return;
    const encoder = new TextEncoder();
    const frame = encoder.encode(
      `event: devices\ndata: ${JSON.stringify({ devices: this.currentDeviceIds() })}\n\n`,
    );
    for (const controller of this.sseControllers) {
      try {
        controller.enqueue(frame);
      } catch {
        this.sseControllers.delete(controller);
      }
    }
  }

  private async handleCommandResultGet(id: string): Promise<Response> {
    const stored = await this.ctx.storage.get(CMD_RESULT_PREFIX + id);
    if (!stored) return json({ error: "not_found" }, 404);
    return json(stored);
  }

  private send(ws: WebSocket, message: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // WebSocket already closed
    }
  }
}
