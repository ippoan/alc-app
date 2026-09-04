/**
 * measurement の検証 + ingest 転送 — WS 経路 (recorder-hub.ts) と
 * `POST /measurements` (Wi-Fi 客の上り、index.ts) の共有部 (Refs ippoan/alc-app#109)。
 *
 * tenant_id / device_id は introspect 済み JWT claims からの注入のみ — ペイロード内の
 * 同名 field は信用しない (WS 経路と同じ原則)。
 */

/** 上り measurement 1 件 (JSON parse 後、field は全て untrusted)。 */
export interface MeasurementInput {
  seq?: unknown;
  recorded_at_ms?: unknown;
  kind?: unknown;
  session_id?: unknown;
  payload?: unknown;
}

/** 検証済み measurement (ingest 転送形。device_id は転送時に注入する)。 */
export interface ParsedMeasurement {
  seq: number;
  kind: string;
  recorded_at_ms: number | null;
  /** 1 回の点呼を束ねる端末発番の識別子。点呼外の単発計測では null。 */
  session_id: string | null;
  payload: Record<string, unknown>;
}

/** session_id の長さ上限 (rust-alc-api の MAX_SESSION_ID_LEN と一致)。 */
const MAX_SESSION_ID_LEN = 64;

/** rust 側 `valid_session_id` と同じ字種。端末発番の短い文字列だけを通す。 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * session_id を正規化する (Refs ippoan/alc-app-s3#112)。
 *
 * **不正値は測定ごと弾かず null に落とす。** session_id は付加情報で、これを理由に
 * 測定を落とすと点呼の記録そのものを失うため (損害が大きい方を避ける)。落とした
 * ことが後から追えるよう log を 1 行残す。上流の rust-alc-api も同じ制約で 400 を
 * 返すが、あちらは本 worker 以外の経路に対する多層防御として残す。
 */
export function normalizeSessionId(value: unknown, seq: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.length <= MAX_SESSION_ID_LEN && SESSION_ID_RE.test(value)) {
    return value;
  }
  console.log(`[measurement] dropped invalid session_id seq=${seq}`);
  return null;
}

export type ParseMeasurementResult =
  | { ok: true; item: ParsedMeasurement }
  | { ok: false; error: "invalid_seq" | "invalid_payload" | "missing_kind"; seq?: number };

/**
 * measurement 1 件を検証する (WS frame / POST body の item 共通)。
 *
 * - seq: 有限数値必須 (ack / 冪等キーの要)
 * - payload: 非配列 object 必須
 * - kind: トップレベル優先、無ければ ble-medical-gateway 互換 JSON の `payload.type` に
 *   fallback。enum 検証は rust 側 (source of truth) に任せ、ここでは空でないことだけ確認
 * - recorded_at_ms: 数値以外は null (サーバ受信時刻扱いは rust 側)
 * - session_id: 字種・長さが外れたら測定ごと弾かず null に落とす (normalizeSessionId)
 */
export function parseMeasurementItem(msg: MeasurementInput): ParseMeasurementResult {
  const seq = msg.seq;
  if (typeof seq !== "number" || !Number.isFinite(seq)) {
    return { ok: false, error: "invalid_seq" };
  }
  const payload =
    msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)
      ? (msg.payload as Record<string, unknown>)
      : null;
  if (!payload) {
    return { ok: false, error: "invalid_payload", seq };
  }
  const kind =
    typeof msg.kind === "string" && msg.kind
      ? msg.kind
      : typeof payload.type === "string" && payload.type
        ? payload.type
        : "";
  if (!kind) {
    return { ok: false, error: "missing_kind", seq };
  }
  const recordedAtMs =
    typeof msg.recorded_at_ms === "number" && Number.isFinite(msg.recorded_at_ms)
      ? msg.recorded_at_ms
      : null;
  return {
    ok: true,
    item: {
      seq,
      kind,
      recorded_at_ms: recordedAtMs,
      session_id: normalizeSessionId(msg.session_id, seq),
      payload,
    },
  };
}

/**
 * 打刻の kind。**行の中身 (区分 / card_id / 社員解決の凍結 / JST 境界) は
 * rust-alc-api 側が持つ** ので、Worker はこの文字列以上のことを知らない。
 *
 * 定義をここに置くのは、**打刻を作る経路が 2 つある**ため
 * (端末の WS measurement と、ブラウザ打刻の `buildTimecardPunch`)。
 * 片方だけ別の文字列にすると購読の合図が静かに鳴らなくなる。
 */
