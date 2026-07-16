/**
 * auth-worker のテストダブル (auxiliary worker)。
 *
 * - `POST /auth/introspect` … 固定 token 表で introspect 応答を返す。
 *   実物と同じく `Authorization: <shared secret>` (生の値) を要求する。
 * - `POST /alc-internal-proxy/api/hub/measurements` … ingest 転送のモック。
 *   `X-Alc-Proxy-Secret` を検証し、受けた body / X-Tenant-ID を記録する。
 *   item の kind に "boom" が含まれると 500 を返す (上流失敗の再現用)。
 * - `GET /internal/hub-devices` … battery cron 用 hub device 一覧のモック。
 *   `Authorization: <shared secret>` を要求。`POST /__spy/hub-devices` で
 *   テストから内容を差し替えられる (既定は空配列)。
 * - `GET /__spy/ingest` / `POST /__spy/reset` … テストからの観測用。
 */

const SHARED_SECRET = "test-shared-secret";

const TOKENS = {
  "hub-token-1": {
    active: true,
    tenant_id: "tenant-1",
    role: "device-hub",
    sub: "device-1",
    email: "",
    exp: 9999999999,
  },
  "hub-token-2": {
    active: true,
    tenant_id: "tenant-1",
    role: "device-hub",
    sub: "device-2",
    email: "",
    exp: 9999999999,
  },
  "hub-token-tenant-cmd": {
    active: true,
    tenant_id: "tenant-cmd",
    role: "device-hub",
    sub: "device-cmd",
    email: "",
    exp: 9999999999,
  },
  "hub-token-tenant-sse": {
    active: true,
    tenant_id: "tenant-sse",
    role: "device-hub",
    sub: "device-sse",
    email: "",
    exp: 9999999999,
  },
  "kiosk-token": {
    active: true,
    tenant_id: "tenant-1",
    role: "device-kiosk",
    sub: "device-kiosk-1",
    email: "",
    exp: 9999999999,
  },
  // 期限切れ / 署名不正 / ACL 不許可テナントは実物では区別なく active:false になる。
  "expired-token": { active: false },
};

let ingestCalls = [];
let hubDevices = [];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/auth/introspect" && request.method === "POST") {
      if (request.headers.get("Authorization") !== SHARED_SECRET) {
        return json({ error: "unauthorized" }, 401);
      }
      let body = {};
      try {
        body = await request.json();
      } catch {
        return json({ active: false });
      }
      // 実物同様 origin 必須 (欠落は fail-closed)。
      if (typeof body.origin !== "string" || !body.origin) {
        return json({ active: false });
      }
      return json(TOKENS[body.token] ?? { active: false });
    }

    if (
      url.pathname === "/alc-internal-proxy/api/hub/measurements" &&
      request.method === "POST"
    ) {
      if (request.headers.get("X-Alc-Proxy-Secret") !== SHARED_SECRET) {
        return json({ error: "unauthorized" }, 401);
      }
      const items = await request.json();
      ingestCalls.push({
        tenantId: request.headers.get("X-Tenant-ID"),
        items,
      });
      if (Array.isArray(items) && items.some((i) => i.kind === "boom")) {
        return json({ error: "boom" }, 500);
      }
      return json({ inserted: Array.isArray(items) ? items.length : 0 });
    }

    if (url.pathname === "/internal/hub-devices" && request.method === "GET") {
      if (request.headers.get("Authorization") !== SHARED_SECRET) {
        return json({ error: "unauthorized" }, 401);
      }
      return json({ devices: hubDevices });
    }

    if (url.pathname === "/__spy/ingest" && request.method === "GET") {
      return json(ingestCalls);
    }
    if (url.pathname === "/__spy/reset" && request.method === "POST") {
      ingestCalls = [];
      hubDevices = [];
      return json({ ok: true });
    }
    if (url.pathname === "/__spy/hub-devices" && request.method === "POST") {
      hubDevices = await request.json();
      return json({ ok: true });
    }

    return json({ error: "not_found" }, 404);
  },
};
