import { describe, it, expect, afterEach } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/index";
import { decideDevDevice, DEV_HEADER } from "../src/auth";

/**
 * 通話の待ち受けに dev の区別を入れる (Refs ippoan/alc-app#387)。
 *
 * dev端末 (開発用の鍵) が入った部屋は、dev の鍵の購読者・admin にだけ見える。
 * token を付けない接続は dev でないものとして従来どおりに動く。
 */

const BASE = "https://alc-signaling.test";
const BACKEND = "https://backend.test";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Queue {
  ws: WebSocket;
  all: unknown[];
  closed: Promise<{ code: number; reason: string }>;
}

/** 受信メッセージを全部ためる (rooms_updated は何度も来るので、順番ではなく内容で見る)。 */
function collect(ws: WebSocket): Queue {
  const all: unknown[] = [];
  ws.addEventListener("message", (event) => {
    const data = (event as MessageEvent).data as string;
    try {
      all.push(JSON.parse(data));
    } catch {
      all.push(data);
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (event) => {
      const e = event as CloseEvent;
      resolve({ code: e.code, reason: e.reason });
    });
  });
  ws.accept();
  return { ws, all, closed };
}

const opened: WebSocket[] = [];
const rooms: string[] = [];
let seq = 0;

/** test ごとに重ならない部屋 id (RoomRegistry は singleton で state が test 間に残る)。 */
function newRoom(label: string): string {
  const id = `${label}-${Date.now()}-${seq++}`;
  rooms.push(id);
  return id;
}

interface ConnectOpts {
  token?: string;
  /** client が勝手に付けてくる値 (worker が捨てるはずのもの) */
  extraQuery?: string;
  extraHeaders?: Record<string, string>;
}

async function ws(path: string, opts: ConnectOpts = {}): Promise<{ res: Response; q: Queue | null }> {
  const sep = path.includes("?") ? "&" : "?";
  const query = [opts.token !== undefined ? `token=${opts.token}` : "", opts.extraQuery ?? ""]
    .filter(Boolean)
    .join("&");
  const res = await SELF.fetch(`${BASE}${path}${query ? sep + query : ""}`, {
    headers: { Upgrade: "websocket", ...(opts.extraHeaders ?? {}) },
  });
  if (!res.webSocket) return { res, q: null };
  opened.push(res.webSocket);
  return { res, q: collect(res.webSocket) };
}

const joinRoom = (roomId: string, role: "device" | "admin", opts: ConnectOpts = {}) =>
  ws(`/room/${roomId}?role=${role}`, opts);

const watch = (deviceId: string, opts: ConnectOpts = {}) =>
  ws(`/watch-rooms?device_id=${deviceId}`, opts);

async function activeRooms(token?: string, headers: Record<string, string> = {}): Promise<string[]> {
  const res = await SELF.fetch(`${BASE}/active-rooms${token !== undefined ? `?token=${token}` : ""}`, { headers });
  expect(res.status).toBe(200);
  return (await res.json<{ rooms: string[] }>()).rooms;
}

/** その購読者が受け取った部屋 id の全部 (rooms_updated の rooms + room_answered の roomId)。 */
function seenRoomIds(q: Queue): string[] {
  const ids: string[] = [];
  for (const m of q.all as Array<{ type?: string; rooms?: string[]; roomId?: string }>) {
    if (m.type === "rooms_updated") ids.push(...(m.rooms ?? []));
    if (m.type === "room_answered" && m.roomId) ids.push(m.roomId);
  }
  return ids;
}

function answeredRoomIds(q: Queue): string[] {
  return (q.all as Array<{ type?: string; roomId?: string }>)
    .filter((m) => m.type === "room_answered")
    .map((m) => m.roomId ?? "");
}

const outbound = (path: string, init?: RequestInit) => fetch(`${BACKEND}${path}`, init);
const fcmCalls = async () => (await outbound("/__spy/fcm")).json<Array<{ room_ids: string[] }>>();

