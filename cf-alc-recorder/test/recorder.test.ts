import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/index";
import { hubStub } from "../src/hub-stub";
import {
  decideRecorderAuth,
  decideWatcherAuth,
  RECORDER_DEVICE_ROLES,
  DEVICE_ROLE_KIOSK,
  isDevIntrospect,
  resolveSecret,
} from "../src/auth";
import { closeCodeForEcho } from "../src/recorder-hub";
import { isOtaDeviceId, parseOtaReport } from "../src/recorder-hub";

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
    /**
     * まだ取り出していない受信数。
     *
     * **「何も来ない」の確認に `next()` を使ってはいけない** — タイムアウトで
     * reject しても waiter が配列に残り、**次に届いたメッセージがその死んだ
     * waiter に吸われて消える**。`await sleep(...)` してからこれを見ること。
     */
    pending(): number {
      return queue.length;
    },
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

/**
 * 打刻更新の購読 WS を張る。トークンは `Sec-WebSocket-Protocol` の 2 つ目。
 * **`connected` は送られない** (watcher は購読専用で、上りも下り command も無い)。
 */
async function connectWatcher(token: string) {
  const res = await SELF.fetch(`${BASE}/watch-timecard`, {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `alc.timecard.v1, ${token}`,
    },
  });
  return { res, ws: res.webSocket ?? null };
}

/**
 * ブラウザ打刻の内部 API を叩く (alc-app の server route と同じ形)。
 * 認証は `Authorization: <INTERNAL_SHARED_SECRET>` (生の値)。
 */
