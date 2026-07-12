import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { resolveSecret } from "./auth";

/**
 * RecorderHub — テナント単位の Durable Object (Hibernatable WebSockets)。
 *
 * 上り (CoreS3 → server):
 *   - `{ type: "measurement", seq, recorded_at_ms?, kind?, payload }`
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
 */

/** WS attachment。hibernation を跨いで identity を保持する。 */
interface WsAttachment {
  tenantId: string;
  deviceId: string;
}

/** 上りメッセージ (JSON parse 後、field は全て untrusted)。 */
interface InboundMessage {
  type?: unknown;
  seq?: unknown;
  recorded_at_ms?: unknown;
  kind?: unknown;
  payload?: unknown;
  id?: unknown;
}

/** getWebSockets の device 絞り込み用 tag。 */
const DEVICE_TAG_PREFIX = "device:";

/** command_result の storage key prefix。 */
const CMD_RESULT_PREFIX = "cmdres:";

/** command_result の保持期間 (この時間を過ぎたら次の書き込み時に prune)。 */
const CMD_RESULT_TTL_MS = 10 * 60 * 1000;

/** 上り 1 メッセージの上限 (これ以上は parse せず reject)。 */
const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * service binding fetch は host を無視するが、path が auth-worker 側 route
 * (`/alc-internal-proxy/...`) と一致する必要がある (web/server/utils/internal-proxy.ts と同形)。
 */
const INGEST_URL =
  "https://alc-internal-proxy.internal/alc-internal-proxy/api/hub/measurements";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export class RecorderHub extends DurableObject<Env> {
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
    if (url.pathname === "/command" && request.method === "POST") {
      return this.handleCommand(request);
    }
    if (url.pathname === "/devices" && request.method === "GET") {
      return this.handleDevices();
    }
    const resultMatch = url.pathname.match(/^\/command-result\/([^/]+)$/);
    if (resultMatch && request.method === "GET") {
      return this.handleCommandResultGet(decodeURIComponent(resultMatch[1]));
    }
    return json({ error: "not_found" }, 404);
  }

  // ── WS 受口 ────────────────────────────────────────────────────────────────

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
    const seq = msg.seq;
    if (typeof seq !== "number" || !Number.isFinite(seq)) {
      this.send(ws, { type: "error", message: "invalid_seq" });
      return;
    }
    const payload =
      msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)
        ? (msg.payload as Record<string, unknown>)
        : null;
    if (!payload) {
      this.send(ws, { type: "error", seq, message: "invalid_payload" });
      return;
    }
    // kind はトップレベル優先、無ければ ble-medical-gateway 互換 JSON の `type` に
    // fallback (temperature / blood_pressure / alcohol / fc1200_raw)。enum 検証は
    // rust 側 (source of truth) に任せ、ここでは空でないことだけ確認する。
    const kind =
      typeof msg.kind === "string" && msg.kind
        ? msg.kind
        : typeof payload.type === "string" && payload.type
          ? payload.type
          : "";
    if (!kind) {
      this.send(ws, { type: "error", seq, message: "missing_kind" });
      return;
    }
    const recordedAtMs =
      typeof msg.recorded_at_ms === "number" && Number.isFinite(msg.recorded_at_ms)
        ? msg.recorded_at_ms
        : null;

    const sharedSecret = await resolveSecret(this.env.INTERNAL_SHARED_SECRET);
    if (!sharedSecret) {
      this.send(ws, { type: "error", seq, message: "server_error" });
      return;
    }

    // tenant_id は X-Tenant-ID ヘッダー、device_id は item に注入 — どちらも
    // introspect 済み JWT claims 由来 (ペイロード内の同名 field は使わない)。
    const item = {
      device_id: attachment.deviceId,
      kind,
      seq,
      recorded_at_ms: recordedAtMs,
      payload,
    };
    let res: Response;
    try {
      res = await this.env.AUTH_WORKER.fetch(INGEST_URL, {
        method: "POST",
        headers: {
          "X-Alc-Proxy-Secret": sharedSecret,
          "X-Tenant-ID": attachment.tenantId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([item]),
      });
    } catch (e) {
      console.log(
        `[measurement] upstream unreachable tenant=${attachment.tenantId} device=${attachment.deviceId} seq=${seq}`,
        e,
      );
      this.send(ws, { type: "error", seq, message: "upstream_unreachable" });
      return;
    }
    if (!res.ok) {
      // 詳細 (body) は response に echo しない。status のみ端末へ返し log に残す。
      console.log(
        `[measurement] upstream ${res.status} tenant=${attachment.tenantId} device=${attachment.deviceId} seq=${seq}`,
      );
      this.send(ws, { type: "error", seq, message: `upstream_${res.status}` });
      return;
    }
    this.send(ws, { type: "ack", seq });
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

  private handleDevices(): Response {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as WsAttachment | null;
      if (attachment?.deviceId) ids.add(attachment.deviceId);
    }
    return json({ devices: [...ids].sort() });
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