/** 部屋を全部消してから FCM の記録を空にする (dev でない部屋が 0 件の状態から始める)。 */
async function cleanSlate(): Promise<void> {
  const stub = env.ROOM_REGISTRY.get(env.ROOM_REGISTRY.idFromName("registry"));
  await runInDurableObject(stub, async (_instance, state) => {
    const entries = await state.storage.list({ prefix: "room:" });
    for (const key of entries.keys()) await state.storage.delete(key);
  });
  await sleep(50);
  await outbound("/__spy/reset", { method: "POST" });
}

afterEach(async () => {
  for (const s of opened.splice(0)) {
    try {
      s.close(1000, "test done");
    } catch {
      /* already closed */
    }
  }
  for (const id of rooms.splice(0)) {
    await SELF.fetch(`${BASE}/active-rooms/${id}`, { method: "DELETE" });
  }
  await sleep(50);
});

describe("decideDevDevice (純粋関数)", () => {
  it("active でなければ 401 (dev でない側に倒さない)", () => {
    expect(decideDevDevice(null)).toBe(401);
    expect(decideDevDevice(undefined)).toBe(401);
    expect(decideDevDevice({ active: false })).toBe(401);
    expect(decideDevDevice({ active: false, dev_device: true })).toBe(401);
  });

  it("dev かどうかは dev_device === true だけで決める", () => {
    expect(decideDevDevice({ active: true, dev_device: true })).toBe(true);
    expect(decideDevDevice({ active: true, dev_device: false })).toBe(false);
    expect(decideDevDevice({ active: true })).toBe(false);
    expect(decideDevDevice({ active: true, dev_device: "true" as unknown as boolean })).toBe(false);
  });
});

describe("token を付けない接続 (従来どおり)", () => {
  it("token なしの device の部屋は token なしの購読者に配られ、dev の購読者には配られない", async () => {
    const prodWatcher = (await watch("w-prod-1")).q!;
    const devWatcher = (await watch("w-dev-1", { token: "dev-token" })).q!;
    const roomId = newRoom("prod");

    const device = await joinRoom(roomId, "device");
    expect(device.res.status).toBe(101);
    await sleep(100);

    expect(seenRoomIds(prodWatcher)).toContain(roomId);
    expect(answeredRoomIds(prodWatcher)).toContain(roomId);
    expect(seenRoomIds(devWatcher)).not.toContain(roomId);

    expect(await activeRooms()).toContain(roomId);
    expect(await activeRooms("prod-token")).toContain(roomId);
    expect(await activeRooms("dev-token")).not.toContain(roomId);
  });

  it("token なしの device と admin は従来どおり 1:1 で繋がり、SDP を中継する", async () => {
    const roomId = newRoom("prod-pair");
    const device = (await joinRoom(roomId, "device")).q!;
    const admin = await joinRoom(roomId, "admin");
    expect(admin.res.status).toBe(101);
    await sleep(50);
    expect(device.all).toContainEqual({ type: "peer_joined", role: "admin" });
    expect(admin.q!.all).toContainEqual({ type: "peer_joined", role: "device" });

    device.ws.send(JSON.stringify({ type: "sdp_offer", sdp: "offer-sdp" }));
    admin.q!.ws.send(JSON.stringify({ type: "sdp_answer", sdp: "answer-sdp" }));
    await sleep(50);
    expect(admin.q!.all).toContainEqual({ type: "sdp_offer", sdp: "offer-sdp" });
    expect(device.all).toContainEqual({ type: "sdp_answer", sdp: "answer-sdp" });

    // 同じ role の 2 本目は従来どおり 409
    expect((await joinRoom(roomId, "admin")).res.status).toBe(409);
  });

  it("dev でない部屋には dev の token の admin も入れる (参加条件は変えない)", async () => {
    const roomId = newRoom("prod-devadmin");
    await joinRoom(roomId, "device");
    expect((await joinRoom(roomId, "admin", { token: "dev-token" })).res.status).toBe(101);
  });

  it("接続直後の初期配信に、既に在る dev でない部屋が入る", async () => {
    const roomId = newRoom("prod-initial");
    await joinRoom(roomId, "device");
    await sleep(50);
    const watcher = (await watch("w-prod-initial")).q!;
    await sleep(50);
    expect((watcher.all[0] as { type: string; rooms: string[] }).type).toBe("rooms_updated");
    expect((watcher.all[0] as { rooms: string[] }).rooms).toContain(roomId);
  });
});

