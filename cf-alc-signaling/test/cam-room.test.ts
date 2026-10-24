import { describe, it, expect, afterEach } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { decideCamAdminAuth, decideCamDeviceAuth, decideCamDeviceWithoutToken, CAM_DEVICE_TOKEN_REQUIRED } from "../src/auth";
import {
  CLOSE_PREEMPTED,
  CLOSE_STANDBY,
  DEVICE_STALE_MS,
  MAX_VIEWERS,
  decideDeviceEntry,
  isStaleDevice,
  parseRank,
  type CameraSignalingRoom,
} from "../src/camera-signaling-room";

/**
 * 拠点カメラ中継 (cam-room) の複数 viewer 対応 (protocol v2) と、
 * 遠隔点呼 (/room) の device_id 受け渡し。
 */

const BASE = "https://alc-signaling.test";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Queue {
  ws: WebSocket;
  all: Array<Record<string, unknown>>;
}

const opened: WebSocket[] = [];
let seq = 0;
const newRoom = (label: string) => `${label}-${Date.now()}-${seq++}`;

async function connect(path: string): Promise<{ res: Response; q: Queue | null }> {
  const res = await SELF.fetch(`${BASE}${path}`, { headers: { Upgrade: "websocket" } });
  if (!res.webSocket) return { res, q: null };
  const ws = res.webSocket;
  opened.push(ws);
  const all: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (e) => all.push(JSON.parse((e as MessageEvent).data as string)));
  ws.accept();
  return { res, q: { ws, all } };
}

const camDevice = (room: string, query = "&proto=2") => connect(`/cam-room/${room}?role=device${query}`);
const camAdmin = (room: string, token = "prod-token") => connect(`/cam-room/${room}?role=admin&token=${token}`);
const send = (q: Queue, msg: unknown) => q.ws.send(JSON.stringify(msg));

afterEach(() => {
  for (const s of opened.splice(0)) {
    try {
      s.close(1000, "test done");
    } catch {
      /* already closed */
    }
  }
});

describe("decideCamAdminAuth", () => {
  it("admin と運行管理者席の鍵は通し、viewer・他の device 鍵等は 403、非 active は 401", () => {
    expect(decideCamAdminAuth({ active: true, role: "admin" })).toBe(101);
    expect(decideCamAdminAuth({ active: true, role: "device-tenko-manager" })).toBe(101);
    expect(decideCamAdminAuth({ active: true, role: "device-kiosk" })).toBe(403);
    expect(decideCamAdminAuth({ active: true, role: "manager" })).toBe(403);
    expect(decideCamAdminAuth({ active: true, role: "viewer" })).toBe(403);
    expect(decideCamAdminAuth({ active: true })).toBe(403);
    expect(decideCamAdminAuth({ active: false })).toBe(401);
    expect(decideCamAdminAuth(null)).toBe(401);
  });

  it("WS ハンドシェイクでも席の鍵は入れ、viewer・他の device 鍵は 403", async () => {
    const room = newRoom("cam-auth");
    expect((await camAdmin(room, "seat-token")).res.status).toBe(101);
    expect((await camAdmin(room, "viewer-token")).res.status).toBe(403);
    expect((await camAdmin(room, "kiosk-token")).res.status).toBe(403);
  });
});

