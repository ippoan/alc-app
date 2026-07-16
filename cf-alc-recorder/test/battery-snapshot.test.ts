import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import type { Env } from "../src/index";
import {
  fetchHubDevices,
  parseBatteryPayload,
  batterySnapshotKey,
  storeBatterySnapshot,
  runBatterySnapshotCron,
} from "../src/battery-snapshot";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const BASE = "https://alc-recorder.test";
const SHARED_SECRET = "test-shared-secret";

/** WS 接続を張る (recorder.test.ts の connect/connectAccepted と同形)。 */
async function connect(token: string): Promise<{ res: Response; ws: WebSocket | null }> {
  const res = await SELF.fetch(`${BASE}/ws`, {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
  });
  return { res, ws: res.webSocket ?? null };
}

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

async function connectAccepted(token: string) {
  const { res, ws } = await connect(token);
  expect(res.status).toBe(101);
  expect(ws).not.toBeNull();
  const messages = messageQueue(ws!);
  expect(await messages.next()).toEqual({ type: "connected" });
  return { ws: ws!, messages };
}

async function setHubDevices(devices: Array<{ tenant_id: string; device_id: string }>) {
  await env.AUTH_WORKER.fetch("https://auth-worker.internal/__spy/hub-devices", {
    method: "POST",
    body: JSON.stringify(devices),
  });
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

describe("parseBatteryPayload", () => {
  it("accepts a well-formed battery reading", () => {
    expect(parseBatteryPayload({ read: true, percent: 100, mv: 4202, vbus: false, charge: 2 })).toEqual({
      read: true,
      percent: 100,
      mv: 4202,
      vbus: false,
      charge: 2,
    });
  });

  it("keeps optional fields absent when the device didn't read power (read:false)", () => {
    expect(parseBatteryPayload({ read: false })).toEqual({ read: false });
  });

  it("drops fields with the wrong type instead of keeping bogus values", () => {
    expect(parseBatteryPayload({ read: true, percent: "100", mv: 4202 })).toEqual({
      read: true,
      mv: 4202,
    });
  });

  it("returns null for non-objects, arrays, and missing/invalid `read`", () => {
    expect(parseBatteryPayload(null)).toBeNull();
    expect(parseBatteryPayload("nope")).toBeNull();
    expect(parseBatteryPayload([])).toBeNull();
    expect(parseBatteryPayload({})).toBeNull();
    expect(parseBatteryPayload({ read: "true" })).toBeNull();
  });
});

describe("batterySnapshotKey / storeBatterySnapshot", () => {
  it("builds a {tenant}/{device}/{ms}.json key", () => {
    expect(batterySnapshotKey("tenant-1", "device-1", 1234)).toBe("tenant-1/device-1/1234.json");
  });

  it("stores the reading as JSON under that key", async () => {
    await storeBatterySnapshot(
      env.BATTERY_HISTORY,
      "tenant-1",
      "device-1",
      { read: true, percent: 88, mv: 4100, vbus: true, charge: 1 },
      555,
    );
    const obj = await env.BATTERY_HISTORY.get("tenant-1/device-1/555.json");
    expect(obj).not.toBeNull();
    const body = await obj!.json();
    expect(body).toEqual({
      tenant_id: "tenant-1",
      device_id: "device-1",
      recorded_at_ms: 555,
      read: true,
      percent: 88,
      mv: 4100,
      vbus: true,
      charge: 1,
    });
  });
});

describe("fetchHubDevices", () => {
  it("returns the devices auth-worker reports", async () => {
    await setHubDevices([{ tenant_id: "tenant-1", device_id: "device-1" }]);
    const devices = await fetchHubDevices(env.AUTH_WORKER, SHARED_SECRET);
    expect(devices).toEqual([{ tenant_id: "tenant-1", device_id: "device-1" }]);
  });

  it("returns [] on 401 (wrong secret) instead of throwing", async () => {
    const devices = await fetchHubDevices(env.AUTH_WORKER, "wrong-secret");
    expect(devices).toEqual([]);
  });

  it("filters out malformed entries", async () => {
    await env.AUTH_WORKER.fetch("https://auth-worker.internal/__spy/hub-devices", {
      method: "POST",
      body: JSON.stringify([
        { tenant_id: "t", device_id: "d" },
        { tenant_id: "t" }, // device_id 欠落
        "not-an-object",
      ]),
    });
    const devices = await fetchHubDevices(env.AUTH_WORKER, SHARED_SECRET);
    expect(devices).toEqual([{ tenant_id: "t", device_id: "d" }]);
  });
});

describe("runBatterySnapshotCron", () => {
  it("queries the connected device, and stores the battery reading to R2", async () => {
    const { ws, messages } = await connectAccepted("hub-token-tenant-cmd");
    openSockets.push(ws);
    await setHubDevices([{ tenant_id: "tenant-cmd", device_id: "device-cmd" }]);

    const cronPromise = runBatterySnapshotCron(env, SHARED_SECRET, 999);

    // 端末側に battery command が届くので、実機の代わりに command_result を返す。
    const frame = (await messages.next()) as { type: string; id: string; payload: unknown };
    expect(frame.type).toBe("command");
    expect(frame.payload).toEqual({ action: "battery" });
    ws.send(
      JSON.stringify({
        type: "command_result",
        id: frame.id,
        payload: { read: true, percent: 100, mv: 4202, vbus: false, charge: 2 },
      }),
    );

    await cronPromise;

    const obj = await env.BATTERY_HISTORY.get("tenant-cmd/device-cmd/999.json");
    expect(obj).not.toBeNull();
    const body = (await obj!.json()) as Record<string, unknown>;
    expect(body).toEqual({
      tenant_id: "tenant-cmd",
      device_id: "device-cmd",
      recorded_at_ms: 999,
      read: true,
      percent: 100,
      mv: 4202,
      vbus: false,
      charge: 2,
    });
  });

  it("silently skips a device that isn't connected (no R2 object written)", async () => {
    await setHubDevices([{ tenant_id: "tenant-cmd", device_id: "no-such-device" }]);
    await runBatterySnapshotCron(env, SHARED_SECRET, 42);
    const listed = await env.BATTERY_HISTORY.list({ prefix: "tenant-cmd/no-such-device/" });
    expect(listed.objects).toHaveLength(0);
  });

  it("does nothing when auth-worker reports no hub devices", async () => {
    await expect(runBatterySnapshotCron(env, SHARED_SECRET, 1)).resolves.toBeUndefined();
  });
});