export const TIMECARD_KIND = "timecard";

/** card_id の長さ上限 (NFC の生値。これを超えるものは端末側の異常)。 */
const MAX_CARD_ID_LEN = 256;

/** ブラウザ打刻 1 件の入力 (alc-app の server route 由来、field は untrusted)。 */
export interface TimecardPunchInput {
  card_id?: unknown;
}

export type BuildTimecardPunchResult =
  | { ok: true; item: ParsedMeasurement }
  | { ok: false; error: "invalid_card_id" };

/**
 * ブラウザ打刻 1 件を measurement に組み立てる (Refs ippoan/alc-app-s3#134)。
 *
 * **`kind` はサーバが立てる。クライアントには指定させない** — この経路は
 * 「打刻を作る」ためだけのものなので、kind を渡せるようにすると
 * `crash_log` や点呼/アルコール系まで注入できる口になる。
 *
 * **`recorded_at_ms` も受け取らない (常に null)。** ブラウザの時計は信用できず、
 * rust 側は `COALESCE(recorded_at, created_at)` で受信時刻に倒すため。
 * 従来のブラウザ打刻 (`create_punch` の `recorded_at = now()`) と同じ扱いになる。
 *
 * `payload` を `{ card_id }` だけにしてあるのも従来と同じ形 — 社員の解決
 * (`employee_id` の凍結) は ingest 側 (`freeze_employee_id`) が 1 か所で行う。
 */
export function buildTimecardPunch(
  input: TimecardPunchInput,
  seq: number,
): BuildTimecardPunchResult {
  const raw = typeof input.card_id === "string" ? input.card_id.trim() : "";
  if (!raw || raw.length > MAX_CARD_ID_LEN) {
    return { ok: false, error: "invalid_card_id" };
  }
  return {
    ok: true,
    item: {
      seq,
      kind: TIMECARD_KIND,
      recorded_at_ms: null,
      session_id: null,
      payload: { card_id: raw },
    },
  };
}

/**
 * crash_log (CoreS3 の異常リセット復帰レポート: reset reason + panic 前ログ、
 * Refs ippoan/alc-app-s3#43) はバックエンド (rust-alc-api hub_measurements) へ
 * 転送せず、受口の DO/Worker が R2 (`CRASH_LOGS`) へ直接保存して完結させる。
 */
export const CRASH_LOG_KIND = "crash_log";

/**
 * crash_log の R2 object key。seq ベースなので同 seq の再送は同じ key を
 * 上書きする (= 冪等、ack 前の再送で重複オブジェクトを作らない)。
 * seq は 12 桁 0 詰めにして prefix 一覧が数値順に並ぶようにする。
 */
export function crashLogKey(tenantId: string, deviceId: string, seq: number): string {
  return `${tenantId}/${deviceId}/${String(seq).padStart(12, "0")}.json`;
}

/**
 * crash_log 1 件を R2 へ保存する。reset reason は Workers Observability から
 * 集計できるよう log にも 1 行残す (値は payload 由来 = untrusted だが log のみ)。
 */