describe("dev の device が入った部屋", () => {
  it("dev の購読者にだけ配られ、token なしの購読者のどの経路にも id が出ない", async () => {
    const prodWatcher = (await watch("w-prod-2")).q!;
    const devWatcher = (await watch("w-dev-2", { token: "dev-token" })).q!;
    const roomId = newRoom("dev");

    const device = await joinRoom(roomId, "device", { token: "dev-token" });
    expect(device.res.status).toBe(101);
    await sleep(100);

    // rooms_updated / room_answered
    expect(seenRoomIds(devWatcher)).toContain(roomId);
    expect(answeredRoomIds(devWatcher)).toContain(roomId);
    expect(seenRoomIds(prodWatcher)).not.toContain(roomId);

    // GET /active-rooms
    expect(await activeRooms()).not.toContain(roomId);
    expect(await activeRooms("prod-token")).not.toContain(roomId);
    expect(await activeRooms("dev-token")).toContain(roomId);

    // 接続直後の初期配信
    const lateProd = (await watch("w-prod-2-late")).q!;
    const lateDev = (await watch("w-dev-2-late", { token: "dev-token" })).q!;
    await sleep(50);
    expect(seenRoomIds(lateProd)).not.toContain(roomId);
    expect((lateDev.all[0] as { rooms: string[] }).rooms).toContain(roomId);

    // /test-call* の 3 本 (テスト着信は届くが、dev の部屋 id は混ざらない)
    for (const path of ["/test-call-all", "/test-call-all-with-fcm", "/test-call/w-prod-2"]) {
      const res = await SELF.fetch(`${BASE}${path}`, { method: "POST" });
      expect(res.status).toBe(200);
      await res.text();
    }
    await sleep(50);
    const testCalls = seenRoomIds(prodWatcher).filter((id) => id.startsWith("test-call-"));
    expect(testCalls.length).toBe(3);
    expect(seenRoomIds(prodWatcher)).not.toContain(roomId);
    expect(seenRoomIds(lateProd)).not.toContain(roomId);

    // 購読者からの call_answered (dev の購読者が応答) も dev の購読者にだけ届く
    const before = answeredRoomIds(lateDev).length;
    devWatcher.ws.send(JSON.stringify({ type: "call_answered", roomId }));
    await sleep(50);
    expect(answeredRoomIds(lateDev).length).toBe(before + 1);
    expect(seenRoomIds(prodWatcher)).not.toContain(roomId);
    expect(JSON.stringify(prodWatcher.all)).not.toContain(roomId);
    expect(JSON.stringify(lateProd.all)).not.toContain(roomId);
  });

  it("テスト着信でも、dev の購読者に dev でない部屋の id が入らない (逆も)", async () => {
    const prodRoom = newRoom("tc-prod");
    const devRoom = newRoom("tc-dev");
    await joinRoom(prodRoom, "device");
    await joinRoom(devRoom, "device", { token: "dev-token" });
    await sleep(50);
    // 初期配信・rooms_updated を受け終えてから、テスト着信で届いた分だけを見る
    const prodWatcher = (await watch("w-tc-prod")).q!;
    const devWatcher = (await watch("w-tc-dev", { token: "dev-token" })).q!;
    await sleep(50);
    const prodBefore = prodWatcher.all.length;
    const devBefore = devWatcher.all.length;

    for (const path of ["/test-call-all", "/test-call-all-with-fcm", "/test-call/w-tc-dev", "/test-call/w-tc-prod"]) {
      const res = await SELF.fetch(`${BASE}${path}`, { method: "POST" });
      expect(res.status).toBe(200);
      await res.text();
    }
    await sleep(50);

    const prodCalls = prodWatcher.all.slice(prodBefore) as Array<{ type: string; rooms: string[] }>;
    const devCalls = devWatcher.all.slice(devBefore) as Array<{ type: string; rooms: string[] }>;
    expect(prodCalls.length).toBe(3);
    expect(devCalls.length).toBe(3);
    for (const call of devCalls) {
      expect(call.rooms.some((id) => id.startsWith("test-call-"))).toBe(true);
      expect(call.rooms).toContain(devRoom);
      expect(call.rooms).not.toContain(prodRoom);
    }
    for (const call of prodCalls) {
      expect(call.rooms.some((id) => id.startsWith("test-call-"))).toBe(true);
      expect(call.rooms).toContain(prodRoom);
      expect(call.rooms).not.toContain(devRoom);
    }
  });

  it("device が抜けると dev の購読者の一覧から消える", async () => {
    const devWatcher = (await watch("w-dev-leave", { token: "dev-token" })).q!;
    const roomId = newRoom("dev-leave");
    const device = (await joinRoom(roomId, "device", { token: "dev-token" })).q!;
    await sleep(50);
    expect(await activeRooms("dev-token")).toContain(roomId);
    device.ws.close(1000, "bye");
    await sleep(100);
    expect(await activeRooms("dev-token")).not.toContain(roomId);
    const last = (devWatcher.all as Array<{ type: string; rooms?: string[] }>)
      .filter((m) => m.type === "rooms_updated")
      .pop()!;
    expect(last.rooms).not.toContain(roomId);
  });

  it("token なしの admin は入れない / 本番の token の admin も入れない / dev の token の admin は入れる", async () => {
    const roomId = newRoom("dev-admin");
    const device = (await joinRoom(roomId, "device", { token: "dev-token" })).q!;

    const noToken = await joinRoom(roomId, "admin");
    expect(noToken.res.status).toBe(403);
    expect(noToken.q).toBeNull();
    expect((await joinRoom(roomId, "admin", { token: "prod-token" })).res.status).toBe(403);
    await sleep(50);
    expect(device.all).not.toContainEqual({ type: "peer_joined", role: "admin" });

    const devAdmin = await joinRoom(roomId, "admin", { token: "dev-token" });
    expect(devAdmin.res.status).toBe(101);
    await sleep(50);
    expect(device.all).toContainEqual({ type: "peer_joined", role: "admin" });
    expect(devAdmin.q!.all).toContainEqual({ type: "peer_joined", role: "device" });
  });

  it("admin が先に居る部屋に dev の device が入ると、dev でない admin が切られる", async () => {
    const roomId = newRoom("dev-kick");
    const admin = (await joinRoom(roomId, "admin")).q!;
    const device = (await joinRoom(roomId, "device", { token: "dev-token" })).q!;

    const closed = await Promise.race([admin.closed, sleep(2000).then(() => null)]);
    expect(closed).not.toBeNull();
    expect(closed!.code).toBe(1008);
    await sleep(50);

    // 切られた admin には device の参加も SDP も届かず、device にも admin が居たことにならない
    expect(admin.all).toEqual([]);
    expect(device.all).toEqual([]);

    // 空いた admin の席には dev の admin が入れる (切られた接続が席を塞がない)
    const devAdmin = await joinRoom(roomId, "admin", { token: "dev-token" });
    expect(devAdmin.res.status).toBe(101);
    await sleep(50);
    expect(device.all).toEqual([{ type: "peer_joined", role: "admin" }]);
  });

  it("admin が先に居ても、dev の admin は切られない", async () => {
    const roomId = newRoom("dev-keep");
    const admin = (await joinRoom(roomId, "admin", { token: "dev-token" })).q!;
    const device = (await joinRoom(roomId, "device", { token: "dev-token" })).q!;
    await sleep(100);
    expect(admin.all).toContainEqual({ type: "peer_joined", role: "device" });
    expect(device.all).toContainEqual({ type: "peer_joined", role: "admin" });
    expect((await joinRoom(roomId, "admin", { token: "dev-token" })).res.status).toBe(409);
  });
});