describe("cam-room device の鍵", () => {
  it("decideCamDeviceAuth: device-cam-host だけ通し、他の role は 403、非 active は 401", () => {
    expect(decideCamDeviceAuth({ active: true, role: "device-cam-host" })).toBe(101);
    expect(decideCamDeviceAuth({ active: true, role: "device-kiosk" })).toBe(403);
    expect(decideCamDeviceAuth({ active: true, role: "admin" })).toBe(403);
    expect(decideCamDeviceAuth({ active: true })).toBe(403);
    expect(decideCamDeviceAuth({ active: false, role: "device-cam-host" })).toBe(401);
    expect(decideCamDeviceAuth(null)).toBe(401);
  });

  it("token 無しは移行期間の間だけ通す (フラグを true にすると 401)", () => {
    expect(CAM_DEVICE_TOKEN_REQUIRED).toBe(false);
    expect(decideCamDeviceWithoutToken()).toBe(101);
    expect(decideCamDeviceWithoutToken(true)).toBe(401);
  });

  it("WS ハンドシェイク: cam-host の鍵と token 無しは入れ、他の鍵は 403・不正は 401", async () => {
    expect((await camDevice(newRoom("cam-dev-ok"), "&proto=2&token=cam-host-token")).res.status).toBe(101);
    expect((await camDevice(newRoom("cam-dev-none"))).res.status).toBe(101);
    expect((await camDevice(newRoom("cam-dev-kiosk"), "&token=kiosk-token")).res.status).toBe(403);
    expect((await camDevice(newRoom("cam-dev-admin"), "&token=prod-token")).res.status).toBe(403);
    expect((await camDevice(newRoom("cam-dev-bad"), "&token=nope")).res.status).toBe(401);
    expect((await camDevice(newRoom("cam-dev-empty"), "&token=")).res.status).toBe(401);
  });

  it("admin は token 無し・空で 401、cam-host の鍵で 403", async () => {
    const room = newRoom("cam-admin-tok");
    expect((await connect(`/cam-room/${room}?role=admin`)).res.status).toBe(401);
    expect((await camAdmin(room, "")).res.status).toBe(401);
    expect((await camAdmin(room, "cam-host-token")).res.status).toBe(403);
  });
});

