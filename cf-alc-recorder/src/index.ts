/**
 * cf-alc-recorder — CoreS3 (alc-app-s3) 測定データの WebSocket 受口 Worker
 * (Refs ippoan/alc-app#106)。
 *
 * 経路: CoreS3 →(WSS + device JWT)→ 本 Worker →(AUTH_WORKER service binding)→
 *       auth-worker /alc-internal-proxy → rust-alc-api POST /api/hub/measurements
 *
 * endpoint:
 *   - GET  /health                                     … 死活
 *   - GET  /ws                                         … WS 受口 (Upgrade 必須)。
 *       `Authorization: Bearer <device JWT>` を auth-worker /auth/introspect で検証し、
 *       role=device-hub のみ accept → テナント単位の RecorderHub DO へ routing。
 *   - POST /measurements                                … Wi-Fi 客の上りバッチ (#109)。
 *       認証は /ws と同じ device JWT introspect。body は measurement の配列
 *       (WS measurement frame と同形)。下りが無いためステートレス (DO 不要、Worker 直)。
 *   - POST /tenants/:tenantId/devices/:deviceId/command … 接続中デバイスへの下り push
 *   - GET  /tenants/:tenantId/devices                   … 接続中デバイス一覧 (debug)
 *   - GET  /tenants/:tenantId/commands/:id/result       … command_result の取得
 *     (下り 3 endpoint は `Authorization: <INTERNAL_SHARED_SECRET>` の内部 API。
 *      auth-worker /auth/introspect と同じ server-to-server shared secret 認証)
 */
import {
  bearerToken,
  constantTimeEquals,
  decideRecorderAuth,
  introspectToken,
  resolveSecret,
} from "./auth";
import {
  forwardMeasurements,
  parseMeasurementItem,
  type MeasurementInput,
  type ParsedMeasurement,
} from "./measurements";

export { RecorderHub } from "./recorder-hub";

export interface Env {
  RECORDER_HUB: DurableObjectNamespace;
  AUTH_WORKER: Fetcher;
  /** CF Secrets Store binding (`.get()`)。テストでは文字列で注入する。 */
  INTERNAL_SHARED_SECRET: unknown;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** テナント単位の DO stub を引く。 */
function hubStub(env: Env, tenantId: string): DurableObjectStub {
  return env.RECORDER_HUB.get(env.RECORDER_HUB.idFromName(tenantId));
}

/**
 * 下り HTTP API の認証。`Authorization: <INTERNAL_SHARED_SECRET>` (生の値) を
 * 定数時間比較する。認証 NG なら Response、OK なら null を返す。
 */
async function requireInternalAuth(request: Request, env: Env): Promise<Response | null> {
  const secret = await resolveSecret(env.INTERNAL_SHARED_SECRET);
  if (!secret) return json({ error: "server_error" }, 503);
  const authz = request.headers.get("Authorization") ?? "";
  if (!authz || !constantTimeEquals(authz, secret)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

/** device JWT introspect の成功時 identity (+ 転送で再利用する shared secret)。 */
interface DeviceAuth {
  tenantId: string;
  deviceId: string;
  sharedSecret: string;
}

/**
 * device JWT (Bearer) の認証 — /ws と /measurements の共通部。
 * introspect → role/tenant 判定。NG 時はそのまま返せる Response を返す。
 */
async function authenticateDevice(
  request: Request,
  env: Env,
  origin: string,
): Promise<DeviceAuth | Response> {
  const token = bearerToken(request.headers.get("Authorization"));
  if (!token) {
    return json({ error: "missing_bearer_token" }, 401);
  }
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET);
  if (!sharedSecret) {
    return json({ error: "server_error" }, 503);
  }
  // origin は APP_TENANT_ACL の per-app 判定に使われる (auth-worker 側で allowlist)。
  const result = await introspectToken(env.AUTH_WORKER, sharedSecret, token, origin);
  if (result === null) {
    // introspect 自体が失敗 (binding 未設定 / shared secret 不一致 / 5xx)。
    return json({ error: "server_error" }, 503);
  }
  const decision = decideRecorderAuth(result);
  if (decision.status !== 101) {
    return json({ error: decision.status === 403 ? "forbidden_role" : "invalid_token" }, decision.status);
  }
  return { tenantId: decision.tenantId, deviceId: decision.deviceId, sharedSecret };
}

/** WS ハンドシェイク: introspect → role/tenant 判定 → DO routing。 */
async function handleWebSocket(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket. Use GET /ws with Upgrade header", {
      status: 426,
    });
  }
  const auth = await authenticateDevice(request, env, url.origin);
  if (auth instanceof Response) return auth;

  // identity は introspect 済み claims から内部ヘッダーで DO に渡す (client 由来の
  // 同名ヘッダーが混ざらないよう必ず上書きする)。
  const fwd = new Request("https://recorder-hub.internal/connect", request);
  fwd.headers.set("X-Recorder-Tenant-Id", auth.tenantId);
  fwd.headers.set("X-Recorder-Device-Id", auth.deviceId);
  return hubStub(env, auth.tenantId).fetch(fwd);
}

