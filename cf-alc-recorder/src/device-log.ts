/**
 * 機体の診断ログの受け口 `POST /device-log` (Refs ippoan/alc-app-s3#352)。
 *
 * 回線を持たない Vein Station は `get_device_log` (recorder の下り `get_log`) で読めない。
 * キオスク PWA が USB で受けた Vein Station の行を時刻付きで溜め、ここへ上げる。保存先は
 * crash_log と同じ R2 (`CRASH_LOGS`) の `device-log/` の下で、backend へは転送しない。
 *
 * 送れる role は recorder に接続できる機体 ({@link RECORDER_DEVICE_ROLES})・キオスク
 * (`device-kiosk`)・運行管理者席 (`device-tenko-manager`。席の Vein Base の行を上げる)。キオスクを下り command の宛先にしない方針はそのまま — ここは上りの保存だけ。
 * tenant / 端末の ID は introspect 済みの JWT からだけ取り、本文には名乗らせない。
 */
import { DEVICE_ROLE_KIOSK, DEVICE_ROLE_TENKO_MANAGER, RECORDER_DEVICE_ROLES } from "./auth";

/** 送ってよい role */
export const DEVICE_LOG_ROLES: ReadonlySet<string> = new Set([
  ...RECORDER_DEVICE_ROLES,
  DEVICE_ROLE_KIOSK,
  DEVICE_ROLE_TENKO_MANAGER,
]);

/** どの機体のログか (本文の `source`)。自由文字列にしない */
export const DEVICE_LOG_SOURCES: ReadonlySet<string> = new Set(["vein-station", "cores3", "kiosk"]);

/** 本文 `text` の上限 (文字数)。キオスクが溜める行の上限に余裕を見た値 */
export const DEVICE_LOG_MAX_TEXT = 400_000;

/** `reason` (上げた理由の短い語) の字種と長さ */
const REASON_PATTERN = /^[\w.:-]{1,64}$/;

export interface DeviceLogBody {
  source: string;
  reason: string;
  text: string;
}

export type ParseDeviceLogResult =
  | { ok: true; body: DeviceLogBody }
  | { ok: false; error: "invalid_body" | "invalid_source" | "invalid_reason" | "invalid_text" | "text_too_large" };

/** 本文を検査する。形が違えば理由の語を返す */
export function parseDeviceLogBody(raw: unknown): ParseDeviceLogResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid_body" };
  const { source, reason, text } = raw as Record<string, unknown>;
  if (typeof source !== "string" || !DEVICE_LOG_SOURCES.has(source)) return { ok: false, error: "invalid_source" };
  if (typeof reason !== "string" || !REASON_PATTERN.test(reason)) return { ok: false, error: "invalid_reason" };
  if (typeof text !== "string" || text.length === 0) return { ok: false, error: "invalid_text" };
  if (text.length > DEVICE_LOG_MAX_TEXT) return { ok: false, error: "text_too_large" };
  return { ok: true, body: { source, reason, text } };
}

/**
 * R2 の key。`device-log/<tenant>/<端末>/<受けた時刻 13 桁>-<source>.json` — 時刻を 0 詰めにして
 * prefix 一覧が古い順に並ぶようにする
 */
export function deviceLogKey(tenantId: string, deviceId: string, receivedAtMs: number, source: string): string {
  return `device-log/${tenantId}/${deviceId}/${String(receivedAtMs).padStart(13, "0")}-${source}.json`;
}

/** 1 件を R2 へ保存して key を返す */
export async function storeDeviceLog(
  bucket: R2Bucket,
  tenantId: string,
  deviceId: string,
  dev: boolean,
  body: DeviceLogBody,
  receivedAtMs: number,
): Promise<string> {
  const key = deviceLogKey(tenantId, deviceId, receivedAtMs, body.source);
  await bucket.put(
    key,
    JSON.stringify({
      tenant_id: tenantId,
      device_id: deviceId,
      dev,
      source: body.source,
      reason: body.reason,
      received_at_ms: receivedAtMs,
      text: body.text,
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
  console.log(`[device_log] stored key=${key} reason=${body.reason} bytes=${body.text.length}`);
  return key;
}

/** 送ってよい画面の origin (キオスクの PWA。本番・staging・preview は ippoan.org の下) */
const DEVICE_LOG_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*ippoan\.org$/;

/**
 * ブラウザから送るための CORS のヘッダー。許す origin でなければ空 (ブラウザが応答を読めない)。
 * 認証は Bearer の JWT で、cookie は使わないので credentials は許さない
 */
export function deviceLogCorsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !DEVICE_LOG_ORIGIN.test(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