function punchViaHttp(tenantId: string, deviceId: string, body: unknown) {
  return SELF.fetch(`${BASE}/tenants/${tenantId}/devices/${deviceId}/timecard-punch`, {
    method: "POST",
    headers: { Authorization: SHARED_SECRET, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * シリアル OTA の合図を送る内部 API (auth-worker /device/setup の recorderFetch と同じ形、
 * Refs ippoan/alc-app-s3#279)。認証は `Authorization: <INTERNAL_SHARED_SECRET>`。
 * **`authHeader: null` は「ヘッダーを付けない」の意** (`undefined` は default param に
 * 吸われて区別できないため)。
 */
function serialOtaViaHttp(
  tenantId: string,
  body: unknown,
  authHeader: string | null = SHARED_SECRET,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader !== null) headers.Authorization = authHeader;
  return SELF.fetch(`${BASE}/tenants/${tenantId}/serial-ota`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * `/watch-timecard` に接続しつつ、クライアント側から偽の
 * `X-Recorder-Watcher-Kind` ヘッダーを付ける (詐称できないことの確認用)。
 */
async function connectWatcherWithForgedKind(token: string, forgedKind: string) {
  const res = await SELF.fetch(`${BASE}/watch-timecard`, {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `alc.timecard.v1, ${token}`,
      "X-Recorder-Watcher-Kind": forgedKind,
    },
  });
  return { res, ws: res.webSocket ?? null };
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

interface IngestCall {
  tenantId: string;
  /** backend への要求に付いた `X-Device-Dev` (無ければ null)。 */
  dev: string | null;
  items: Array<Record<string, unknown>>;
}

async function spyIngest(): Promise<IngestCall[]> {
  const res = await env.AUTH_WORKER.fetch("https://auth-worker.internal/__spy/ingest");
  return (await res.json()) as IngestCall[];
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

  it("decideRecorderAuth: allowlist role の判定 (hub/print/gateway/timecard は 101、他は 403)", () => {
    const claims = { active: true, tenant_id: "t", sub: "d" };
    // AtomS3 印刷ブリッジ (ippoan/alc-app-s3#38) — 下り print/ota command 待受
    expect(decideRecorderAuth({ ...claims, role: "device-print" }).status).toBe(101);
    expect(decideRecorderAuth({ ...claims, role: "device-hub" }).status).toBe(101);
    // P4 GW (Unit PoE-P4、ippoan/alc-gw-p4#15) — 下り version/ota command 待受
    expect(decideRecorderAuth({ ...claims, role: "device-gateway" }).status).toBe(101);
    // NFC タイムカード端末 (ippoan/alc-app-s3#134) — 上り kind=timecard / 下り ota
    expect(decideRecorderAuth({ ...claims, role: "device-timecard" }).status).toBe(101);
    // blast radius 分離: 他 role・role 欠落は従来どおり 403
    expect(decideRecorderAuth({ ...claims, role: "device-kiosk" }).status).toBe(403);
    expect(decideRecorderAuth({ ...claims, role: "device-uploader" }).status).toBe(403);
    expect(decideRecorderAuth({ ...claims }).status).toBe(403);
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

  it("session_id はトップレベルで素通しされ、不正値は測定を落とさず null になる", async () => {
    // Refs ippoan/alc-app-s3#112 — 1 回の点呼を束ねる端末発番の識別子。
    const { ws, messages } = await connectAccepted("hub-token-1");
    openSockets.push(ws);

    // 正常値はそのまま転送される
    ws.send(
      JSON.stringify({
        type: "measurement",
        seq: 20,
        kind: "alcohol",
        session_id: "s-42_7",
        payload: { value: 0.0 },
      }),
    );
    expect(await messages.next()).toEqual({ type: "ack", seq: 20 });

    // 字種が外れた値: 測定は通し、session_id だけ null に落とす
    // (session_id を理由に測定を捨てると点呼の記録そのものを失うため)
    ws.send(
      JSON.stringify({
        type: "measurement",
        seq: 21,
        kind: "alcohol",
        session_id: "bad id/x",
        payload: { value: 0.0 },
      }),
    );
    expect(await messages.next()).toEqual({ type: "ack", seq: 21 });

    // 未指定 (旧ファーム / 点呼外の単発計測) は null
    ws.send(
      JSON.stringify({
        type: "measurement",
        seq: 22,
        kind: "temperature",
        payload: { value: 36.5 },
      }),
    );
    expect(await messages.next()).toEqual({ type: "ack", seq: 22 });

    const calls = await spyIngest();
    const bySeq = new Map(calls.flatMap((c) => c.items).map((i) => [i.seq, i]));
    expect(bySeq.get(20)?.session_id).toBe("s-42_7");
    expect(bySeq.get(21)?.session_id).toBeNull();
    expect(bySeq.get(22)?.session_id).toBeNull();
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

  it("crash_log は backend へ転送せず R2 に保存して ack する (alc-app-s3#43)", async () => {
    const { ws, messages } = await connectAccepted("hub-token-1");
    openSockets.push(ws);

    const frame = JSON.stringify({
      type: "measurement",
      seq: 42,
      recorded_at_ms: 0,
      kind: "crash_log",
      payload: { type: "crash_log", reset_reason: "panic", reset_code: 4, log: "PANIC: boom\n" },
    });
    ws.send(frame);
    expect(await messages.next()).toEqual({ type: "ack", seq: 42 });

    // backend (ingest) は呼ばれない
    expect((await spyIngest()).length).toBe(0);

    // R2 に seq ベースの key で保存される (tenant/device は JWT claims 由来)
    const obj = await env.CRASH_LOGS.get("tenant-1/device-1/000000000042.json");
    expect(obj).not.toBeNull();
    const stored = JSON.parse(await obj!.text()) as Record<string, unknown>;
    expect(stored.tenant_id).toBe("tenant-1");
    expect(stored.device_id).toBe("device-1");
    expect(stored.seq).toBe(42);
    expect(stored.recorded_at_ms).toBe(0);
    expect(typeof stored.received_at_ms).toBe("number");
    expect((stored.payload as Record<string, unknown>).reset_reason).toBe("panic");

    // 同 seq の再送は同じ key を上書き (重複オブジェクトを作らない)
    ws.send(frame);
    expect(await messages.next()).toEqual({ type: "ack", seq: 42 });
    const listed = await env.CRASH_LOGS.list({ prefix: "tenant-1/device-1/" });
    expect(listed.objects.length).toBe(1);
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

describe("POST /measurements (Wi-Fi 客の上りバッチ)", () => {
  /** POST /measurements を投げるヘルパー。 */
  async function postMeasurements(body: unknown, token?: string): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    return SELF.fetch(`${BASE}/measurements`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("認証は /ws と同じ: Bearer なし 401 / active:false 401 / kiosk role 403", async () => {
    expect((await postMeasurements([])).status).toBe(401);
    expect((await postMeasurements([], "expired-token")).status).toBe(401);
    const res = await postMeasurements([], "kiosk-token");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_role" });
  });

  it("バッチを 1 回の ingest で転送し、受理 seq 一覧を返す。tenant/device は JWT claims から注入", async () => {
    const res = await postMeasurements(
      [
        {
          seq: 1,
          recorded_at_ms: 1752300000000,
          payload: {
            type: "temperature",
            value: 36.5,
            // ペイロード側の識別子は無視される (詐称不可)
            device_id: "spoofed-device",
            tenant_id: "spoofed-tenant",
          },
        },
        { seq: 2, kind: "alcohol", payload: { value: 0.0 } },
      ],
      "hub-token-1",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: [1, 2] });

    const calls = await spyIngest();
    expect(calls.length).toBe(1);
    expect(calls[0].tenantId).toBe("tenant-1");
    expect(calls[0].items.length).toBe(2);
    // device_id は JWT の sub、kind はトップレベル優先 / payload.type fallback
    expect(calls[0].items[0].device_id).toBe("device-1");
    expect(calls[0].items[0].kind).toBe("temperature");
    expect(calls[0].items[0].recorded_at_ms).toBe(1752300000000);
    expect(calls[0].items[1].kind).toBe("alcohol");
    expect(calls[0].items[1].recorded_at_ms).toBeNull();
    expect((calls[0].items[0].payload as Record<string, unknown>).value).toBe(36.5);
  });

  it("同じ seq の再送も accept される (重複排除は rust 側 UNIQUE で冪等)", async () => {
    const batch = [{ seq: 7, kind: "alcohol", payload: { value: 0.0 } }];
    expect((await postMeasurements(batch, "hub-token-1")).status).toBe(200);
    expect((await postMeasurements(batch, "hub-token-1")).status).toBe(200);
    expect((await spyIngest()).length).toBe(2);
  });

  it("crash_log は R2 へ保存し、他の kind だけ ingest へ転送する (alc-app-s3#43)", async () => {
    const res = await postMeasurements(
      [
        { seq: 100, kind: "crash_log", payload: { reset_reason: "task_wdt", log: "EVT HEAP ...\n" } },
        { seq: 101, kind: "temperature", payload: { value: 36.6 } },
      ],
      "hub-token-1",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: [100, 101] });

    // ingest へは crash_log 以外だけが渡る
    const calls = await spyIngest();
    expect(calls.length).toBe(1);
    expect(calls[0].items.map((i) => i.seq)).toEqual([101]);

    const obj = await env.CRASH_LOGS.get("tenant-1/device-1/000000000100.json");
    expect(obj).not.toBeNull();
    const stored = JSON.parse(await obj!.text()) as Record<string, unknown>;
    expect((stored.payload as Record<string, unknown>).reset_reason).toBe("task_wdt");
  });

  it("不正 body は 400: invalid JSON / 非配列 / 上限超過", async () => {
    const invalid = await postMeasurements("not-json{", "hub-token-1");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_json" });

    const nonArray = await postMeasurements({ seq: 1 }, "hub-token-1");
    expect(nonArray.status).toBe(400);
    expect(await nonArray.json()).toEqual({ error: "invalid_body" });

    const tooMany = await postMeasurements(
      Array.from({ length: 101 }, (_, i) => ({ seq: i, kind: "alcohol", payload: {} })),
      "hub-token-1",
    );
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toEqual({ error: "too_many_items" });

    expect(await spyIngest()).toEqual([]);
  });

  it("1 件でも不正な item があれば batch ごと 400 (index 付き)、ingest は呼ばれない", async () => {
    const cases: Array<{ body: unknown[]; error: string; index: number }> = [
      { body: ["str"], error: "invalid_item", index: 0 },
      { body: [{ seq: "x", payload: {} }], error: "invalid_seq", index: 0 },
      {
        body: [
          { seq: 1, kind: "alcohol", payload: {} },
          { seq: 2, payload: "str" },
        ],
        error: "invalid_payload",
        index: 1,
      },
      { body: [{ seq: 3, payload: { value: 1 } }], error: "missing_kind", index: 0 },
    ];
    for (const c of cases) {
      const res = await postMeasurements(c.body, "hub-token-1");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: c.error, index: c.index });
    }
    expect(await spyIngest()).toEqual([]);
  });

  it("空バッチは上流を叩かず accepted:[] を返す", async () => {
    const res = await postMeasurements([], "hub-token-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: [] });
    expect(await spyIngest()).toEqual([]);
  });

  it("上流エラー時は 502 (詳細は echo しない)。端末は同じ batch を再送できる", async () => {
    const res = await postMeasurements(
      [{ seq: 2, kind: "boom", payload: { x: 1 } }],
      "hub-token-1",
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_500" });

    const retry = await postMeasurements(
      [{ seq: 2, kind: "alcohol", payload: { x: 1 } }],
      "hub-token-1",
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ accepted: [2] });
  });

  it("GET /measurements は 404 (POST のみ)", async () => {
    const res = await SELF.fetch(`${BASE}/measurements`);
    expect(res.status).toBe(404);
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

  it("SSE (/events) は接続直後に接続中デバイス一覧のスナップショットを送る", async () => {
    const { ws } = await connectAccepted("hub-token-tenant-sse");
    openSockets.push(ws);
    const res = await SELF.fetch(`${BASE}/tenants/tenant-sse/events`, {
      headers: { Authorization: SHARED_SECRET },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("event: devices");
    expect(JSON.parse(chunk.split("data: ")[1]!)).toEqual({ devices: ["device-sse"] });
    await reader.cancel();
  });

  it("SSE (/events) も shared secret 必須 (欠落は 401)", async () => {
    const res = await SELF.fetch(`${BASE}/tenants/tenant-cmd/events`);
    expect(res.status).toBe(401);
  });
});

describe("hibernation 復帰 / テナント分離", () => {
  it("identity は in-memory でなく WS attachment に永続化される (hibernation 復帰後も転送先が壊れない)", async () => {
    const { ws } = await connectAccepted("hub-token-2");
    openSockets.push(ws);

    const stub = hubStub(env, "tenant-1");
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

// ---------------------------------------------------------------------------
// 打刻更新の購読 (GET /watch-timecard、Refs ippoan/alc-app-s3#134)
//
// **読み取り専用の口**。device 経路 (`/ws`) の allowlist とは別判定にしてある —
// あちらは「下り command を受け取ってよいデバイス」なので、混ぜると購読者を
// 増やすたびに command の宛先が増える。
// ---------------------------------------------------------------------------

describe("decideWatcherAuth", () => {
  it("キオスクの device JWT と 管理者/運行管理者の user JWT を受ける", () => {
    expect(decideWatcherAuth({ active: true, role: DEVICE_ROLE_KIOSK, tenant_id: "t" })).toEqual({
      status: 101,
      tenantId: "t",
      watcherKind: "kiosk",
    });
    expect(decideWatcherAuth({ active: true, role: "admin", tenant_id: "t" }).status).toBe(101);
    expect(decideWatcherAuth({ active: true, role: "manager", tenant_id: "t" }).status).toBe(101);
  });

  it("それ以外の role は 403 — 「tenant_id があれば通す」にしない", () => {
    for (const role of ["viewer", "uploader", "device-uploader", ""]) {
      expect(decideWatcherAuth({ active: true, role, tenant_id: "t" }).status).toBe(403);
    }
    // role 欠落も 403 (fail-closed)
    expect(decideWatcherAuth({ active: true, tenant_id: "t" }).status).toBe(403);
  });

  it("active でない / tenant_id 欠落は 401 (fail-closed)", () => {
    expect(decideWatcherAuth({ active: false, role: "admin", tenant_id: "t" }).status).toBe(401);
    expect(decideWatcherAuth({ active: true, role: "admin" }).status).toBe(401);
    expect(decideWatcherAuth(null).status).toBe(401);
    expect(decideWatcherAuth(undefined).status).toBe(401);
  });

  it("★ device-kiosk を RECORDER_DEVICE_ROLES に足していない", () => {
    // 足すと**キオスクが下り command の宛先になる** (blast radius 分離が崩れる)。
    // 購読は読み取り専用なので、こちらの allowlist だけに入れる
    expect(RECORDER_DEVICE_ROLES.has(DEVICE_ROLE_KIOSK)).toBe(false);
    expect(decideRecorderAuth({ active: true, role: DEVICE_ROLE_KIOSK, tenant_id: "t", sub: "d" }).status).toBe(403);
  });

  it("watcher に deviceId は要らない (sub 無しでも通る)", () => {
    // sub を要求すると、DO の attachment に deviceId を載せたくなる。
    // 載せると currentDeviceIds() が拾い、キオスクが「接続中デバイス」に現れる
    expect(decideWatcherAuth({ active: true, role: DEVICE_ROLE_KIOSK, tenant_id: "t" }).status).toBe(101);
  });

  it("watcherKind: キオスクは kiosk、admin/manager は user (DO の KIOSK_TAG 付与に使う、#279)", () => {
    expect(
      decideWatcherAuth({ active: true, role: DEVICE_ROLE_KIOSK, tenant_id: "t" }).watcherKind,
    ).toBe("kiosk");
    expect(decideWatcherAuth({ active: true, role: "admin", tenant_id: "t" }).watcherKind).toBe(
      "user",
    );
    expect(decideWatcherAuth({ active: true, role: "manager", tenant_id: "t" }).watcherKind).toBe(
      "user",
    );
  });
});

describe("GET /watch-timecard のハンドシェイク", () => {
  it("Upgrade が無ければ 426", async () => {
    const res = await SELF.fetch(`${BASE}/watch-timecard`);
    expect(res.status).toBe(426);
  });

  it("サブプロトコルが無い / トークンだけは 401", async () => {
    const noProto = await SELF.fetch(`${BASE}/watch-timecard`, {
      headers: { Upgrade: "websocket" },
    });
    expect(noProto.status).toBe(401);

    const onlyName = await SELF.fetch(`${BASE}/watch-timecard`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "alc.timecard.v1" },
    });
    expect(onlyName.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 購読 WS の振る舞い (Refs ippoan/alc-app-s3#134)
// ---------------------------------------------------------------------------

describe("/watch-timecard の振る舞い", () => {
  it("キオスクの device JWT で 101、サブプロトコルは名前だけ echo される", async () => {
    const { res, ws } = await connectWatcher("kiosk-token");
    expect(res.status).toBe(101);
    expect(ws).not.toBeNull();
    openSockets.push(ws!);
    // **トークンを echo し返してはいけない** (応答ヘッダーに秘密が乗る)
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBe("alc.timecard.v1");
  });

  it("★ watcher は下り command を受け取らない", async () => {
    // 購読者を増やすことが command の宛先を増やすことにならない、を固定する。
    // 崩れると「読み取り専用のつもりが遠隔操作の対象になっていた」になる
    const { ws: watcherWs } = await connectWatcher("kiosk-token");
    expect(watcherWs).not.toBeNull();
    openSockets.push(watcherWs!);
    const watcher = messageQueue(watcherWs!);

    // 同じテナントの device に command を送る
    const { ws: deviceWs, messages: deviceMessages } = await connectAccepted("hub-token-1");
    openSockets.push(deviceWs);

    const cmdRes = await SELF.fetch(`${BASE}/tenants/tenant-1/devices/device-1/command`, {
      method: "POST",
      headers: { Authorization: SHARED_SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { action: "MEASURE" } }),
    });
    expect(cmdRes.status).toBe(202);
    expect(((await cmdRes.json()) as { delivered: number }).delivered).toBe(1);

    // device には届く
    expect(((await deviceMessages.next()) as { type: string }).type).toBe("command");
    // watcher には届かない
    await new Promise((r) => setTimeout(r, 300));
    expect(watcher.pending()).toBe(0);
  });

  it("★ 打刻の合図は同じテナントの watcher にだけ届く", async () => {
    const { ws: watcherWs } = await connectWatcher("kiosk-token"); // tenant-1
    expect(watcherWs).not.toBeNull();
    openSockets.push(watcherWs!);
    const watcher = messageQueue(watcherWs!);

    // **別テナント**の端末が打刻を送っても、tenant-1 の watcher には届かない
    const other = await connectAccepted("hub-token-tenant-cmd"); // tenant-cmd
    openSockets.push(other.ws);
    other.ws.send(
      JSON.stringify({
        type: "measurement",
        seq: 1,
        recorded_at_ms: 1752300000000,
        kind: "timecard",
        payload: { card_id: "AAAA", card_kind: "felica_idm" },
      }),
    );
    expect(((await other.messages.next()) as { type: string }).type).toBe("ack");
    await new Promise((r) => setTimeout(r, 300));
    expect(watcher.pending()).toBe(0);

    // 同じテナントの端末なら届く。**合図だけで行の中身は含まない**
    const same = await connectAccepted("hub-token-1"); // tenant-1
    openSockets.push(same.ws);
    same.ws.send(
      JSON.stringify({
        type: "measurement",
        seq: 101,
        recorded_at_ms: 1752300000000,
        kind: "timecard",
        payload: { card_id: "BBBB", card_kind: "felica_idm" },
      }),
    );
    expect(((await same.messages.next()) as { type: string }).type).toBe("ack");
    expect(await watcher.next()).toEqual({ type: "timecard_punch" });
  });

  it("打刻以外の kind では合図を出さない", async () => {
    const { ws: watcherWs } = await connectWatcher("kiosk-token");
    expect(watcherWs).not.toBeNull();
    openSockets.push(watcherWs!);
    const watcher = messageQueue(watcherWs!);

    const device = await connectAccepted("hub-token-1");
    openSockets.push(device.ws);
    device.ws.send(
      JSON.stringify({
        type: "measurement",
        seq: 201,
        recorded_at_ms: 1752300000000,
        payload: { type: "temperature", value: 36.5, unit: "celsius" },
      }),
    );
    expect(((await device.messages.next()) as { type: string }).type).toBe("ack");
    await new Promise((r) => setTimeout(r, 300));
    expect(watcher.pending()).toBe(0);
  });

  it("★ ブラウザ打刻 (内部 API) でも同じ合図が出る", async () => {
    // これが鳴らないと「端末で打つと更新されるが、ブラウザで打つと更新されない」
    // という経路依存の挙動になる (Refs ippoan/alc-app-s3#134)
    const { ws: watcherWs } = await connectWatcher("kiosk-token"); // tenant-1
    expect(watcherWs).not.toBeNull();
    openSockets.push(watcherWs!);
    const watcher = messageQueue(watcherWs!);

    const res = await punchViaHttp("tenant-1", "device-kiosk-1", { card_id: " CCCC " });
    expect(res.status).toBe(202);
    expect(await watcher.next()).toEqual({ type: "timecard_punch" });

    // ingest には kind=timecard / device_id / card_id (trim 済み) が渡る。
    // **kind はサーバが立てる** ので、body に kind を書いても効かない
    const calls = await spyIngest();
    expect(calls.length).toBe(1);
    expect(calls[0].tenantId).toBe("tenant-1");
    expect(calls[0].items.length).toBe(1);
    expect(calls[0].items[0]).toMatchObject({
      device_id: "device-kiosk-1",
      kind: "timecard",
      recorded_at_ms: null,
      session_id: null,
      payload: { card_id: "CCCC" },
    });
  });

  it("★ ブラウザ打刻の kind はサーバが立てる (body の kind / payload は無視)", async () => {
    // crash_log や点呼系の kind を注入できる口にしない
    const res = await punchViaHttp("tenant-1", "device-kiosk-1", {
      card_id: "DDDD",
      kind: "crash_log",
      payload: { reset_reason: "panic" },
      seq: 1,
      recorded_at_ms: 1752300000000,
    });
    expect(res.status).toBe(202);
    const calls = await spyIngest();
    expect(calls[0].items[0].kind).toBe("timecard");
    expect(calls[0].items[0].payload).toEqual({ card_id: "DDDD" });
    expect(calls[0].items[0].recorded_at_ms).toBeNull();
  });

  it("ブラウザ打刻の seq は同ミリ秒でも衝突しない", async () => {
    // 端末と違って再送が無いので冪等キーではないが、
    // UNIQUE (tenant_id, device_id, seq) に当たると打刻が落ちる
    for (const cardId of ["E1", "E2", "E3"]) {
      const res = await punchViaHttp("tenant-1", "device-kiosk-1", { card_id: cardId });
      expect(res.status).toBe(202);
    }
    const calls = await spyIngest();
    const seqs = calls.map((c) => c.items[0].seq as number);
    expect(new Set(seqs).size).toBe(3);
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
    expect(seqs[2]).toBeGreaterThan(seqs[1]);
  });

  it("card_id が無い / 空 / 長すぎるブラウザ打刻は 400 で、合図も出ない", async () => {
    const { ws: watcherWs } = await connectWatcher("kiosk-token");
    expect(watcherWs).not.toBeNull();
    openSockets.push(watcherWs!);
    const watcher = messageQueue(watcherWs!);

    const bodies = [{}, { card_id: "   " }, { card_id: 42 }, { card_id: "x".repeat(257) }];
    for (const body of bodies) {
      const res = await punchViaHttp("tenant-1", "device-kiosk-1", body);
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toEqual({ error: "invalid_card_id" });
    }
    // JSON でない body / 配列 body も弾く
    for (const raw of ["not-json", "[]"]) {
      const res = await SELF.fetch(
        `${BASE}/tenants/tenant-1/devices/device-kiosk-1/timecard-punch`,
        {
          method: "POST",
          headers: { Authorization: SHARED_SECRET, "Content-Type": "application/json" },
          body: raw,
        },
      );
      expect(res.status).toBe(400);
    }

    expect(await spyIngest()).toEqual([]);
    await new Promise((r) => setTimeout(r, 300));
    expect(watcher.pending()).toBe(0);
  });

  it("★ ブラウザ打刻は上流失敗を 502 で返し、合図を出さない", async () => {
    // 合図は「backend が受理した後」だけ。受理されていないのに鳴らすと、
    // 引き直した画面には何も増えていない (= 嘘の更新通知になる)
    const { ws: watcherWs } = await connectWatcher("kiosk-token");
    expect(watcherWs).not.toBeNull();
    openSockets.push(watcherWs!);
    const watcher = messageQueue(watcherWs!);

    // mock の auth-worker は card_id="boom" の打刻に 500 を返す
    const res = await punchViaHttp("tenant-1", "device-kiosk-1", { card_id: "boom" });
    expect(res.status).toBe(502);
    expect((await res.json()) as { error: string }).toEqual({ error: "upstream_500" });

    await new Promise((r) => setTimeout(r, 300));
    expect(watcher.pending()).toBe(0);
  });

  it("ブラウザ打刻の内部 API は shared secret 必須 (欠落 / 不一致は 401)", async () => {
    for (const headers of [{}, { Authorization: "wrong-secret" }] as Record<string, string>[]) {
      const res = await SELF.fetch(
        `${BASE}/tenants/tenant-1/devices/device-kiosk-1/timecard-punch`,
        { method: "POST", headers, body: JSON.stringify({ card_id: "GGGG" }) },
      );
      expect(res.status).toBe(401);
    }
    expect(await spyIngest()).toEqual([]);
  });

  it("★ watcher は「接続中デバイス」一覧に現れない", async () => {
    // attachment に deviceId を載せると currentDeviceIds() が拾い、
    // キオスクが管理画面のデバイス一覧に出てしまう
    const { ws } = await connectWatcher("kiosk-token");
    expect(ws).not.toBeNull();
    openSockets.push(ws!);

    const res = await SELF.fetch(`${BASE}/tenants/tenant-1/devices`, {
      headers: { Authorization: SHARED_SECRET },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devices: string[] };
    expect(body.devices).not.toContain("device-kiosk-1");
  });
});

// ---------------------------------------------------------------------------
// シリアル OTA の合図 (POST /tenants/:tenantId/serial-ota、Refs ippoan/alc-app-s3#279)
//
// **専用テナント (`tenant-ota`)** — isolatedStorage: false なので他 test の
// kiosk 購読が KIOSK_TAG に混ざると「キオスクにだけ届く」を判定できない。
// ---------------------------------------------------------------------------

describe("serial-ota の合図", () => {
  it("キオスクの購読は KIOSK_TAG 付き、admin の購読は付かない", async () => {
    const { ws: kioskWs } = await connectWatcher("kiosk-token-ota");
    expect(kioskWs).not.toBeNull();
    openSockets.push(kioskWs!);
    const { ws: adminWs } = await connectWatcher("admin-token-ota");
    expect(adminWs).not.toBeNull();
    openSockets.push(adminWs!);

    const stub = hubStub(env, "tenant-ota");
    await runInDurableObject(stub, (_instance, state) => {
      // キオスクだけ KIOSK_TAG が付く。admin も含めて両方 WATCH_TAG は付く
      // (打刻更新の合図は従来どおり両方に届く)。
      expect(state.getWebSockets("watch:kiosk").length).toBe(1);
      expect(state.getWebSockets("watch:timecard").length).toBe(2);
    });
  });

  it("★ KIOSK_TAG の購読にだけ送る。admin の購読と device の socket には届かない", async () => {
    const { ws: kioskWs } = await connectWatcher("kiosk-token-ota-2");
    expect(kioskWs).not.toBeNull();
    openSockets.push(kioskWs!);
    const kiosk = messageQueue(kioskWs!);

    const { ws: adminWs } = await connectWatcher("admin-token-ota-2");
    expect(adminWs).not.toBeNull();
    openSockets.push(adminWs!);
    const admin = messageQueue(adminWs!);

    const device = await connectAccepted("hub-token-ota-2");
    openSockets.push(device.ws);

    const res = await serialOtaViaHttp("tenant-ota-2", { target: "timecard-station" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1 });

    expect(await kiosk.next()).toEqual({ type: "serial_ota", target: "timecard-station" });
    await new Promise((r) => setTimeout(r, 300));
    expect(admin.pending()).toBe(0);
    expect(device.messages.pending()).toBe(0);
  });

  it("内部認証なしは 401 (requireInternalAuth と同じ挙動)", async () => {
    expect((await serialOtaViaHttp("tenant-ota", { target: "timecard-station" }, null)).status).toBe(
      401,
    );
    expect(
      (await serialOtaViaHttp("tenant-ota", { target: "timecard-station" }, "wrong-secret")).status,
    ).toBe(401);
  });

  it("target が allowlist 外 / 欠落 / JSON 不正は 400", async () => {
    const other = await serialOtaViaHttp("tenant-ota", { target: "not-allowed" });
    expect(other.status).toBe(400);
    expect(await other.json()).toEqual({ error: "invalid_target" });

    const missing = await serialOtaViaHttp("tenant-ota", {});
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "invalid_target" });

    const badJson = await serialOtaViaHttp("tenant-ota", "not-json{");
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({ error: "invalid_json" });
  });

  it("★ クライアントが付けた区分ヘッダーは効かない (admin が kiosk を騙っても KIOSK_TAG は付かない)", async () => {
    const forged = await connectWatcherWithForgedKind("admin-token-ota-3", "kiosk");
    expect(forged.res.status).toBe(101);
    expect(forged.ws).not.toBeNull();
    openSockets.push(forged.ws!);
    const forgedQueue = messageQueue(forged.ws!);

    const res = await serialOtaViaHttp("tenant-ota-3", { target: "timecard-station" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 0 });
    await new Promise((r) => setTimeout(r, 300));
    expect(forgedQueue.pending()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 切断の後始末 (webSocketClose、Refs ippoan/rust-alc-api#644)
//
// **相手の close code をそのまま `ws.close()` へ渡すと 1005 / 1006 で投げる。**
// 投げると `broadcastDevices()` に到達せず、`/events` の接続中デバイス一覧が
// 切断後も古いまま残る。ブラウザの `ws.close()` (引数なし) は 1005 になるので、
// これは異常系ではなく**定常的に通る経路**。
// ---------------------------------------------------------------------------

describe("closeCodeForEcho", () => {
  it("1005 / 1006 は ws.close() へ渡せないので 1000 に丸める", () => {
    expect(closeCodeForEcho(1005)).toBe(1000);
    expect(closeCodeForEcho(1006)).toBe(1000);
  });

  it("それ以外はそのまま返す (相手が名乗った理由を潰さない)", () => {
    expect(closeCodeForEcho(1000)).toBe(1000);
    expect(closeCodeForEcho(1001)).toBe(1001);
    expect(closeCodeForEcho(1012)).toBe(1012);
    expect(closeCodeForEcho(4000)).toBe(4000);
  });
});

describe("webSocketClose", () => {
  it("code なしで閉じられても SSE の接続中デバイス一覧が更新される (broadcastDevices まで到達する)", async () => {
    // **専用テナント** — isolatedStorage: false なので他の test の socket が
    // 一覧に混ざると「消えたこと」を判定できない
    const { ws } = await connectAccepted("hub-token-tenant-close");

    const res = await SELF.fetch(`${BASE}/tenants/tenant-close/events`, {
      headers: { Authorization: SHARED_SECRET },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // 接続直後のスナップショット
    const first = decoder.decode((await reader.read()).value);
    expect(JSON.parse(first.split("data: ")[1]!)).toEqual({ devices: ["device-close"] });

    // **引数なしの close** = 相手側に 1005 が届く (キオスクの useTimecardWatch.stop() と同じ)
    ws.close();

    // 丸めていなければここで `Invalid WebSocket close code: 1005.` が投げ、
    // broadcastDevices が呼ばれず、この read は永久に返らない
    const second = decoder.decode((await reader.read()).value);
    expect(second).toContain("event: devices");
    expect(JSON.parse(second.split("data: ")[1]!)).toEqual({ devices: [] });

    await reader.cancel();
  });
});

// ---------------------------------------------------------------------------
// Secrets Store binding の解決 (resolveSecret)
//
// 打刻 1 件ごとに通る (handleMeasurement / handleTimecardPunch /
// requireInternalAuth / authenticateDevice) ので、isolate 内で使い回す。
// ---------------------------------------------------------------------------

describe("resolveSecret", () => {
  it("文字列 binding はそのまま返す (テスト注入の形)", async () => {
    expect(await resolveSecret("plain")).toBe("plain");
  });

  it("get を持たない binding は null (未設定扱い)", async () => {
    expect(await resolveSecret(undefined)).toBeNull();
    expect(await resolveSecret(null)).toBeNull();
    expect(await resolveSecret({})).toBeNull();
  });

  it("Secrets Store binding は isolate 内で 1 回しか .get() を撃たない", async () => {
    let calls = 0;
    const binding = {
      async get() {
        calls++;
        return "s3cret";
      },
    };
    expect(await resolveSecret(binding)).toBe("s3cret");
    expect(await resolveSecret(binding)).toBe("s3cret");
    expect(calls).toBe(1);
  });

  it("同時に呼んでも .get() は 1 回 (解決中の Promise を使い回す)", async () => {
    let calls = 0;
    const binding = {
      async get() {
        calls++;
        return "concurrent";
      },
    };
    const all = await Promise.all([
      resolveSecret(binding),
      resolveSecret(binding),
      resolveSecret(binding),
    ]);
    expect(all).toEqual(["concurrent", "concurrent", "concurrent"]);
    expect(calls).toBe(1);
  });

  it("binding ごとに別の値を返す (env をまたいで混ざらない)", async () => {
    const a = { async get() { return "a"; } };
    const b = { async get() { return "b"; } };
    expect(await resolveSecret(a)).toBe("a");
    expect(await resolveSecret(b)).toBe("b");
    expect(await resolveSecret(a)).toBe("a");
  });

  it("★ 失敗は cache に残さない (次の呼び出しでやり直せる)", async () => {
    let calls = 0;
    const binding = {
      async get() {
        calls++;
        if (calls === 1) throw new Error("store unavailable");
        return "recovered";
      },
    };
    await expect(resolveSecret(binding)).rejects.toThrow("store unavailable");
    expect(await resolveSecret(binding)).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("undefined を返す binding は null に倒す (未設定と同じ扱い)", async () => {
    const binding = { async get() { return undefined as unknown as string; } };
    expect(await resolveSecret(binding)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dev端末の区別 (Refs ippoan/alc-app#387)
//
// **dev かどうかは introspect の `dev_device === true` だけで決まる。** 端末の
// 申告 (frame / body / ヘッダー) は見ない。dev のときだけ backend への転送に
// `X-Device-Dev: 1` が付き、打刻の合図は dev の購読者にだけ届く。
//
// **専用テナント (`tenant-dev`)** — isolatedStorage: false なので他 test の
// 購読が混ざると「どちらの側に届いたか」を判定できない。
// ---------------------------------------------------------------------------

describe("dev端末の区別", () => {
  const timecardFrame = (seq: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "measurement",
      seq,
      kind: "timecard",
      payload: { card_id: `CARD-${seq}`, card_kind: "felica_idm" },
      ...extra,
    });

  /** dev の購読者 (キオスク) と本番の購読者 (管理者) を 1 本ずつ張る。 */
  async function connectBothWatchers() {
    const dev = await connectWatcher("kiosk-token-dev");
    expect(dev.res.status).toBe(101);
    openSockets.push(dev.ws!);
    const prod = await connectWatcher("admin-token-dev-prod");
    expect(prod.res.status).toBe(101);
    openSockets.push(prod.ws!);
    return { dev: messageQueue(dev.ws!), prod: messageQueue(prod.ws!) };
  }

  function punchWithDevHeader(value: string | null) {
    const headers: Record<string, string> = {
      Authorization: SHARED_SECRET,
      "Content-Type": "application/json",
    };
    if (value !== null) headers["X-Device-Dev"] = value;
    return SELF.fetch(`${BASE}/tenants/tenant-dev/devices/device-kiosk-dev/timecard-punch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ card_id: "BROWSER" }),
    });
  }

  it("isDevIntrospect: `=== true` のときだけ dev (欄なし / false / 文字列 / 数値は本番)", () => {
    expect(isDevIntrospect({ active: true, dev_device: true })).toBe(true);
    expect(isDevIntrospect({ active: true, dev_device: false })).toBe(false);
    expect(isDevIntrospect({ active: true })).toBe(false);
    expect(isDevIntrospect({ active: true, dev_device: "true" })).toBe(false);
    expect(isDevIntrospect({ active: true, dev_device: 1 })).toBe(false);
    expect(isDevIntrospect(null)).toBe(false);
    expect(isDevIntrospect(undefined)).toBe(false);
  });

  it("★ WS: dev端末の測定は X-Device-Dev: 1 付きで転送される", async () => {
    const { ws, messages } = await connectAccepted("hub-token-dev");
    openSockets.push(ws);
    ws.send(JSON.stringify({ type: "measurement", seq: 1, kind: "alcohol", payload: { value: 0 } }));
    expect(await messages.next()).toEqual({ type: "ack", seq: 1 });

    const calls = await spyIngest();
    expect(calls.length).toBe(1);
    expect(calls[0].dev).toBe("1");
    expect(calls[0].tenantId).toBe("tenant-dev");
    expect(calls[0].items[0].device_id).toBe("device-dev");
  });

  it("★ WS: dev でない端末 (false / 欄なし / 文字列の \"true\") はヘッダー自体が付かない", async () => {
    for (const token of ["hub-token-dev-prod", "hub-token-1", "hub-token-dev-string"]) {
      const { ws, messages } = await connectAccepted(token);
      openSockets.push(ws);
      ws.send(JSON.stringify({ type: "measurement", seq: 2, kind: "alcohol", payload: { value: 0 } }));
      expect(await messages.next()).toEqual({ type: "ack", seq: 2 });
    }
    const calls = await spyIngest();
    expect(calls.length).toBe(3);
    expect(calls.map((c) => c.dev)).toEqual([null, null, null]);
  });

  it("★ WS: 端末が frame やヘッダーで dev を名乗っても、introspect が dev でなければ付かない", async () => {
    const res = await SELF.fetch(`${BASE}/ws`, {
      headers: {
        Upgrade: "websocket",
        Authorization: "Bearer hub-token-dev-prod",
        // worker → DO の内部ヘッダーと、backend 向けのヘッダーの両方を騙る
        "X-Recorder-Dev": "1",
        "X-Device-Dev": "1",
      },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    openSockets.push(ws);
    const messages = messageQueue(ws);
    expect(await messages.next()).toEqual({ type: "connected" });

    ws.send(
      JSON.stringify({
        type: "measurement",
        seq: 3,
        kind: "alcohol",
        dev: true,
        dev_device: true,
        payload: { value: 0, dev_device: true },
      }),
    );
    expect(await messages.next()).toEqual({ type: "ack", seq: 3 });

    const calls = await spyIngest();
    expect(calls.length).toBe(1);
    expect(calls[0].dev).toBeNull();
  });

  it("★ POST /measurements: dev端末は X-Device-Dev: 1、dev でなければ無い (body の申告は効かない)", async () => {
    const post = (token: string, extraHeaders: Record<string, string> = {}) =>
      SELF.fetch(`${BASE}/measurements`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...extraHeaders,
        },
        body: JSON.stringify([
          { seq: 4, kind: "alcohol", dev_device: true, payload: { value: 0, dev_device: true } },
        ]),
      });

    expect((await post("hub-token-dev")).status).toBe(200);
    expect((await post("hub-token-dev-prod", { "X-Device-Dev": "1" })).status).toBe(200);
    expect((await post("hub-token-1")).status).toBe(200);

    const calls = await spyIngest();
    expect(calls.map((c) => c.dev)).toEqual(["1", null, null]);
  });

  it("crash_log は dev端末でも従来どおり R2 に保存し、backend へは転送しない", async () => {
    const { ws, messages } = await connectAccepted("hub-token-dev");
    openSockets.push(ws);
    ws.send(
      JSON.stringify({
        type: "measurement",
        seq: 55,
        kind: "crash_log",
        payload: { reset_reason: "panic", log: "PANIC\n" },
      }),
    );
    expect(await messages.next()).toEqual({ type: "ack", seq: 55 });
    expect(await spyIngest()).toEqual([]);
    expect(await env.CRASH_LOGS.get("tenant-dev/device-dev/000000000055.json")).not.toBeNull();
  });

  it("★ 合図: dev端末の打刻は dev の購読者にだけ届く", async () => {
    const watchers = await connectBothWatchers();
    const device = await connectAccepted("hub-token-dev");
    openSockets.push(device.ws);

    device.ws.send(timecardFrame(10));
    expect(await device.messages.next()).toEqual({ type: "ack", seq: 10 });
    expect(await watchers.dev.next()).toEqual({ type: "timecard_punch" });
    await new Promise((r) => setTimeout(r, 300));
    expect(watchers.prod.pending()).toBe(0);

    expect((await spyIngest())[0].dev).toBe("1");
  });

  it("★ 合図: 本番の端末の打刻は本番の購読者にだけ届く (frame で dev を名乗っても同じ)", async () => {
    const watchers = await connectBothWatchers();
    const device = await connectAccepted("hub-token-dev-prod");
    openSockets.push(device.ws);

    device.ws.send(timecardFrame(11, { dev: true, dev_device: true }));
    expect(await device.messages.next()).toEqual({ type: "ack", seq: 11 });
    expect(await watchers.prod.next()).toEqual({ type: "timecard_punch" });
    await new Promise((r) => setTimeout(r, 300));
    expect(watchers.dev.pending()).toBe(0);

    expect((await spyIngest())[0].dev).toBeNull();
  });

  it("★ ブラウザ打刻: X-Device-Dev: 1 付きは dev 側 (転送にもヘッダーが付く)", async () => {
    const watchers = await connectBothWatchers();
    const res = await punchWithDevHeader("1");
    expect(res.status).toBe(202);
    expect(await watchers.dev.next()).toEqual({ type: "timecard_punch" });
    await new Promise((r) => setTimeout(r, 300));
    expect(watchers.prod.pending()).toBe(0);

    const calls = await spyIngest();
    expect(calls.length).toBe(1);
    expect(calls[0].dev).toBe("1");
  });

  it("★ ブラウザ打刻: ヘッダー無し / \"true\" / \"0\" は本番側 (ちょうど \"1\" だけが dev)", async () => {
    const watchers = await connectBothWatchers();
    for (const value of [null, "true", "0"]) {
      const res = await punchWithDevHeader(value);
      expect(res.status).toBe(202);
      expect(await watchers.prod.next()).toEqual({ type: "timecard_punch" });
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(watchers.dev.pending()).toBe(0);

    const calls = await spyIngest();
    expect(calls.map((c) => c.dev)).toEqual([null, null, null]);
  });

  it("★ 購読者がヘッダーで dev を騙っても、introspect が dev でなければ本番側のまま", async () => {
    const forged = await SELF.fetch(`${BASE}/watch-timecard`, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "alc.timecard.v1, admin-token-dev-prod",
        "X-Recorder-Dev": "1",
        "X-Device-Dev": "1",
      },
    });
    expect(forged.status).toBe(101);
    openSockets.push(forged.webSocket!);
    const queue = messageQueue(forged.webSocket!);

    // dev の打刻は届かない
    expect((await punchWithDevHeader("1")).status).toBe(202);
    await new Promise((r) => setTimeout(r, 300));
    expect(queue.pending()).toBe(0);
    // 本番の打刻は届く
    expect((await punchWithDevHeader(null)).status).toBe(202);
    expect(await queue.next()).toEqual({ type: "timecard_punch" });
  });

  it("dev は WS attachment に持つ (hibernation をまたいで残る)。本番の attachment には欄が無い", async () => {
    await connectBothWatchers();
    const devDevice = await connectAccepted("hub-token-dev");
    openSockets.push(devDevice.ws);
    const prodDevice = await connectAccepted("hub-token-dev-prod");
    openSockets.push(prodDevice.ws);

    const stub = hubStub(env, "tenant-dev");
    await runInDurableObject(stub, (_instance, state) => {
      // 購読者: tag は dev / 本番のどちらか片方、attachment にも同じ区別が残る
      const devWatchers = state.getWebSockets("watch:timecard:dev");
      expect(devWatchers.length).toBeGreaterThan(0);
      for (const ws of devWatchers) {
        expect(ws.deserializeAttachment()).toEqual({ tenantId: "tenant-dev", dev: true });
        expect(state.getTags(ws)).not.toContain("watch:timecard");
      }
      const prodWatchers = state.getWebSockets("watch:timecard");
      expect(prodWatchers.length).toBeGreaterThan(0);
      for (const ws of prodWatchers) {
        expect(ws.deserializeAttachment()).toEqual({ tenantId: "tenant-dev" });
        expect(state.getTags(ws)).not.toContain("watch:timecard:dev");
      }
      // 端末: webSocketMessage は毎回この attachment から dev を読む
      expect(state.getWebSockets("device:device-dev")[0].deserializeAttachment()).toEqual({
        tenantId: "tenant-dev",
        deviceId: "device-dev",
        dev: true,
      });
      expect(state.getWebSockets("device:device-dev-prod")[0].deserializeAttachment()).toEqual({
        tenantId: "tenant-dev",
        deviceId: "device-dev-prod",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 端末の指定つきの更新の合図 / キオスクからの報告 (Refs ippoan/alc-app#403)
//
// CoreS3 のファームを 1 台ずつ更新するための 3 つ:
//   1. `POST /tenants/:t/serial-ota` の合図に `device_id` を載せる
//   2. `POST /tenants/:t/ota-report` でキオスクからの報告を DO storage に保存する
//   3. `GET  /tenants/:t/ota-status` で保存した報告の一覧を返す
//
// **テナントは test ごとに分ける** — isolatedStorage: false なので DO storage が
// test 間で残り、件数や並びを数える test が互いに汚染される。
// ---------------------------------------------------------------------------

const OTA_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** キオスクからの報告を保存する内部 API (alc-app の server route と同じ形)。 */
function otaReportViaHttp(
  tenantId: string,
  body: unknown,
  authHeader: string | null = SHARED_SECRET,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader !== null) headers.Authorization = authHeader;
  return SELF.fetch(`${BASE}/tenants/${tenantId}/ota-report`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 保存した報告の一覧を引く内部 API。 */
function otaStatusViaHttp(tenantId: string, authHeader: string | null = SHARED_SECRET) {
  const headers: Record<string, string> = {};
  if (authHeader !== null) headers.Authorization = authHeader;
  return SELF.fetch(`${BASE}/tenants/${tenantId}/ota-status`, { headers });
}

type OtaDevice = Record<string, unknown> & { device_id: string; reported_at_ms: number };

async function otaDevices(tenantId: string): Promise<OtaDevice[]> {
  const res = await otaStatusViaHttp(tenantId);
  expect(res.status).toBe(200);
  return ((await res.json()) as { devices: OtaDevice[] }).devices;
}

/** DO storage に報告を直接置く (時刻を指定したい test 用)。 */
async function seedOtaState(tenantId: string, deviceId: string, reportedAtMs: number) {
  await runInDurableObject(hubStub(env, tenantId), async (_instance, state) => {
    await state.storage.put(`ota-state:${deviceId}`, {
      device_id: deviceId,
      kind: "cores3",
      phase: "idle",
      reported_at_ms: reportedAtMs,
    });
  });
}

describe("serial-ota の合図: 端末の指定", () => {
  it("★ cores3 が通り、device_id は在るときだけ合図に載る (無ければ key ごと無い)。不正な device_id は 400 で何も送らない", async () => {
    const { ws: kioskWs } = await connectWatcher("kiosk-token-ota-4");
    expect(kioskWs).not.toBeNull();
    openSockets.push(kioskWs!);
    const kiosk = messageQueue(kioskWs!);

    // device_id つき: 合図に device_id が載る
    const withId = await serialOtaViaHttp("tenant-ota-4", { target: "cores3", device_id: "hub_A-01" });
    expect(withId.status).toBe(200);
    expect(await withId.json()).toEqual({ sent: 1 });
    expect(await kiosk.next()).toStrictEqual({
      type: "serial_ota",
      target: "cores3",
      device_id: "hub_A-01",
    });

    // 長さの上限ちょうど (64 文字) は通る
    const longest = "a".repeat(64);
    const atLimit = await serialOtaViaHttp("tenant-ota-4", { target: "cores3", device_id: longest });
    expect(atLimit.status).toBe(200);
    expect(await kiosk.next()).toStrictEqual({
      type: "serial_ota",
      target: "cores3",
      device_id: longest,
    });

    // device_id 無し: 今までどおりの形 (**device_id の key が無い**)
    for (const target of ["cores3", "timecard-station"]) {
      const res = await serialOtaViaHttp("tenant-ota-4", { target });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: 1 });
      const message = (await kiosk.next()) as Record<string, unknown>;
      expect(Object.keys(message).sort()).toEqual(["target", "type"]);
      expect(message).toStrictEqual({ type: "serial_ota", target });
    }

    // 不正な device_id (長すぎ・記号・空・文字列でない) は 400 で、合図は 1 本も出ない
    const invalidIds: unknown[] = ["a".repeat(65), "bad id", "bad/id", "bad.id", "", 123, null, ["x"]];
    for (const deviceId of invalidIds) {
      const res = await serialOtaViaHttp("tenant-ota-4", { target: "cores3", device_id: deviceId });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_device_id" });
    }
    // allowlist 外は device_id が正しくても今までどおり invalid_target
    const badTarget = await serialOtaViaHttp("tenant-ota-4", { target: "not-allowed", device_id: "hub_A-01" });
    expect(badTarget.status).toBe(400);
    expect(await badTarget.json()).toEqual({ error: "invalid_target" });

    await new Promise((r) => setTimeout(r, 300));
    expect(kiosk.pending()).toBe(0);
  });

  it("isOtaDeviceId は英数字・`-`・`_` の 1〜64 文字だけを通す", () => {
    expect(isOtaDeviceId("hub_A-01")).toBe(true);
    expect(isOtaDeviceId("a")).toBe(true);
    expect(isOtaDeviceId("a".repeat(64))).toBe(true);
    expect(isOtaDeviceId("a".repeat(65))).toBe(false);
    expect(isOtaDeviceId("")).toBe(false);
    expect(isOtaDeviceId("a b")).toBe(false);
    expect(isOtaDeviceId("a\n")).toBe(false);
    expect(isOtaDeviceId("端末")).toBe(false);
    expect(isOtaDeviceId(1)).toBe(false);
    expect(isOtaDeviceId(undefined)).toBe(false);
  });
});

describe("parseOtaReport", () => {
  const base = { device_id: "hub-1", kind: "cores3", phase: "idle" };

  it("必須だけの報告を通し、無い値は key ごと持たない", () => {
    expect(parseOtaReport(base)).toStrictEqual({ ok: true, report: base });
  });

  it("phase は決めた 8 つだけを通す", () => {
    const phases = [
      "idle",
      "downloading",
      "writing",
      "rebooting",
      "confirming",
      "done",
      "failed",
      "skipped",
    ];
    for (const phase of phases) {
      expect(parseOtaReport({ ...base, phase })).toStrictEqual({
        ok: true,
        report: { ...base, phase },
      });
    }
    for (const phase of ["unknown", "", "IDLE", 1, null, undefined]) {
      expect(parseOtaReport({ ...base, phase })).toEqual({ ok: false, error: "invalid_phase" });
    }
  });

  it("必須の形が外れた報告は弾く", () => {
    for (const body of [null, undefined, "text", 1, [base]]) {
      expect(parseOtaReport(body)).toEqual({ ok: false, error: "invalid_body" });
    }
    for (const deviceId of [undefined, "", "bad id", "a".repeat(65), 1]) {
      expect(parseOtaReport({ ...base, device_id: deviceId })).toEqual({
        ok: false,
        error: "invalid_device_id",
      });
    }
    for (const kind of [undefined, "", "k".repeat(33), 1]) {
      expect(parseOtaReport({ ...base, kind })).toEqual({ ok: false, error: "invalid_kind" });
    }
    expect(parseOtaReport({ ...base, kind: "k".repeat(32) }).ok).toBe(true);
  });

  it("任意の欄は形が合うものだけ残す (外れた欄だけ捨て、報告は通す)", () => {
    const full = {
      ...base,
      board: "cores3",
      flavor: "",
      version: "v".repeat(64),
      target_version: "1.2.4",
      pct: 100,
      reason: "ok",
    };
    expect(parseOtaReport(full)).toStrictEqual({ ok: true, report: full });
    expect(parseOtaReport({ ...base, pct: 0 })).toStrictEqual({
      ok: true,
      report: { ...base, pct: 0 },
    });
    expect(
      parseOtaReport({
        ...base,
        board: 1,
        flavor: null,
        version: "v".repeat(65),
        target_version: ["1"],
        reason: { text: "x" },
      }),
    ).toStrictEqual({ ok: true, report: base });
    for (const pct of [-1, 101, 1.5, "50", null, Number.NaN]) {
      expect(parseOtaReport({ ...base, pct })).toStrictEqual({ ok: true, report: base });
    }
  });

  it("未知の key は取り出さない", () => {
    expect(
      parseOtaReport({ ...base, tenant_id: "other", reported_at_ms: 1, extra: { nested: true } }),
    ).toStrictEqual({ ok: true, report: base });
  });
});

describe("ota-report / ota-status", () => {
  it("shared secret 無し / 不一致は 401 で、何も保存されない", async () => {
    const body = { device_id: "hub-1", kind: "cores3", phase: "idle" };
    expect((await otaReportViaHttp("tenant-otarep-auth", body, null)).status).toBe(401);
    expect((await otaReportViaHttp("tenant-otarep-auth", body, "wrong-secret")).status).toBe(401);
    expect((await otaStatusViaHttp("tenant-otarep-auth", null)).status).toBe(401);
    const wrong = await otaStatusViaHttp("tenant-otarep-auth", "wrong-secret");
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "unauthorized" });

    expect(await otaDevices("tenant-otarep-auth")).toEqual([]);
  });

  it("報告を保存し、一覧に出す", async () => {
    const body = {
      device_id: "hub-1",
      kind: "cores3",
      board: "cores3",
      flavor: "prod",
      version: "1.2.3",
      target_version: "1.2.4",
      phase: "writing",
      pct: 42,
      reason: "",
    };
    const before = Date.now();
    const res = await otaReportViaHttp("tenant-otarep-ok", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const after = Date.now();

    const devices = await otaDevices("tenant-otarep-ok");
    expect(devices).toStrictEqual([{ ...body, reported_at_ms: expect.any(Number) }]);
    expect(devices[0].reported_at_ms).toBeGreaterThanOrEqual(before);
    expect(devices[0].reported_at_ms).toBeLessThanOrEqual(after);
  });

  it("無い値は一覧でも key ごと無い", async () => {
    const res = await otaReportViaHttp("tenant-otarep-min", {
      device_id: "hub-1",
      kind: "cores3",
      phase: "idle",
    });
    expect(res.status).toBe(200);
    const devices = await otaDevices("tenant-otarep-min");
    expect(devices.length).toBe(1);
    expect(Object.keys(devices[0]).sort()).toEqual(["device_id", "kind", "phase", "reported_at_ms"]);
  });

  it("同じ device_id の報告は上書きする (前の報告の欄は残らない)", async () => {
    const first = await otaReportViaHttp("tenant-otarep-over", {
      device_id: "hub-1",
      kind: "cores3",
      version: "1.2.3",
      phase: "writing",
      pct: 10,
    });
    expect(first.status).toBe(200);
    const second = await otaReportViaHttp("tenant-otarep-over", {
      device_id: "hub-1",
      kind: "cores3",
      version: "1.2.4",
      phase: "done",
    });
    expect(second.status).toBe(200);

    const devices = await otaDevices("tenant-otarep-over");
    expect(devices).toStrictEqual([
      {
        device_id: "hub-1",
        kind: "cores3",
        version: "1.2.4",
        phase: "done",
        reported_at_ms: expect.any(Number),
      },
    ]);
  });

  it("必須欠け・未知の phase・JSON 不正は 400 で、保存されない", async () => {
    const cases: Array<[unknown, string]> = [
      [{ kind: "cores3", phase: "idle" }, "invalid_device_id"],
      [{ device_id: "bad id", kind: "cores3", phase: "idle" }, "invalid_device_id"],
      [{ device_id: "a".repeat(65), kind: "cores3", phase: "idle" }, "invalid_device_id"],
      [{ device_id: "hub-1", phase: "idle" }, "invalid_kind"],
      [{ device_id: "hub-1", kind: "k".repeat(33), phase: "idle" }, "invalid_kind"],
      [{ device_id: "hub-1", kind: "cores3" }, "invalid_phase"],
      [{ device_id: "hub-1", kind: "cores3", phase: "exploding" }, "invalid_phase"],
      [[{ device_id: "hub-1", kind: "cores3", phase: "idle" }], "invalid_body"],
      ["null", "invalid_body"],
      ["not-json{", "invalid_json"],
    ];
    for (const [body, error] of cases) {
      const res = await otaReportViaHttp("tenant-otarep-bad", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect(await otaDevices("tenant-otarep-bad")).toEqual([]);
    await runInDurableObject(hubStub(env, "tenant-otarep-bad"), async (_instance, state) => {
      expect((await state.storage.list({ prefix: "ota-state:" })).size).toBe(0);
    });
  });

  it("未知の key と、形が外れた任意の欄は保存されない", async () => {
    const res = await otaReportViaHttp("tenant-otarep-keys", {
      device_id: "hub-1",
      kind: "cores3",
      phase: "failed",
      reason: "timeout",
      version: "v".repeat(65),
      pct: 250,
      tenant_id: "other-tenant",
      reported_at_ms: 1,
      extra: { nested: true },
    });
    expect(res.status).toBe(200);
    await runInDurableObject(hubStub(env, "tenant-otarep-keys"), async (_instance, state) => {
      const stored = await state.storage.get<Record<string, unknown>>("ota-state:hub-1");
      expect(stored).toStrictEqual({
        device_id: "hub-1",
        kind: "cores3",
        phase: "failed",
        reason: "timeout",
        reported_at_ms: expect.any(Number),
      });
      // 呼び手が名乗った時刻ではなく、受けた時刻
      expect(stored!.reported_at_ms).not.toBe(1);
    });
  });

  it("★ 201 件目の書き込みで、いちばん古い報告が消える (上書きでは消えない)", async () => {
    const tenant = "tenant-otarep-cap";
    const base = Date.now() - 60 * 60 * 1000;
    const seedId = (i: number) => `seed-${String(i).padStart(3, "0")}`;
    await runInDurableObject(hubStub(env, tenant), async (_instance, state) => {
      for (let i = 0; i < 200; i++) {
        await state.storage.put(`ota-state:${seedId(i)}`, {
          device_id: seedId(i),
          kind: "cores3",
          phase: "idle",
          reported_at_ms: base + i,
        });
      }
    });
    expect((await otaDevices(tenant)).length).toBe(200);

    // 既に在る端末の報告は上書き = 件数が増えないので、何も消えない
    const overwrite = await otaReportViaHttp(tenant, {
      device_id: seedId(5),
      kind: "cores3",
      phase: "done",
    });
    expect(overwrite.status).toBe(200);
    let ids = (await otaDevices(tenant)).map((d) => d.device_id);
    expect(ids.length).toBe(200);
    expect(ids).toContain(seedId(0));

    // 201 件目: いちばん古い 1 件 (seed-000) だけが消える
    const added = await otaReportViaHttp(tenant, { device_id: "hub-new", kind: "cores3", phase: "idle" });
    expect(added.status).toBe(200);
    ids = (await otaDevices(tenant)).map((d) => d.device_id);
    expect(ids.length).toBe(200);
    expect(ids).toContain("hub-new");
    expect(ids).not.toContain(seedId(0));
    expect(ids).toContain(seedId(1));
    await runInDurableObject(hubStub(env, tenant), async (_instance, state) => {
      expect((await state.storage.list({ prefix: "ota-state:" })).size).toBe(200);
      expect(await state.storage.get(`ota-state:${seedId(0)}`)).toBeUndefined();
    });
  });

  it("★ TTL (7 日) を過ぎた報告は一覧に出ず、次の書き込みで storage からも消える", async () => {
    const tenant = "tenant-otarep-ttl";
    const now = Date.now();
    await seedOtaState(tenant, "hub-expired", now - OTA_STATE_TTL_MS - 60_000);
    await seedOtaState(tenant, "hub-fresh", now - OTA_STATE_TTL_MS + 60 * 60 * 1000);
    await runInDurableObject(hubStub(env, tenant), async (_instance, state) => {
      // 別の prefix (command_result) は更新の報告の掃除に巻き込まれない
      await state.storage.put("cmdres:stale-but-other-prefix", { device_id: "x", payload: null });
    });

    // 一覧: TTL 内のものだけ。storage にはまだ残っている (読むだけでは消さない)
    expect((await otaDevices(tenant)).map((d) => d.device_id)).toEqual(["hub-fresh"]);
    await runInDurableObject(hubStub(env, tenant), async (_instance, state) => {
      expect(await state.storage.get("ota-state:hub-expired")).toBeDefined();
    });

    // 次の書き込みで storage から消える
    const res = await otaReportViaHttp(tenant, { device_id: "hub-new", kind: "cores3", phase: "idle" });
    expect(res.status).toBe(200);
    await runInDurableObject(hubStub(env, tenant), async (_instance, state) => {
      expect(await state.storage.get("ota-state:hub-expired")).toBeUndefined();
      expect(await state.storage.get("ota-state:hub-fresh")).toBeDefined();
      expect(await state.storage.get("cmdres:stale-but-other-prefix")).toBeDefined();
    });
    expect((await otaDevices(tenant)).map((d) => d.device_id)).toEqual(["hub-new", "hub-fresh"]);
  });

  it("一覧は reported_at_ms の新しい順", async () => {
    const tenant = "tenant-otarep-order";
    const now = Date.now();
    await seedOtaState(tenant, "hub-middle", now - 2000);
    await seedOtaState(tenant, "hub-oldest", now - 3000);
    await seedOtaState(tenant, "hub-newer", now - 1000);
    const devices = await otaDevices(tenant);
    expect(devices.map((d) => d.device_id)).toEqual(["hub-newer", "hub-middle", "hub-oldest"]);
    expect(devices.map((d) => d.reported_at_ms)).toEqual([now - 1000, now - 2000, now - 3000]);
  });

  it("別テナントの報告は出ない (DO はテナント単位)", async () => {
    const res = await otaReportViaHttp("tenant-otarep-a", {
      device_id: "hub-1",
      kind: "cores3",
      phase: "idle",
    });
    expect(res.status).toBe(200);
    expect((await otaDevices("tenant-otarep-a")).map((d) => d.device_id)).toEqual(["hub-1"]);
    expect(await otaDevices("tenant-otarep-b")).toEqual([]);
  });

  it("method が違えば 404 (ota-report は POST、ota-status は GET のみ)", async () => {
    const getReport = await SELF.fetch(`${BASE}/tenants/tenant-otarep-auth/ota-report`, {
      headers: { Authorization: SHARED_SECRET },
    });
    expect(getReport.status).toBe(404);
    const postStatus = await SELF.fetch(`${BASE}/tenants/tenant-otarep-auth/ota-status`, {
      method: "POST",
      headers: { Authorization: SHARED_SECRET },
      body: "{}",
    });
    expect(postStatus.status).toBe(404);
  });
});

describe("command_result の掃除 (prune の共用)", () => {
  it("TTL (10 分) を過ぎた command_result と時刻の無いものだけを消し、更新の報告には触れない", async () => {
    const stub = hubStub(env, "tenant-cmd");
    const now = Date.now();
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("cmdres:prune-expired", {
        device_id: "device-cmd",
        received_at_ms: now - 10 * 60 * 1000 - 60_000,
        payload: null,
      });
      await state.storage.put("cmdres:prune-no-stamp", { device_id: "device-cmd", payload: null });
      await state.storage.put("cmdres:prune-fresh", {
        device_id: "device-cmd",
        received_at_ms: now - 60_000,
        payload: null,
      });
      // command_result の TTL (10 分) は過ぎているが、更新の報告の TTL (7 日) の内
      await state.storage.put("ota-state:prune-other-prefix", {
        device_id: "prune-other-prefix",
        kind: "cores3",
        phase: "idle",
        reported_at_ms: now - 60 * 60 * 1000,
      });
    });

    const { ws } = await connectAccepted("hub-token-tenant-cmd");
    openSockets.push(ws);
    ws.send(JSON.stringify({ type: "command_result", id: "prune-trigger", payload: { ok: true } }));
    // 保存は非同期なので、書けるまで待つ (書き込みの直前に掃除が走る)
    let status = 404;
    for (let i = 0; i < 20 && status !== 200; i++) {
      const res = await SELF.fetch(`${BASE}/tenants/tenant-cmd/commands/prune-trigger/result`, {
        headers: { Authorization: SHARED_SECRET },
      });
      status = res.status;
      await res.body?.cancel();
      if (status !== 200) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status).toBe(200);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get("cmdres:prune-expired")).toBeUndefined();
      expect(await state.storage.get("cmdres:prune-no-stamp")).toBeUndefined();
      expect(await state.storage.get("cmdres:prune-fresh")).toBeDefined();
      expect(await state.storage.get("ota-state:prune-other-prefix")).toBeDefined();
    });
  });
});