describe("cam-room proto=2 (複数 viewer)", () => {
  it("admin ごとに viewer_id が発行され、device へ peer_joined / peer_left に載る", async () => {
    const room = newRoom("cam-v2");
    const device = (await camDevice(room)).q!;
    const a1 = (await camAdmin(room)).q!;
    const a2 = (await camAdmin(room, "seat-token")).q!;
    await sleep(50);

    const joined = device.all.filter((m) => m.type === "peer_joined" && m.role === "admin");
    expect(joined).toHaveLength(2);
    const [v1, v2] = joined.map((m) => m.viewer_id as string);
    expect(v1).toBeTruthy();
    expect(v2).toBeTruthy();
    expect(v1).not.toBe(v2);
    // admin 側へは viewer_id を出さない (v1 のまま)
    expect(a1.all).toContainEqual({ type: "peer_joined", role: "device" });
    expect(a2.all).toContainEqual({ type: "peer_joined", role: "device" });

    a1.ws.close(1000, "bye");
    await sleep(50);
    expect(device.all).toContainEqual({ type: "peer_left", role: "admin", viewer_id: v1 });
  });

  it("device → admin は viewer_id の相手だけに届き、viewer_id は外される。未知・無しは捨てる", async () => {
    const room = newRoom("cam-route");
    const device = (await camDevice(room)).q!;
    const a1 = (await camAdmin(room)).q!;
    const a2 = (await camAdmin(room)).q!;
    await sleep(50);
    const [v1, v2] = device.all.filter((m) => m.type === "peer_joined").map((m) => m.viewer_id as string);

    send(device, { type: "sdp_offer", viewer_id: v2, sdp: "offer-2" });
    send(device, { type: "ice_candidate", viewer_id: v1, candidate: { candidate: "c1" } });
    send(device, { type: "sdp_offer", viewer_id: "nobody", sdp: "lost" });
    send(device, { type: "sdp_offer", sdp: "lost-too" });
    await sleep(50);

    expect(a2.all).toContainEqual({ type: "sdp_offer", sdp: "offer-2" });
    expect(a1.all).toContainEqual({ type: "ice_candidate", candidate: { candidate: "c1" } });
    expect(a1.all.some((m) => m.type === "sdp_offer")).toBe(false);
    expect(a2.all.some((m) => m.type === "ice_candidate")).toBe(false);
    expect(JSON.stringify([...a1.all, ...a2.all])).not.toContain("lost");
  });

  it("admin → device は送り主の viewer_id が付く", async () => {
    const room = newRoom("cam-up");
    const device = (await camDevice(room)).q!;
    const a1 = (await camAdmin(room)).q!;
    const a2 = (await camAdmin(room)).q!;
    await sleep(50);
    const [v1, v2] = device.all.filter((m) => m.type === "peer_joined").map((m) => m.viewer_id as string);

    send(a2, { type: "sdp_answer", sdp: "ans-2" });
    send(a1, { type: "ice_candidate", candidate: { candidate: "c-up" } });
    await sleep(50);
    expect(device.all).toContainEqual({ type: "sdp_answer", sdp: "ans-2", viewer_id: v2 });
    expect(device.all).toContainEqual({ type: "ice_candidate", candidate: { candidate: "c-up" }, viewer_id: v1 });
  });

  it("device が後から入ると、既に居る admin ごとに peer_joined が届く (hibernation 後も同じ viewer_id)", async () => {
    const room = newRoom("cam-late");
    const a1 = (await camAdmin(room)).q!;

    const device = (await camDevice(room)).q!;
    await sleep(50);
    const joined = device.all.filter((m) => m.type === "peer_joined");
    expect(joined).toHaveLength(1);
    expect(joined[0].viewer_id).toBeTruthy();
    expect(a1.all).toContainEqual({ type: "peer_joined", role: "device" });

    // 先に居た admin の answer にも viewer_id が付く
    send(a1, { type: "sdp_answer", sdp: "late" });
    await sleep(50);
    expect(device.all).toContainEqual({ type: "sdp_answer", sdp: "late", viewer_id: joined[0].viewer_id });
  });

  it(`admin は ${MAX_VIEWERS} 本まで、超えると 409 "viewer limit"。抜ければ空く`, async () => {
    const room = newRoom("cam-limit");
    await camDevice(room);
    const admins: Queue[] = [];
    for (let i = 0; i < MAX_VIEWERS; i++) admins.push((await camAdmin(room)).q!);
    const over = await camAdmin(room);
    expect(over.res.status).toBe(409);
    expect(await over.res.text()).toBe("viewer limit");

    admins[0].ws.close(1000, "bye");
    await sleep(50);
    expect((await camAdmin(room)).res.status).toBe(101);
  });

  it("device が抜けると全 admin に peer_left (viewer_id 無し)", async () => {
    const room = newRoom("cam-dev-left");
    const device = (await camDevice(room)).q!;
    const a1 = (await camAdmin(room)).q!;
    await sleep(50);
    device.ws.close(1000, "bye");
    await sleep(50);
    expect(a1.all).toContainEqual({ type: "peer_left", role: "device" });
  });

  it("device は 2 本目を 409 で断る", async () => {
    const room = newRoom("cam-dev2");
    await camDevice(room);
    expect((await camDevice(room)).res.status).toBe(409);
  });
});

/** close の code (届かなければ 0) */
const closedCode = (q: Queue, ms = 1000) =>
  Promise.race([
    new Promise<number>((r) => q.ws.addEventListener("close", (e) => r((e as CloseEvent).code))),
    sleep(ms).then(() => 0),
  ]);
const rankedDevice = (room: string, rank: number, token = "cam-host-token") =>
  camDevice(room, `&proto=2&rank=${rank}&token=${token}`);

const camRoomStub = (room: string) =>
  env.CAMERA_SIGNALING_ROOM.get(env.CAMERA_SIGNALING_ROOM.idFromName(room)) as DurableObjectStub<CameraSignalingRoom>;

/** 部屋の device の attachment (tag device のもの。入れ替えで切った close 待ちの device は除く) */
async function deviceAttachments(room: string): Promise<Array<Record<string, unknown>>> {
  return runInDurableObject(camRoomStub(room), (_obj, state) =>
    state
      .getWebSockets("device")
      .map((ws) => ws.deserializeAttachment() as Record<string, unknown>)
      .filter((a) => !a.kicked),
  );
}