/** POST /measurements 1 リクエストの item 数上限 (WS の 64KB message 上限に相当する暴走ガード)。 */
const MAX_BATCH_ITEMS = 100;

/**
 * POST /measurements — Wi-Fi 客の上りバッチ (Refs ippoan/alc-app#109)。
 *
 * 1 件でも不正な item があれば batch ごと 400 で reject する (端末は同じ batch を
 * 再送する。同 seq 再送は rust 側 `UNIQUE (tenant, device, seq)` が冪等に吸収)。
 * 成功時は受理した seq の一覧を返す (デバイスの ack 消し込み用)。
 */
async function handleMeasurementsPost(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = await authenticateDevice(request, env, url.origin);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!Array.isArray(body)) {
    return json({ error: "invalid_body" }, 400);
  }
  if (body.length > MAX_BATCH_ITEMS) {
    return json({ error: "too_many_items" }, 400);
  }

  const items: ParsedMeasurement[] = [];
  for (let i = 0; i < body.length; i++) {
    const entry: unknown = body[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return json({ error: "invalid_item", index: i }, 400);
    }
    const parsed = parseMeasurementItem(entry as MeasurementInput);
    if (!parsed.ok) {
      return json({ error: parsed.error, index: i }, 400);
    }
    items.push(parsed.item);
  }
  if (items.length === 0) {
    // 空バッチは上流を叩かず即 accept (デバイス側の送信キュー空振り)。
    return json({ accepted: [] });
  }

  const result = await forwardMeasurements(
    env.AUTH_WORKER,
    auth.sharedSecret,
    auth.tenantId,
    auth.deviceId,
    items,
  );
  if (!result.ok) {
    // 詳細 (上流 body) は echo しない。端末は同じ batch を再送できる。
    return json({ error: result.error }, 502);
  }
  return json({ accepted: items.map((item) => item.seq) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    if (url.pathname === "/ws") {
      return handleWebSocket(request, env, url);
    }

    if (url.pathname === "/measurements" && request.method === "POST") {
      return handleMeasurementsPost(request, env, url);
    }

    // ── 下り: 内部 HTTP API (shared secret 認証) ────────────────────────────
    const commandMatch = url.pathname.match(/^\/tenants\/([^/]+)\/devices\/([^/]+)\/command$/);
    if (commandMatch && request.method === "POST") {
      const denied = await requireInternalAuth(request, env);
      if (denied) return denied;
      const fwd = new Request("https://recorder-hub.internal/command", {
        method: "POST",
        headers: {
          "X-Recorder-Device-Id": decodeURIComponent(commandMatch[2]),
          "Content-Type": request.headers.get("Content-Type") ?? "application/json",
        },
        body: request.body,
      });
      return hubStub(env, decodeURIComponent(commandMatch[1])).fetch(fwd);
    }

    const devicesMatch = url.pathname.match(/^\/tenants\/([^/]+)\/devices$/);
    if (devicesMatch && request.method === "GET") {
      const denied = await requireInternalAuth(request, env);
      if (denied) return denied;
      return hubStub(env, decodeURIComponent(devicesMatch[1])).fetch(
        "https://recorder-hub.internal/devices",
      );
    }

    const resultMatch = url.pathname.match(/^\/tenants\/([^/]+)\/commands\/([^/]+)\/result$/);
    if (resultMatch && request.method === "GET") {
      const denied = await requireInternalAuth(request, env);
      if (denied) return denied;
      return hubStub(env, decodeURIComponent(resultMatch[1])).fetch(
        `https://recorder-hub.internal/command-result/${resultMatch[2]}`,
      );
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
