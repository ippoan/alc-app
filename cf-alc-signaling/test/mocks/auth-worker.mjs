/**
 * auth-worker のテストダブル (auxiliary worker)。
 *
 * `POST /auth/introspect` … 固定 token 表で introspect 応答を返す。
 * 実物と同じく `Authorization: <shared secret>` (生の値) を要求する。
 * 表に無い token は `{ active: false }` (期限切れ / 署名不正と同じ応答)。
 * token "boom" は 500 (introspect そのものの失敗の再現用)。
 */

const SHARED_SECRET = "test-shared-secret";

const TOKENS = {
  // dev端末の鍵 (dev_device claim あり)
  "dev-token": { active: true, tenant_id: "tenant-1", role: "admin", sub: "dev-1", dev_device: true },
  // 本番の鍵 (claim が無い = 応答に dev_device が載らない)
  "prod-token": { active: true, tenant_id: "tenant-1", role: "admin", sub: "prod-1" },
  // dev_device が true 以外の値 (文字列) — dev として扱ってはいけない
  "truthy-token": { active: true, tenant_id: "tenant-1", role: "admin", sub: "t-1", dev_device: "true" },
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/auth/introspect") {
      if (request.headers.get("Authorization") !== SHARED_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const { token } = await request.json();
      if (token === "boom") return new Response("boom", { status: 500 });
      return Response.json(TOKENS[token] ?? { active: false });
    }
    return new Response("not found", { status: 404 });
  },
};