describe("cam-room 配信担当の順位 (?rank=)", () => {
  it("parseRank / decideDeviceEntry / isStaleDevice (純粋関数)", () => {
    expect(parseRank("1")).toBe(1);
    expect(parseRank("99")).toBe(99);
    for (const bad of ["0", "100", "-1", "1.5", "01", "", "a", " 1"]) expect(parseRank(bad)).toBeNull();

    expect(decideDeviceEntry(undefined, 1, false)).toBe("reject");
    expect(decideDeviceEntry(undefined, undefined, true)).toBe("reject");
    expect(decideDeviceEntry(1, 2, false)).toBe("preempt");
    expect(decideDeviceEntry(2, undefined, false)).toBe("preempt");
    expect(decideDeviceEntry(3, 1, true)).toBe("preempt");
    expect(decideDeviceEntry(1, 1, false)).toBe("standby");
    expect(decideDeviceEntry(2, 1, false)).toBe("standby");

    const now = 1_000_000;
    expect(isStaleDevice(now - DEVICE_STALE_MS - 1, undefined, now)).toBe(true);
    expect(isStaleDevice(now - DEVICE_STALE_MS, undefined, now)).toBe(false);
    expect(isStaleDevice(now - 10 * DEVICE_STALE_MS, now - 1000, now)).toBe(false);
    expect(isStaleDevice(undefined, undefined, now)).toBe(false);
  });

  it("rank が数でなければ 400", async () => {
    expect((await camDevice(newRoom("cam-rank-bad"), "&proto=2&rank=0")).res.status).toBe(400);
    expect((await camDevice(newRoom("cam-rank-bad"), "&proto=2&rank=x")).res.status).toBe(400);
  });

  it("rank と鍵の sub を attachment に持つ (client が付けた sub のヘッダは捨てる)", async () => {
    const room = newRoom("cam-rank-att");
    const res = await SELF.fetch(`${BASE}/cam-room/${room}?role=device&proto=2&rank=2&token=cam-host-token`, {
      headers: { Upgrade: "websocket", "X-Alc-Signaling-Device-Sub": "alarm:forged" },
    });
    expect(res.status).toBe(101);
    opened.push(res.webSocket!);
    res.webSocket!.accept();
    const [att] = await deviceAttachments(room);
    expect(att).toMatchObject({ proto: 2, rank: 2, sub: "alarm:fp-1" });
    expect(typeof att.joinedAt).toBe("number");

    // token 無し (移行期間) は sub を持たない。client のヘッダも信じない
    const room2 = newRoom("cam-rank-att-none");
    const res2 = await SELF.fetch(`${BASE}/cam-room/${room2}?role=device&proto=2&rank=1`, {
      headers: { Upgrade: "websocket", "X-Alc-Signaling-Device-Sub": "alarm:forged" },
    });
    opened.push(res2.webSocket!);
    res2.webSocket!.accept();
    const [att2] = await deviceAttachments(room2);
    expect(att2.sub).toBeUndefined();
    expect(att2.rank).toBe(1);
  });

  it("同位・下位は一度受け入れて 4011 で閉じ、配信中の device と見る人には何も起きない", async () => {
    const room = newRoom("cam-rank-standby");
    const primary = (await rankedDevice(room, 1)).q!;
    const viewer = (await camAdmin(room)).q!;
    await sleep(50);
    const viewerBefore = viewer.all.length;

    for (const rank of [2, 1]) {
      const sub = await rankedDevice(room, rank, "cam-host-token-2");
      expect(sub.res.status).toBe(101);
      expect(await closedCode(sub.q!)).toBe(CLOSE_STANDBY);
    }
    await sleep(50);
    expect(viewer.all.length).toBe(viewerBefore);
    expect(primary.all.filter((m) => m.type === "peer_joined")).toHaveLength(1);
    // 配信中の device はそのまま中継できる
    const viewerId = primary.all.find((m) => m.type === "peer_joined")!.viewer_id;
    send(primary, { type: "sdp_offer", viewer_id: viewerId, sdp: "still-primary" });
    await sleep(50);
    expect(viewer.all).toContainEqual({ type: "sdp_offer", sdp: "still-primary" });
    expect(await deviceAttachments(room)).toHaveLength(1);
  });

  it("見る人が居る最中に上位が来ると、下位を 4010 で切り、見る人に peer_left → peer_joined、新しい device から offer が届く", async () => {
    const room = newRoom("cam-rank-preempt");
    const backup = (await rankedDevice(room, 2, "cam-host-token-2")).q!;
    const backupClosed = closedCode(backup);
    const viewer = (await camAdmin(room)).q!;
    await sleep(50);
    expect(viewer.all).toEqual([{ type: "peer_joined", role: "device" }]);

    const primary = (await rankedDevice(room, 1)).q!;
    expect(await backupClosed).toBe(CLOSE_PREEMPTED);
    await sleep(50);
    // 見る人へ: 入れ替えの peer_left → 新しい device の peer_joined (切られた device の close で二重に出ない)
    expect(viewer.all).toEqual([
      { type: "peer_joined", role: "device" },
      { type: "peer_left", role: "device" },
      { type: "peer_joined", role: "device" },
    ]);
    const joined = primary.all.filter((m) => m.type === "peer_joined" && m.role === "admin");
    expect(joined).toHaveLength(1);
    send(primary, { type: "sdp_offer", viewer_id: joined[0].viewer_id, sdp: "from-primary" });
    send(viewer, { type: "sdp_answer", sdp: "answer-primary" });
    await sleep(50);
    expect(viewer.all).toContainEqual({ type: "sdp_offer", sdp: "from-primary" });
    expect(primary.all).toContainEqual({ type: "sdp_answer", sdp: "answer-primary", viewer_id: joined[0].viewer_id });
    // 切られた device の answer は届かない (送れても捨てる)
    expect(backup.all.some((m) => m.type === "sdp_answer")).toBe(false);
    expect((await deviceAttachments(room)).map((a) => a.rank)).toEqual([1]);

    // 下位は待機に回り、入り直しても 4011
    const again = (await rankedDevice(room, 2, "cam-host-token-2")).q!;
    expect(await closedCode(again)).toBe(CLOSE_STANDBY);
  });

  it("上位が抜けると、待機していた下位が入れる (入り直しで引き継ぐ)", async () => {
    const room = newRoom("cam-rank-takeover");
    const primary = (await rankedDevice(room, 1)).q!;
    const viewer = (await camAdmin(room)).q!;
    const waiting = (await rankedDevice(room, 2, "cam-host-token-2")).q!;
    expect(await closedCode(waiting)).toBe(CLOSE_STANDBY);

    primary.ws.close(1000, "down");
    await sleep(50);
    const backup = (await rankedDevice(room, 2, "cam-host-token-2")).q!;
    await sleep(50);
    expect(await closedCode(backup, 200)).toBe(0);
    expect(viewer.all).toEqual([
      { type: "peer_joined", role: "device" },
      { type: "peer_left", role: "device" },
      { type: "peer_joined", role: "device" },
    ]);
    expect(backup.all.filter((m) => m.type === "peer_joined" && m.role === "admin")).toHaveLength(1);
  });

  it("rank の無い古い拡張: 居る device がいれば 409 (今まで通り)、rank 付きの device には入れ替えられる", async () => {
    const room = newRoom("cam-rank-legacy");
    const legacy = (await camDevice(room)).q!;
    const legacyClosed = closedCode(legacy);
    expect((await camDevice(room)).res.status).toBe(409);
    await rankedDevice(room, 3);
    expect(await legacyClosed).toBe(CLOSE_PREEMPTED);
    // rank 付きが居る部屋に古い拡張は 409
    expect((await camDevice(room)).res.status).toBe(409);
  });

  it("応答の無い (keepalive が途絶えた) device は、下位の device にも入れ替えられる", async () => {
    const room = newRoom("cam-rank-stale");
    const primary = (await rankedDevice(room, 1)).q!;
    const primaryClosed = closedCode(primary);
    // 入った時刻を昔にする (ping の自動応答も無い = 電源断などで TCP だけ残った device)
    await runInDurableObject(camRoomStub(room), (_obj, state) => {
      for (const ws of state.getWebSockets("device")) {
        const att = ws.deserializeAttachment() as Record<string, unknown>;
        ws.serializeAttachment({ ...att, joinedAt: Date.now() - DEVICE_STALE_MS - 1000 });
      }
    });
    const backup = (await rankedDevice(room, 2, "cam-host-token-2")).q!;
    expect(await primaryClosed).toBe(CLOSE_PREEMPTED);
    expect(await closedCode(backup, 200)).toBe(0);
    expect((await deviceAttachments(room)).map((a) => a.rank)).toEqual([2]);
  });
});