describe("着信通知 (FCM)", () => {
  it("dev の部屋だけがあるとき、fcm-notify-call は叩かれない", async () => {
    await cleanSlate();
    const roomId = newRoom("dev-fcm-only");
    await joinRoom(roomId, "device", { token: "dev-token" });
    await sleep(150);
    expect(await activeRooms("dev-token")).toContain(roomId);
    expect(await fcmCalls()).toEqual([]);
  });

  it("dev と dev でない部屋が両方あるとき、room_ids に dev の部屋が入らない", async () => {
    await cleanSlate();
    const prodRoom = newRoom("prod-fcm");
    const devRoom = newRoom("dev-fcm");
    await joinRoom(prodRoom, "device");
    await joinRoom(devRoom, "device", { token: "dev-token" });
    await sleep(150);
    const calls = await fcmCalls();
    // 部屋が増えるたびに叩かれる (従来どおり): prod の登録で 1 回、dev の登録で 1 回
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.room_ids).toEqual([prodRoom]);
    }
  });
});

describe("検証に落ちる token (dev でない側に倒さない)", () => {
  for (const [label, token] of [
    ["期限切れ / 不正", "expired-token"],
    ["introspect の失敗", "boom"],
    ["空文字", ""],
  ] as const) {
    it(`${label}: /room・/watch-rooms・/active-rooms のどれでも拒否される`, async () => {
      const roomId = newRoom("rejected");

      const room = await joinRoom(roomId, "device", { token });
      expect(room.res.status).toBe(401);
      expect(room.q).toBeNull();

      const admin = await joinRoom(roomId, "admin", { token });
      expect(admin.res.status).toBe(401);

      const watcher = await ws("/watch-rooms?device_id=w-rejected", { token });
      expect(watcher.res.status).toBe(401);
      expect(watcher.q).toBeNull();

      const list = await SELF.fetch(`${BASE}/active-rooms?token=${token}`);
      expect(list.status).toBe(401);
      expect(list.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(await list.text()).toBe("Unauthorized");

      // 拒否された device は部屋として登録されていない (本番側にも dev 側にも)
      expect(await activeRooms()).not.toContain(roomId);
      expect(await activeRooms("dev-token")).not.toContain(roomId);
    });
  }
});

describe("旧形式 (数値) の登録値", () => {
  it("dev でない部屋として扱われる", async () => {
    const roomId = newRoom("legacy");
    const stub = env.ROOM_REGISTRY.get(env.ROOM_REGISTRY.idFromName("registry"));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(`room:${roomId}`, Date.now());
    });
    expect(await activeRooms()).toContain(roomId);
    expect(await activeRooms("dev-token")).not.toContain(roomId);

    const prodWatcher = (await watch("w-legacy")).q!;
    const devWatcher = (await watch("w-legacy-dev", { token: "dev-token" })).q!;
    await sleep(50);
    expect(seenRoomIds(prodWatcher)).toContain(roomId);
    expect(seenRoomIds(devWatcher)).not.toContain(roomId);
  });

  it("新形式は { ts, dev } で保存される", async () => {
    const prodRoom = newRoom("shape-prod");
    const devRoom = newRoom("shape-dev");
    await joinRoom(prodRoom, "device");
    await joinRoom(devRoom, "device", { token: "dev-token" });
    const stub = env.ROOM_REGISTRY.get(env.ROOM_REGISTRY.idFromName("registry"));
    const [prod, dev] = await runInDurableObject(stub, async (_instance, state) => [
      await state.storage.get<{ ts: number; dev: boolean }>(`room:${prodRoom}`),
      await state.storage.get<{ ts: number; dev: boolean }>(`room:${devRoom}`),
    ]);
    expect(prod).toEqual({ ts: expect.any(Number), dev: false });
    expect(dev).toEqual({ ts: expect.any(Number), dev: true });
  });
});

