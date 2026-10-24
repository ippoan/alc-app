import { describe, it, expect, afterEach, vi } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { KEEPALIVE_PING, KEEPALIVE_PONG } from "../src/camera-signaling-room";

/**
 * keepalive の ping を DO が起きずに返す (setWebSocketAutoResponse)。
 *
 * 拠点カメラは常時接続のまま 20 秒ごとに ping を送るので、KEEPALIVE_PING ちょうどの
 * ping では webSocketMessage が呼ばれない (= hibernate したまま) ことを確かめる。
 */

const BASE = "https://alc-signaling.test";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const opened: WebSocket[] = [];
let seq = 0;

afterEach(() => {
  for (const s of opened.splice(0)) {
    try {
      s.close(1000, "test done");
    } catch {
      /* already closed */
    }
  }
});

async function connect(path: string): Promise<{ ws: WebSocket; all: string[] }> {
  const res = await SELF.fetch(`${BASE}${path}`, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket!;
  opened.push(ws);
  const all: string[] = [];
  ws.addEventListener("message", (e) => all.push((e as MessageEvent).data as string));
  ws.accept();
  return { ws, all };
}

const rooms = [
  {
    name: "CameraSignalingRoom (/cam-room)",
    ns: () => env.CAMERA_SIGNALING_ROOM,
    path: (room: string) => `/cam-room/${room}?role=device&proto=2`,
  },
  {
    name: "SignalingRoom (/room)",
    ns: () => env.SIGNALING_ROOM,
    path: (room: string) => `/room/${room}?role=device`,
  },
];

describe.each(rooms)("$name の keepalive", ({ ns, path }) => {
  it("KEEPALIVE_PING ちょうどの ping は runtime が pong を返し、webSocketMessage に届かない", async () => {
    const room = `keepalive-${Date.now()}-${seq++}`;
    const stub = ns().get(ns().idFromName(room));
    const device = await connect(path(room));
    await sleep(50);
    device.all.length = 0;

    const spy = await runInDurableObject(stub, (instance, state) => {
      const pair = state.getWebSocketAutoResponse();
      expect(pair?.request).toBe(KEEPALIVE_PING);
      expect(pair?.response).toBe(KEEPALIVE_PONG);
      return vi.spyOn(instance as unknown as { webSocketMessage: () => Promise<void> }, "webSocketMessage");
    });

    device.ws.send(KEEPALIVE_PING);
    await sleep(50);
    expect(device.all).toEqual([KEEPALIVE_PONG]);
    expect(spy).not.toHaveBeenCalled();
    await runInDurableObject(stub, (_instance, state) => {
      const [server] = state.getWebSockets("device");
      expect(state.getWebSocketAutoResponseTimestamp(server)).toBeInstanceOf(Date);
    });

    // 文字列の違う ping (空白入り) は DO が起きて従来の ping 分岐で pong を返す (後方互換)
    device.ws.send('{ "type": "ping" }');
    await sleep(50);
    expect(device.all.map((m) => JSON.parse(m))).toEqual([{ type: "pong" }, { type: "pong" }]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

it("KEEPALIVE_PING は web の useWebRtc が送る JSON.stringify({ type: 'ping' }) と同じ文字列", () => {
  expect(KEEPALIVE_PING).toBe(JSON.stringify({ type: "ping" }));
  expect(KEEPALIVE_PONG).toBe(JSON.stringify({ type: "pong" }));
});