describe("cam-room device 不在の部屋", () => {
  it(`admin は ${MAX_VIEWERS} 本まで入れ、超えると 409 "viewer limit"`, async () => {
    const room = newRoom("cam-absent");
    for (let i = 0; i < MAX_VIEWERS; i++) expect((await camAdmin(room)).res.status).toBe(101);
    const over = await camAdmin(room);
    expect(over.res.status).toBe(409);
    expect(await over.res.text()).toBe("viewer limit");
  });

  it("3 人居る部屋に v1 device が入ると、最初の 1 本だけ残り 2 本が 4009 で切られる", async () => {
    const room = newRoom("cam-absent-v1");
    const admins: Array<{ q: Queue; closed: Promise<number> }> = [];
    for (let i = 0; i < 3; i++) {
      const q = (await camAdmin(room)).q!;
      admins.push({ q, closed: new Promise((r) => q.ws.addEventListener("close", (e) => r((e as CloseEvent).code))) });
    }
    const device = (await camDevice(room, "")).q!;
    await sleep(100);

    expect(await Promise.race([admins[1].closed, sleep(1000).then(() => 0)])).toBe(4009);
    expect(await Promise.race([admins[2].closed, sleep(1000).then(() => 0)])).toBe(4009);
    expect(device.all.filter((m) => m.type === "peer_joined")).toEqual([{ type: "peer_joined", role: "admin" }]);
    expect(admins[0].q.all).toContainEqual({ type: "peer_joined", role: "device" });
    // 切られた分の peer_left は device に出ない
    expect(device.all.some((m) => m.type === "peer_left")).toBe(false);

    // 残った 1 本とは従来どおり中継できる
    send(device, { type: "sdp_offer", sdp: "o" });
    await sleep(50);
    expect(admins[0].q.all).toContainEqual({ type: "sdp_offer", sdp: "o" });
    expect(admins[1].q.all.some((m) => m.type === "sdp_offer")).toBe(false);
    // v1 device の部屋は 1 本制限に戻る
    expect((await camAdmin(room)).res.status).toBe(409);
  });

  it("3 人居る部屋に v2 device が入ると、3 人とも peer_joined が届く", async () => {
    const room = newRoom("cam-absent-v2");
    const admins: Queue[] = [];
    for (let i = 0; i < 3; i++) admins.push((await camAdmin(room)).q!);
    const device = (await camDevice(room)).q!;
    await sleep(100);

    const ids = device.all.filter((m) => m.type === "peer_joined").map((m) => m.viewer_id as string);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const a of admins) expect(a.all).toContainEqual({ type: "peer_joined", role: "device" });
  });
});

