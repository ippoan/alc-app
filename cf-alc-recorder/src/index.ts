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

/** WS ハンドシェイク: introspect → role/tenant 判定 → DO routing。 */
async function handleWebSocket(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket. Use GET /ws with Upgrade header", {
      status: 426,
    });
  }
  const token = bearerToken(request.headers.get("Authorization"));
  if (!token) {
    return json({ error: "missing_bearer_token" }, 401);
  }
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET);
  if (!sharedSecret) {
    return json({ error: "server_error" }, 503);
  }
  // origin は APP_TENANT_ACL の per-app 判定に使われる (auth-worker 側で allowlist)。
  const result = await introspectToken(env.AUTH_WORKER, sharedSecret, token, url.origin);
  if (result === null) {
    // introspect 自体が失敗 (binding 未設定 / shared secret 不一致 / 5xx)。
    return json({ error: "server_error" }, 503);
  }
  const decision = decideRecorderAuth(result);
  if (decision.status !== 101) {
    return json({ error: decision.status === 403 ? "forbidden_role" : "invalid_token" }, decision.status);
  }

  // identity は introspect 済み claims から内部ヘッダーで DO に渡す (client 由来の
  // 同名ヘッダーが混ざらないよう必ず上書きする)。
  const fwd = new Request("https://recorder-hub.internal/connect", request);
  fwd.headers.set("X-Recorder-Tenant-Id", decision.tenantId);
  fwd.headers.set("X-Recorder-Device-Id", decision.deviceId);
  return hubStub(env, decision.tenantId).fetch(fwd);
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
