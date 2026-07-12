import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/index";
import { decideRecorderAuth } from "../src/auth";

const BASE = "https://alc-recorder.test";
const SHARED_SECRET = "test-shared-secret";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** WS 接続を張る (Authorization は Bearer <token>)。 */
async function connect(token?: string): Promise<{ res: Response; ws: WebSocket | null }> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await SELF.fetch(`${BASE}/ws`, { headers });
  return { res, ws: res.webSocket ?? null };
}

/** 受信メッセージをキューイングして順番に await できるようにする。 */
function messageQueue(ws: WebSocket) {
  const queue: unknown[] = [];
  const waiters: Array<(v: unknown) => void> = [];
  ws.addEventListener("message", (event) => {
    const parsed: unknown = JSON.parse((event as MessageEvent).data as string);
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queue.push(parsed);
  });
  ws.accept();
  return {
    next(timeoutMs = 3000): Promise<unknown> {
      const head = queue.shift();
      if (head !== undefined) return Promise.resolve(head);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timeout waiting for ws message")),
          timeoutMs,
        );
        waiters.push((v) => {
          clearTimeout(timer);
          resolve(v);
        });
      });
    },
  };
}

/** 接続 + `connected` 受信までを行うヘルパー。 */
async function connectAccepted(token: string) {
  const { res, ws } = await connect(token);
  expect(res.status).toBe(101);
  expect(ws).not.toBeNull();
  const messages = messageQueue(ws!);
  expect(await messages.next()).toEqual({ type: "connected" });
  return { ws: ws!, messages };
}

async function spyIngest(): Promise<Array<{ tenantId: string; items: Array<Record<string, unknown>> }>> {
  const res = await env.AUTH_WORKER.fetch("https://auth-worker.internal/__spy/ingest");
  return (await res.json()) as Array<{ tenantId: string; items: Array<Record<string, unknown>> }>;
}

const openSockets: WebSocket[] = [];

beforeEach(async () => {
  await env.AUTH_WORKER.fetch("https://auth-worker.internal/__spy/reset", { method: "POST" });
});