describe("cam-room proto 無し (v1 の 1:1)", () => {
  it("admin 2 本目は 409、メッセージに viewer_id は付かない", async () => {
    const room = newRoom("cam-v1");
    const device = (await camDevice(room, "")).q!;
    const admin = (await camAdmin(room)).q!;
    await sleep(50);
    expect((await camAdmin(room)).res.status).toBe(409);
    expect(device.all).toContainEqual({ type: "peer_joined", role: "admin" });

    send(device, { type: "sdp_offer", sdp: "o" });
    send(admin, { type: "sdp_answer", sdp: "a" });
    send(admin, { type: "ice_candidate", candidate: { candidate: "x" } });
    send(device, { type: "ice_candidate", candidate: { candidate: "y" } });
    await sleep(50);
    expect(admin.all).toContainEqual({ type: "sdp_offer", sdp: "o" });
    expect(admin.all).toContainEqual({ type: "ice_candidate", candidate: { candidate: "y" } });
    expect(device.all).toContainEqual({ type: "sdp_answer", sdp: "a" });
    expect(device.all).toContainEqual({ type: "ice_candidate", candidate: { candidate: "x" } });

    admin.ws.close(1000, "bye");
    await sleep(50);
    expect(device.all).toContainEqual({ type: "peer_left", role: "admin" });
  });
});

