import { describe, it, expect, afterEach } from "vitest";
import { SELF } from "cloudflare:test";
import { decideCamAdminAuth, decideCamDeviceAuth, decideCamDeviceWithoutToken, CAM_DEVICE_TOKEN_REQUIRED } from "../src/auth";
import { MAX_VIEWERS } from "../src/camera-signaling-room";

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