afterEach(() => {
  for (const ws of openSockets.splice(0)) {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
});

describe("ハンドシェイク認証 (introspect)", () => {
  it("GET /health は ok", async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("Upgrade ヘッダーなしは 426", async () => {
    const res = await SELF.fetch(`${BASE}/ws`);
    expect(res.status).toBe(426);
  });

  it("Bearer なしは 401", async () => {
    const { res } = await connect();
    expect(res.status).toBe(401);
  });

  it("期限切れ / 署名不正 / 他アプリ不許可テナント (active:false) は 401", async () => {
    const { res } = await connect("expired-token");
    expect(res.status).toBe(401);
  });

  it("device-hub 以外の role (kiosk) は 403", async () => {
    const { res } = await connect("kiosk-token");
    expect(res.status).toBe(403);
  });

  it("device-hub role の有効 JWT は 101 で accept され connected が届く", async () => {
    const { ws } = await connectAccepted("hub-token-1");
    openSockets.push(ws);
  });

  it("decideRecorderAuth: tenant_id / sub 欠落は 401 (fail-closed)", () => {
    expect(
      decideRecorderAuth({ active: true, role: "device-hub", sub: "d" }).status,
    ).toBe(401);
    expect(
      decideRecorderAuth({ active: true, role: "device-hub", tenant_id: "t" }).status,
    ).toBe(401);
    expect(decideRecorderAuth(null).status).toBe(401);
  });
});

describe("measurement → ingest 転送 → ack", () => {
  it("measurement を forward し ack を返す。tenant/device は JWT claims から注入", async () => {
    const { ws, messages } = await connectAccepted("hub-token-1");
    openSockets.push(ws);

    ws.send(
      JSON.stringify({
        type: "measurement",
        seq: 1,
        recorded_at_ms: 1752300000000,
        payload: {
          type: "temperature",
          value: 36.5,
          unit: "celsius",
          // ペイロード側の識別子は無視される (詐称不可) ことを後段で確認する
          device_id: "spoofed-device",
          tenant_id: "spoofed-tenant",
        },
      }),
    );
    expect(await messages.next()).toEqual({ type: "ack", seq: 1 });

    const calls = await spyIngest();
    expect(calls.length).toBe(1);
    // X-Tenant-ID は introspect 済み JWT の tenant_id
    expect(calls[0].tenantId).toBe("tenant-1");
    const item = calls[0].items[0];
    // device_id / kind / seq / recorded_at_ms はトップレベルに注入 (device_id は JWT の sub)
    expect(item.device_id).toBe("device-1");
    expect(item.kind).toBe("temperature");
    expect(item.seq).toBe(1);
    expect(item.recorded_at_ms).toBe(1752300000000);
    expect((item.payload as Record<string, unknown>).value).toBe(36.5);
  });

  it("同じ seq の再送も ack される (重複排除は rust 側 UNIQUE で冪等)", async () => {
    const { ws, messages } = await connectAccepted("hub-token-1");
    openSockets.push(ws);

    const frame = JSON.stringify({
      type: "measurement",
      seq: 7,
      kind: "alcohol",
      payload: { value: 0.0 },
    });
    ws.send(frame);
    expect(await messages.next()).toEqual({ type: "ack", seq: 7 });
    ws.send(frame);
    expect(await messages.next()).toEqual({ type: "ack", seq: 7 });

    const calls = await spyIngest();
    expect(calls.length).toBe(2);
  });

  it("kind はトップレベル優先、無ければ payload.type に fallback、両方なしは error", async () => {
    const { ws, messages } = await connectAccepted("hub-token-1");
    openSockets.push(ws);

    ws.send(
      JSON.stringify({
        type: "measurement",
        seq: 10,
        kind: "fc1200_raw",
        payload: { type: "temperature", hex: "deadbeef" },
      }),
    );
    expect(await messages.next()).toEqual({ type: "ack", seq: 10 });
    ws.send(JSON.stringify({ type: "measurement", seq: 11, payload: { value: 1 } }));
    expect(await messages.next()).toEqual({ type: "error", seq: 11, message: "missing_kind" });

    const calls = await spyIngest();
    expect(calls.length).toBe(1);
    expect(calls[0].items[0].kind).toBe("fc1200_raw");
  });

  it("上流エラー時は error(seq) を返す (詳細は echo しない)。端末は再送できる", async () => {
    const { ws, messages } = await connectAccepted("hub-token-1");
    openSockets.push(ws);

    ws.send(
      JSON.stringify({ type: "measurement", seq: 2, kind: "boom", payload: { x: 1 } }),
    );
    expect(await messages.next()).toEqual({ type: "error", seq: 2, message: "upstream_500" });

    // 再送 (今度は成功する kind) → ack
    ws.send(
      JSON.stringify({ type: "measurement", seq: 2, kind: "alcohol", payload: { x: 1 } }),
    );
    expect(await messages.next()).toEqual({ type: "ack", seq: 2 });
  });

  it("不正な frame は error を返す (invalid JSON / unknown type / invalid seq / invalid payload)", async () => {
    const { ws, messages } = await connectAccepted("hub-token-1");
    openSockets.push(ws);

    ws.send("not-json{");
    expect(await messages.next()).toEqual({ type: "error", message: "invalid_json" });

    ws.send(JSON.stringify({ type: "nope" }));
    expect(await messages.next()).toEqual({ type: "error", message: "unknown_type" });

    ws.send(JSON.stringify({ type: "measurement", seq: "x", payload: {} }));
    expect(await messages.next()).toEqual({ type: "error", message: "invalid_seq" });

    ws.send(JSON.stringify({ type: "measurement", seq: 3, payload: "str" }));
    expect(await messages.next()).toEqual({ type: "error", seq: 3, message: "invalid_payload" });

    expect(await spyIngest()).toEqual([]);
  });

  it("ping は pong が返る (auto-response 不一致 serialization の fallback 経路)", async () => {
    const { ws, messages } = await connectAccepted("hub-token-1");
    openSockets.push(ws);
    // auto-response は JSON.stringify({type:"ping"}) の完全一致のみ。space 入りは handler が受ける。
    ws.send('{ "type": "ping" }');
    expect(await messages.next()).toEqual({ type: "pong" });
  });
});

describe("下り command push / command_result", () => {
  it("接続中デバイスへ command を push し、command_result を取得できる", async () => {
    const { ws, messages } = await connectAccepted("hub-token-tenant-cmd");
    openSockets.push(ws);

    const cmdRes = await SELF.fetch(
      `${BASE}/tenants/tenant-cmd/devices/device-cmd/command`,
      {
        method: "POST",
        headers: { Authorization: SHARED_SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({ payload: { action: "MEASURE" } }),
      },
    );
    expect(cmdRes.status).toBe(202);
    const cmdBody = (await cmdRes.json()) as { id: string; delivered: number };
    expect(cmdBody.delivered).toBe(1);
    expect(cmdBody.id.length).toBeGreaterThan(0);

    // 端末側に command frame が届く
    const frame = (await messages.next()) as { type: string; id: string; payload: unknown };
    expect(frame.type).toBe("command");
    expect(frame.id).toBe(cmdBody.id);
    expect(frame.payload).toEqual({ action: "MEASURE" });

    // 端末が command_result を返す → HTTP で取得できる (保存は非同期なので retry)
    ws.send(
      JSON.stringify({ type: "command_result", id: cmdBody.id, payload: { ok: true } }),
    );
    let stored: { device_id?: string; payload?: unknown } | null = null;
    for (let i = 0; i < 20 && !stored; i++) {
      const res = await SELF.fetch(
        `${BASE}/tenants/tenant-cmd/commands/${cmdBody.id}/result`,
        { headers: { Authorization: SHARED_SECRET } },
      );
      if (res.status === 200) {
        stored = (await res.json()) as { device_id?: string; payload?: unknown };
        break;
      }
      expect(res.status).toBe(404);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(stored).not.toBeNull();
    expect(stored!.device_id).toBe("device-cmd");
    expect(stored!.payload).toEqual({ ok: true });
  });

  it("未接続デバイスへの command は 404", async () => {
    const res = await SELF.fetch(
      `${BASE}/tenants/tenant-cmd/devices/no-such-device/command`,
      {
        method: "POST",
        headers: { Authorization: SHARED_SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({ payload: {} }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("下り HTTP API は shared secret 必須 (欠落 / 不一致は 401)", async () => {
    const attempts: Record<string, string>[] = [{}, { Authorization: "wrong-secret" }];
    for (const headers of attempts) {
      const res = await SELF.fetch(
        `${BASE}/tenants/tenant-cmd/devices/device-cmd/command`,
        { method: "POST", headers, body: "{}" },
      );
      expect(res.status).toBe(401);
    }
    const list = await SELF.fetch(`${BASE}/tenants/tenant-cmd/devices`);
    expect(list.status).toBe(401);
  });

  it("接続中デバイス一覧を返す", async () => {
    const { ws } = await connectAccepted("hub-token-tenant-cmd");
    openSockets.push(ws);
    const res = await SELF.fetch(`${BASE}/tenants/tenant-cmd/devices`, {
      headers: { Authorization: SHARED_SECRET },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devices: string[] };
    expect(body.devices).toContain("device-cmd");
  });
});

describe("hibernation 復帰 / テナント分離", () => {
  it("identity は in-memory でなく WS attachment に永続化される (hibernation 復帰後も転送先が壊れない)", async () => {
    const { ws } = await connectAccepted("hub-token-2");
    openSockets.push(ws);

    const stub = env.RECORDER_HUB.get(env.RECORDER_HUB.idFromName("tenant-1"));
    await runInDurableObject(stub, (_instance, state) => {
      const sockets = state.getWebSockets("device:device-2");
      expect(sockets.length).toBe(1);
      // webSocketMessage は毎回この attachment から identity を読む実装なので、
      // attachment が正しければ hibernation を跨いでも ingest 先は保たれる。
      expect(sockets[0].deserializeAttachment()).toEqual({
        tenantId: "tenant-1",
        deviceId: "device-2",
      });
    });
  });

  it("同一 device の再接続は旧接続を close して置き換える (ゾンビ排除)", async () => {
    const first = await connectAccepted("hub-token-2");
    openSockets.push(first.ws);
    const closed = new Promise<{ code: number }>((resolve) => {
      first.ws.addEventListener("close", (event) =>
        resolve({ code: (event as CloseEvent).code }),
      );
    });

    const second = await connectAccepted("hub-token-2");
    openSockets.push(second.ws);
    // 旧接続はサーバ側から 1012 (Service Restart = 再接続してよい) で閉じられる。
    expect((await closed).code).toBe(1012);

    // 新接続は通常どおり機能する (measurement → ack)。
    second.ws.send(
      JSON.stringify({ type: "measurement", seq: 42, kind: "alcohol", payload: { v: 0 } }),
    );
    expect(await second.messages.next()).toEqual({ type: "ack", seq: 42 });
  });

  it("DO はテナント単位に分離される (他テナントの hub に device が見えない)", async () => {
    const { ws } = await connectAccepted("hub-token-1"); // tenant-1 / device-1
    openSockets.push(ws);
    const res = await SELF.fetch(`${BASE}/tenants/tenant-cmd/devices`, {
      headers: { Authorization: SHARED_SECRET },
    });
    const body = (await res.json()) as { devices: string[] };
    expect(body.devices).not.toContain("device-1");
  });
});