export async function storeCrashLog(
  bucket: R2Bucket,
  tenantId: string,
  deviceId: string,
  item: ParsedMeasurement,
  receivedAtMs: number,
): Promise<void> {
  const key = crashLogKey(tenantId, deviceId, item.seq);
  await bucket.put(
    key,
    JSON.stringify({
      tenant_id: tenantId,
      device_id: deviceId,
      seq: item.seq,
      recorded_at_ms: item.recorded_at_ms,
      received_at_ms: receivedAtMs,
      payload: item.payload,
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
  const reason = typeof item.payload.reset_reason === "string" ? item.payload.reset_reason : "?";
  console.log(`[crash_log] stored key=${key} reason=${reason}`);
}

/** crash_log メール通知に必要な env の部分型 (index.ts の Env が満たす)。 */
export interface CrashEmailEnv {
  CRASH_EMAIL?: SendEmail;
  NOTIFY_EMAIL_FROM?: string;
  NOTIFY_EMAIL_TO?: string;
}

/**
 * crash_log をメール通知する (best-effort、security-notification-app と同じ
 * Email Routing send_email binding + mimetext 方式)。
 *
 * R2 保存が正でメールは通知のみ — binding / vars 未設定 (テスト・未構成環境) は
 * 黙って skip、送信失敗も log のみで ack を妨げない。クラッシュは稀なので
 * 集約せずイベント毎に 1 通送る。
 */
export async function notifyCrashByEmail(
  env: CrashEmailEnv,
  tenantId: string,
  deviceId: string,
  item: ParsedMeasurement,
): Promise<void> {
  const binding = env.CRASH_EMAIL;
  const from = env.NOTIFY_EMAIL_FROM;
  const to = env.NOTIFY_EMAIL_TO;
  if (!binding || !from || !to) return;
  try {
    const p = item.payload;
    const str = (v: unknown): string => (typeof v === "string" ? v : "?");
    const reason = str(p.reset_reason);
    const body = [
      `CoreS3 が異常リセットから復帰しました (crash_log)。`,
      ``,
      `reset_reason: ${reason} (code=${typeof p.reset_code === "number" ? p.reset_code : "?"})`,
      `device_id:    ${deviceId}`,
      `tenant_id:    ${tenantId}`,
      `seq:          ${item.seq}`,
      `firmware:     ${str(p.version)} (${str(p.slot)})`,
      `R2 object:    alc-crash-logs/${crashLogKey(tenantId, deviceId, item.seq)}`,
      ``,
      `--- panic 前ログ (末尾) ---`,
      typeof p.log === "string" && p.log ? p.log : "(ログなし — RAM 未保持の可能性)",
    ].join("\n");

    const { EmailMessage } = await import("cloudflare:email");
    const { createMimeMessage } = await import("mimetext");
    const msg = createMimeMessage();
    msg.setSender({ name: "ALC Crash Notifier", addr: from });
    msg.setRecipient(to);
    msg.setSubject(`[alc] CoreS3 crash: ${reason} (${deviceId})`);
    msg.addMessage({ contentType: "text/plain", data: body });
    await binding.send(new EmailMessage(from, to, msg.asRaw()));
    console.log(`[crash_log] email sent device=${deviceId} reason=${reason}`);
  } catch (e) {
    console.log(`[crash_log] email notify failed tenant=${tenantId} device=${deviceId}`, e);
  }
}

/**
 * service binding fetch は host を無視するが、path が auth-worker 側 route
 * (`/alc-internal-proxy/...`) と一致する必要がある (web/server/utils/internal-proxy.ts と同形)。
 */
export const INGEST_URL =
  "https://alc-internal-proxy.internal/alc-internal-proxy/api/hub/measurements";

export type ForwardResult = { ok: true } | { ok: false; error: string };

/**
 * 検証済み measurement を auth-worker `/alc-internal-proxy` 経由で rust-alc-api
 * `POST /api/hub/measurements` へ転送する。tenant_id は X-Tenant-ID ヘッダー、
 * device_id は item に注入する。
 * 失敗時の詳細 (body) は caller の response に echo しない。log にのみ残す。
 */
export async function forwardMeasurements(
  authWorker: Fetcher,
  sharedSecret: string,
  tenantId: string,
  deviceId: string,
  items: ParsedMeasurement[],
): Promise<ForwardResult> {
  const body = items.map((item) => ({
    device_id: deviceId,
    kind: item.kind,
    seq: item.seq,
    recorded_at_ms: item.recorded_at_ms,
    session_id: item.session_id,
    payload: item.payload,
  }));
  let res: Response;
  try {
    res = await authWorker.fetch(INGEST_URL, {
      method: "POST",
      headers: {
        "X-Alc-Proxy-Secret": sharedSecret,
        "X-Tenant-ID": tenantId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.log(
      `[measurement] upstream unreachable tenant=${tenantId} device=${deviceId} n=${items.length}`,
      e,
    );
    return { ok: false, error: "upstream_unreachable" };
  }
  if (!res.ok) {
    console.log(
      `[measurement] upstream ${res.status} tenant=${tenantId} device=${deviceId} n=${items.length}`,
    );
    return { ok: false, error: `upstream_${res.status}` };
  }
  return { ok: true };
}