describe("遠隔点呼 /room の device_id", () => {
  const room = (id: string, role: string, extra = "") => connect(`/room/${id}?role=${role}${extra}`);

  it("device が先: 後から入った admin の peer_joined に device_id が載る", async () => {
    const id = newRoom("tenko-dev-first");
    await room(id, "device", "&device_id=kiosk-1");
    const admin = (await room(id, "admin")).q!;
    await sleep(50);
    expect(admin.all).toContainEqual({ type: "peer_joined", role: "device", device_id: "kiosk-1" });
  });

  it("admin が先: device が入ったとき admin への peer_joined に載る", async () => {
    const id = newRoom("tenko-admin-first");
    const admin = (await room(id, "admin")).q!;
    await room(id, "device", "&device_id=kiosk-2");
    await sleep(50);
    expect(admin.all).toContainEqual({ type: "peer_joined", role: "device", device_id: "kiosk-2" });
  });

  it("device の鍵の sub が自己申告の device_id より優先される", async () => {
    const id = newRoom("tenko-sub");
    const admin = (await room(id, "admin")).q!;
    await room(id, "device", "&token=kiosk-alarm-token&device_id=self-claimed");
    await sleep(50);
    expect(admin.all).toContainEqual({ type: "peer_joined", role: "device", device_id: "alarm:fp-2" });
    const late = newRoom("tenko-sub-late");
    await room(late, "device", "&token=kiosk-alarm-token");
    const admin2 = (await room(late, "admin")).q!;
    await sleep(50);
    expect(admin2.all).toContainEqual({ type: "peer_joined", role: "device", device_id: "alarm:fp-2" });
  });

  it("client が付けた sub のヘッダは捨てる / admin の鍵の sub は device_id にしない", async () => {
    const id = newRoom("tenko-forged");
    const res = await SELF.fetch(`${BASE}/room/${id}?role=device&device_id=kiosk-9`, {
      headers: { Upgrade: "websocket", "X-Alc-Signaling-Device-Sub": "alarm:forged" },
    });
    opened.push(res.webSocket!);
    res.webSocket!.accept();
    const admin = (await room(id, "admin", "&token=prod-token")).q!;
    await sleep(50);
    expect(admin.all).toContainEqual({ type: "peer_joined", role: "device", device_id: "kiosk-9" });
    expect(admin.all.some((m) => m.device_id === "prod-1")).toBe(false);
  });

  it("鍵が不正なら 401 (自己申告に倒さない)", async () => {
    expect((await room(newRoom("tenko-bad"), "device", "&token=nope&device_id=k")).res.status).toBe(401);
  });

  it("device_id が無ければ従来どおり載らない / admin の device_id は無視", async () => {
    const id = newRoom("tenko-none");
    const device = (await room(id, "device")).q!;
    const admin = (await room(id, "admin", "&device_id=ignored")).q!;
    await sleep(50);
    expect(admin.all).toContainEqual({ type: "peer_joined", role: "device" });
    expect(device.all).toContainEqual({ type: "peer_joined", role: "admin" });
  });
});
