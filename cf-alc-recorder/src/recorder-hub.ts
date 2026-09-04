import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { resolveSecret } from "./auth";
import {
  CRASH_LOG_KIND,
  forwardMeasurements,
  notifyCrashByEmail,
  parseMeasurementItem,
  storeCrashLog,
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
 * 下り (server → CoreS3、issue #106 設計レビュー決定):
 *   - `POST /command` (worker の内部 HTTP API から) → 接続中デバイスへ
 *     `{ type: "command", id, payload }` を push。
 *
 * Hibernation 復帰: 接続 identity は in-memory に持たず、毎メッセージ
 * `ws.deserializeAttachment()` から読む (= 復帰後も転送先 tenant/device が壊れない)。
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
}

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
 * 購読 WS のサブプロトコル名。ブラウザは `["alc.timecard.v1", "<jwt>"]` を送り、
 * サーバはこちらだけを echo し返す (トークンを応答ヘッダーに乗せない)。
 */
export const WATCH_SUBPROTOCOL = "alc.timecard.v1";

/** 打刻更新の合図。**行の中身は送らない** — ブラウザが API を引き直す。
 * 行の形 (区分 / card_id / 社員解決の凍結 / JST 境界) は rust-alc-api 側に
 * 作り込んであり、Worker に 2 実装目を作ると必ずズレるため。 */
const TIMECARD_KIND = "timecard";

/** command_result の storage key prefix。 */
const CMD_RESULT_PREFIX = "cmdres:";

/** command_result の保持期間 (この時間を過ぎたら次の書き込み時に prune)。 */
const CMD_RESULT_TTL_MS = 10 * 60 * 1000;

/** 上り 1 メッセージの上限 (これ以上は parse せず reject)。 */
const MAX_MESSAGE_BYTES = 64 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export class RecorderHub extends DurableObject<Env> {
  /** 接続中の SSE クライアント (`/events`)。DO storage には持たない (in-memory のみ)。 */
  private readonly sseControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();

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
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      return this.handleConnect(request);
    }
    if (url.pathname === "/watch") {
      return this.handleWatch(request);
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
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [WATCH_TAG]);
    pair[1].serializeAttachment({ tenantId } satisfies WsAttachment);
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
   * 通知するのは **WS 経由の打刻 (NFC タイムカード端末)** だけ。次の 2 つは
   * この DO を通らないので通知されない:
   *
   * - **ブラウザ版の打刻** (`POST /api/timecard/punch`) — rust-alc-api へ直行する。
   *   ただし打った本人の画面は応答でその場更新するので、体感上の問題は
   *   「他の画面に即時反映されない」だけ
   * - `POST /measurements` (Wi-Fi 客の上り) — Worker 側で処理し DO を経由しない
   *
   * 常設の打刻端末が主用途なので、まずここだけを覆う。広げるなら
   * **通知の発生源を増やすのではなく**、rust-alc-api 側から 1 か所で出す形を
   * 検討すること (発生源が増えるほど「鳴らない経路」が生まれる)。
   */
  private notifyTimecardPunch(): void {
    for (const ws of this.ctx.getWebSockets(WATCH_TAG)) {
      this.send(ws, { type: "timecard_punch" });
    }
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
    const attachment: WsAttachment = { tenantId, deviceId };
    pair[1].serializeAttachment(attachment);
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

    const attachment = ws.deserializeAttachment() as WsAttachment | null;
    if (!attachment?.tenantId || !attachment?.deviceId) {
      // 想定外 (accept 時に必ず載せている)。identity 不明のまま ingest しない。
      ws.close(1011, "missing attachment");
      return;
    }

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

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    ws.close(code, reason);
    this.broadcastDevices();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close(1011, "WebSocket error");
  }

  // ── 上り: measurement → ingest 転送 ───────────────────────────────────────

  private async handleMeasurement(
    ws: WebSocket,
    attachment: WsAttachment,
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

    // tenant_id / device_id は WS attachment (= introspect 済み JWT claims) から注入。
    const result = await forwardMeasurements(
      this.env.AUTH_WORKER,
      sharedSecret,
      attachment.tenantId,
      attachment.deviceId,
      [parsed.item],
    );
    if (!result.ok) {
      // 詳細 (body) は response に echo しない。status のみ端末へ返し log に残す。
      this.send(ws, { type: "error", seq, message: result.error });
      return;
    }
    this.send(ws, { type: "ack", seq });
    // 打刻だけ購読者へ合図を出す (ack の後 = backend が受理した後)
    if (parsed.item.kind === TIMECARD_KIND) {
      this.notifyTimecardPunch();
    }
  }

  // ── 上り: command_result → storage 保存 ───────────────────────────────────

  private async handleCommandResult(
    ws: WebSocket,
    attachment: WsAttachment,
    msg: InboundMessage,
  ): Promise<void> {
    const id = typeof msg.id === "string" ? msg.id : "";
    if (!id || id.length > 128) {
      this.send(ws, { type: "error", message: "invalid_command_id" });
      return;
    }
    const now = Date.now();
    await this.pruneCommandResults(now);
    await this.ctx.storage.put(CMD_RESULT_PREFIX + id, {
      device_id: attachment.deviceId,
      received_at_ms: now,
      payload: msg.payload ?? null,
    });
  }

  /** TTL を過ぎた command_result を掃除する (書き込みのたびに実行、件数は小さい)。 */
  private async pruneCommandResults(now: number): Promise<void> {
    const entries = await this.ctx.storage.list<{ received_at_ms?: number }>({
      prefix: CMD_RESULT_PREFIX,
    });
    const stale: string[] = [];
    for (const [key, value] of entries) {
      if (!value?.received_at_ms || now - value.received_at_ms > CMD_RESULT_TTL_MS) {
        stale.push(key);
      }
    }
    if (stale.length > 0) await this.ctx.storage.delete(stale);
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
