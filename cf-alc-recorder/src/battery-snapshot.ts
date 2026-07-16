/**
 * CoreS3 電源/バッテリー状態の cron 定期取得 (Refs ippoan/alc-app#121)。
 *
 * `/device/setup` の手動照会 (WS command `{action:"battery"}` → `command_result`、
 * alc-app-s3/crates/hub-drivers/src/ws_uplink.rs:528) と同じ経路を DO 経由で自動化する。
 * DO が WS 接続を持っているので、対象 device の列挙以外は全て本 worker (cf-alc-recorder)
 * 内で完結させる — rust-alc-api hub_measurements は使わない (診断値であって測定データでは
 * ないため)。履歴は R2 (`BATTERY_HISTORY`) に JSON で保存し、7日で Object Lifecycle Rule
 * (bucket 側の運用設定、コードでは制御不可) により自動削除される想定。
 *
 * 対象 device (tenant_id + device_id) は auth-worker `GET /internal/hub-devices`
 * (server-to-server shared secret 認証) から取得する — cf-alc-recorder 自身は
 * tenant/device の registry を持たない。
 *
 * 未接続 device・command_result timeout は best-effort で silent skip する
 * (crash_log のような loud fail は不要 — 診断値の欠測は次周期で埋まる)。
 */

/** auth-worker `/internal/hub-devices` が返す最小限の device 参照。 */
export interface HubDeviceRef {
  tenant_id: string;
  device_id: string;
}

/** WS command `{action:"battery"}` の command_result payload (alc-app-s3 ws_uplink.rs 準拠)。 */
export interface BatteryReading {
  read: boolean;
  percent?: number;
  mv?: number;
  vbus?: boolean;
  charge?: number;
}

/** command_result 待ちのポーリング回数・間隔 (最大 3 秒程度で諦める)。 */
const POLL_ATTEMPTS = 6;
const POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * auth-worker `/internal/hub-devices` から hub device 一覧を取得する。
 * 到達不能・非 200・不正な body は空配列 (cron は best-effort、次周期に譲る)。
 */
export async function fetchHubDevices(
  authWorker: Fetcher,
  sharedSecret: string,
): Promise<HubDeviceRef[]> {
  let res: Response;
  try {
    res = await authWorker.fetch("https://auth-worker.internal/internal/hub-devices", {
      headers: { Authorization: sharedSecret },
    });
  } catch (e) {
    console.log("[battery_cron] auth-worker unreachable", e);
    return [];
  }
  if (!res.ok) {
    console.log(`[battery_cron] hub-devices fetch failed status=${res.status}`);
    return [];
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return [];
  }
  const devices = (data as { devices?: unknown })?.devices;
  if (!Array.isArray(devices)) return [];
  return devices.filter(
    (d): d is HubDeviceRef =>
      !!d &&
      typeof d === "object" &&
      typeof (d as HubDeviceRef).tenant_id === "string" &&
      typeof (d as HubDeviceRef).device_id === "string",
  );
}

/** command_result の payload を BatteryReading として検証する。形が合わなければ null。 */
export function parseBatteryPayload(payload: unknown): BatteryReading | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.read !== "boolean") return null;
  return {
    read: p.read,
    ...(typeof p.percent === "number" ? { percent: p.percent } : {}),
    ...(typeof p.mv === "number" ? { mv: p.mv } : {}),
    ...(typeof p.vbus === "boolean" ? { vbus: p.vbus } : {}),
    ...(typeof p.charge === "number" ? { charge: p.charge } : {}),
  };
}

/** R2 object key。crash_log (`crashLogKey`) と同じ tenant/device 階層 + 取得時刻 (ms)。 */
export function batterySnapshotKey(tenantId: string, deviceId: string, nowMs: number): string {
  return `${tenantId}/${deviceId}/${nowMs}.json`;
}

/** バッテリー snapshot を R2 へ保存する。 */
export async function storeBatterySnapshot(
  bucket: R2Bucket,
  tenantId: string,
  deviceId: string,
  reading: BatteryReading,
  nowMs: number,
): Promise<void> {
  const key = batterySnapshotKey(tenantId, deviceId, nowMs);
  await bucket.put(
    key,
    JSON.stringify({
      tenant_id: tenantId,
      device_id: deviceId,
      recorded_at_ms: nowMs,
      ...reading,
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
}

/** cron が呼ぶ env の部分型。 */
export interface BatteryCronEnv {
  RECORDER_HUB: DurableObjectNamespace;
  AUTH_WORKER: Fetcher;
  BATTERY_HISTORY: R2Bucket;
}

/**
 * 1 device 分の照会。未接続 (404) / 送信失敗 / command_result timeout は
 * silent skip (log のみ、例外は投げない — cron 全体を止めない)。
 */
async function snapshotOneDevice(
  env: BatteryCronEnv,
  tenantId: string,
  deviceId: string,
  nowMs: number,
): Promise<void> {
  const stub = env.RECORDER_HUB.get(env.RECORDER_HUB.idFromName(tenantId));

  let commandRes: Response;
  try {
    commandRes = await stub.fetch("https://recorder-hub.internal/command", {
      method: "POST",
      headers: { "X-Recorder-Device-Id": deviceId, "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { action: "battery" } }),
    });
  } catch (e) {
    console.log(`[battery_cron] command send failed tenant=${tenantId} device=${deviceId}`, e);
    return;
  }
  if (commandRes.status === 404) {
    return; // device not connected — silent skip (best-effort)
  }
  if (!commandRes.ok) {
    console.log(
      `[battery_cron] command send status=${commandRes.status} tenant=${tenantId} device=${deviceId}`,
    );
    return;
  }
  const { id } = (await commandRes.json()) as { id?: string };
  if (!id) return;

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    const resultRes = await stub.fetch(`https://recorder-hub.internal/command-result/${id}`);
    if (resultRes.status !== 200) continue;
    const stored = (await resultRes.json()) as { payload?: unknown };
    const reading = parseBatteryPayload(stored.payload);
    if (!reading) return;
    await storeBatterySnapshot(env.BATTERY_HISTORY, tenantId, deviceId, reading, nowMs);
    return;
  }
  console.log(`[battery_cron] command_result timeout tenant=${tenantId} device=${deviceId} id=${id}`);
}

/**
 * cron エントリポイント (`scheduled()` から呼ぶ)。shared secret 未設定なら
 * 何もしない (server_error を返す先が無いので log のみ)。
 */
export async function runBatterySnapshotCron(
  env: BatteryCronEnv,
  sharedSecret: string,
  nowMs: number,
): Promise<void> {
  const devices = await fetchHubDevices(env.AUTH_WORKER, sharedSecret);
  for (const { tenant_id, device_id } of devices) {
    await snapshotOneDevice(env, tenant_id, device_id, nowMs);
  }
}