describe("client が dev を名乗る値を付けても、検証結果が優先される", () => {
  const claim: ConnectOpts = { extraQuery: "dev=1&dev_device=true", extraHeaders: { [DEV_HEADER]: "1" } };

  it("token なし + 同名ヘッダ: 購読者は dev の部屋を見られず、device は dev でない部屋として登録される", async () => {
    const devRoom = newRoom("claim-dev");
    await joinRoom(devRoom, "device", { token: "dev-token" });
    await sleep(50);

    const liar = (await watch("w-liar", claim)).q!;
    await sleep(50);
    expect(seenRoomIds(liar)).not.toContain(devRoom);
    expect(await activeRooms(undefined, { [DEV_HEADER]: "1" })).not.toContain(devRoom);

    // dev の部屋の admin にもなれない
    expect((await joinRoom(devRoom, "admin", claim)).res.status).toBe(403);

    // device として名乗っても dev の部屋にならない (本番側に見える)
    const liarRoom = newRoom("claim-liar");
    await joinRoom(liarRoom, "device", claim);
    await sleep(50);
    expect(await activeRooms()).toContain(liarRoom);
    expect(await activeRooms("dev-token")).not.toContain(liarRoom);
  });

  it("本番の token + 同名ヘッダ / dev_device が true 以外の値: dev にならない", async () => {
    const devRoom = newRoom("claim-dev2");
    await joinRoom(devRoom, "device", { token: "dev-token" });
    await sleep(50);
    const prodLiar = (await watch("w-liar2", { ...claim, token: "prod-token" })).q!;
    const truthy = (await watch("w-truthy", { token: "truthy-token" })).q!;
    await sleep(50);
    expect(seenRoomIds(prodLiar)).not.toContain(devRoom);
    expect(seenRoomIds(truthy)).not.toContain(devRoom);
  });

  it("dev の token + 「dev でない」と名乗るヘッダ: dev のまま (本番側に倒れない)", async () => {
    const roomId = newRoom("claim-down");
    await joinRoom(roomId, "device", { token: "dev-token", extraHeaders: { [DEV_HEADER]: "0" } });
    await sleep(50);
    expect(await activeRooms()).not.toContain(roomId);
    expect(await activeRooms("dev-token")).toContain(roomId);
  });
});

