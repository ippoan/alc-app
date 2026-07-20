/**
 * WSS ハンドシェイク認証 + 内部 HTTP API 認証のヘルパー。
 *
 * device JWT の検証は auth-worker `POST /auth/introspect` に委譲する
 * (JWT_SECRET を本 Worker に配布しない、web/ の kiosk proxy と同パターン。
 * 認可判定の分離は nuxt-items workers/items-sync の auth-decision.ts に倣う)。
 *
 * introspect の認証は `Authorization: <INTERNAL_SHARED_SECRET>` (生の値、Bearer
 * prefix なし)。secret の値は log / response に一切出さない。
 */

/** auth-worker `/auth/introspect` 応答の必要 field。 */
export interface IntrospectResult {
  active: boolean;
  tenant_id?: string;
  role?: string;
  sub?: string;
  email?: string;
  exp?: number;
}

/** WS ハンドシェイクの判定結果。`status === 101` の時だけ DO に routing する。 */
export interface RecorderAuthDecision {
  /** 101 = accept / 401 = token invalid / 403 = role 不許可 */
  status: 101 | 401 | 403;
  /** accept 時のみ非空。DO id (テナント単位) と ingest の X-Tenant-ID に使う。 */
  tenantId: string;
  /** accept 時のみ非空。ingest item の device_id に注入する (JWT の sub)。 */
  deviceId: string;
}

/** CoreS3 組み込みハブ role (auth-worker src/lib/device.ts の allowlist、#363)。 */
export const DEVICE_ROLE_HUB = "device-hub";

/** AtomS3 印刷ブリッジ role (ippoan/alc-app-s3#38。下り print/ota command の待受に WS 接続する)。 */
export const DEVICE_ROLE_PRINT = "device-print";

/** P4 GW (Unit PoE-P4) role (ippoan/alc-gw-p4#15。下り version/ota command の待受に WS 接続する)。 */
export const DEVICE_ROLE_GATEWAY = "device-gateway";

/**
 * recorder への接続を許可する device role の allowlist。
 * kiosk / uploader 等の他 role は従来どおり 403 (blast radius 分離) —
 * 広げるのは「recorder の下り command で遠隔管理したいデバイス」だけ。
 */
export const RECORDER_DEVICE_ROLES: ReadonlySet<string> = new Set([
  DEVICE_ROLE_HUB,
  DEVICE_ROLE_PRINT,
  DEVICE_ROLE_GATEWAY,
]);

/** Secrets Store binding (`.get()`) / 文字列 のいずれでも値を取り出す。 */
export async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === "string") return binding;
  if (binding && typeof (binding as { get?: unknown }).get === "function") {
    return (await (binding as { get(): Promise<string> }).get()) ?? null;
  }
  return null;
}

/** 定数時間比較。短絡せず全文字を XOR して合算 (auth-worker と同実装)。 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Authorization ヘッダーから Bearer token を取り出す (無ければ null)。 */
export function bearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1] : null;
}

/**
 * auth-worker `/auth/introspect` を service binding 経由で叩く。
 * 応答が 200 以外 / JSON でない場合は null (設定不備扱い、caller が 503 を返す)。
 */
export async function introspectToken(
  authWorker: Fetcher,
  sharedSecret: string,
  token: string,
  origin: string,
): Promise<IntrospectResult | null> {
  try {
    const res = await authWorker.fetch("https://auth-worker.internal/auth/introspect", {
      method: "POST",
      headers: {
        Authorization: sharedSecret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token, origin }),
    });
    if (res.status !== 200) return null;
    return (await res.json()) as IntrospectResult;
  } catch {
    return null;
  }
}

/**
 * introspect 結果から WS ハンドシェイクの可否を決める (純粋関数)。
 *
 * - `active` でない (署名不正 / exp 切れ / env 不一致 / ACL 不許可テナント) → 401
 * - role が allowlist (device-hub / device-print) 以外 (kiosk / uploader 等) →
 *   403 (blast radius 分離)
 * - tenant_id / sub (device_id) 欠落 → 401 (identity 注入に必須なので fail-closed)
 */
export function decideRecorderAuth(
  result: IntrospectResult | null | undefined,
): RecorderAuthDecision {
  if (!result || result.active !== true || !result.tenant_id || !result.sub) {
    return { status: 401, tenantId: "", deviceId: "" };
  }
  if (typeof result.role !== "string" || !RECORDER_DEVICE_ROLES.has(result.role)) {
    return { status: 403, tenantId: "", deviceId: "" };
  }
  return { status: 101, tenantId: result.tenant_id, deviceId: result.sub };
}