describe("画面共有の終了 (end_share)", () => {
  const END = JSON.stringify({ type: "end_share" });
  const UNKNOWN = { type: "error", message: "Unknown message type: end_share" };

  it("admin が screen- の部屋で送ると device に届く (admin には何も返らない)", async () => {
    const roomId = newRoom("screen-end");
    const device = (await joinRoom(roomId, "device")).q!;
    const admin = (await joinRoom(roomId, "admin")).q!;
    await sleep(50);

    admin.ws.send(END);
    await sleep(50);
    expect(device.all).toContainEqual({ type: "end_share" });
    expect(admin.all).not.toContainEqual(UNKNOWN);
  });

  it("device から送っても admin に届かず、知らない type と同じ error が返る", async () => {
    const roomId = newRoom("screen-from-device");
    const device = (await joinRoom(roomId, "device")).q!;
    const admin = (await joinRoom(roomId, "admin")).q!;
    await sleep(50);

    device.ws.send(END);
    await sleep(50);
    expect(admin.all).not.toContainEqual({ type: "end_share" });
    expect(device.all).toContainEqual(UNKNOWN);
  });

  it("screen- でない部屋 (点呼の通話) では admin が送っても届かず、error が返る", async () => {
    for (const label of ["it-end", "remote-end"]) {
      const roomId = newRoom(label);
      const device = (await joinRoom(roomId, "device")).q!;
      const admin = (await joinRoom(roomId, "admin")).q!;
      await sleep(50);

      admin.ws.send(END);
      await sleep(50);
      expect(device.all).not.toContainEqual({ type: "end_share" });
      expect(admin.all).toContainEqual(UNKNOWN);
    }
  });

  it("device がまだ居ない screen- の部屋では、admin が送っても error が返るだけ", async () => {
    const roomId = newRoom("screen-no-device");
    const admin = (await joinRoom(roomId, "admin")).q!;

    admin.ws.send(END);
    await sleep(50);
    expect(admin.all).toEqual([UNKNOWN]);
  });

  it("切られた admin が送っても device に届かない", async () => {
    const roomId = newRoom("screen-kicked");
    const admin = (await joinRoom(roomId, "admin")).q!;
    // close の完了を待たずに送る (切られた印は device の参加の時点で付いている)
    const device = (await joinRoom(roomId, "device", { token: "dev-token" })).q!;
    try {
      admin.ws.send(END);
    } catch {
      /* 既に閉じていれば送れない (届かないことに変わりはない) */
    }
    await sleep(100);
    expect(device.all).toEqual([]);
    expect(admin.all).toEqual([]);
  });
});
