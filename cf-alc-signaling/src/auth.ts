/**
 * admin (ブラウザ) 接続の認証ヘルパー。
 *
 * JWT の検証は auth-worker `POST /auth/introspect` に委譲する (JWT_SECRET を本
 * Worker に配布しない、cf-alc-recorder/src/auth.ts と同パターン)。
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
  /** 開発用の鍵 (dev端末) か。claim が無ければ応答に載らない = dev でない (Refs ippoan/auth-worker#593)。 */
  dev_device?: boolean;
}

/**
 * worker が introspect の結果から組み立てて DO へ渡すヘッダ ("1" = dev端末 / "0" = dev でない)。
 * client が同名のヘッダを付けてきても worker が必ず上書きするので、DO はこの値だけを信じてよい
 * (Refs ippoan/alc-app#387)。
 */
export const DEV_HEADER = "X-Alc-Signaling-Dev";

/** DO 側: worker が組み立てた DEV_HEADER を読む。無い / "1" 以外は dev でない。 */
export function isDevRequest(request: Request): boolean {
  return request.headers.get(DEV_HEADER) === "1";
}

/** client のヘッダを写したうえで DEV_HEADER を検証結果で上書きする (client の申告を捨てる)。 */
export function headersWithDev(request: Request, dev: boolean): Headers {
  const headers = new Headers(request.headers);
  headers.set(DEV_HEADER, dev ? "1" : "0");
  return headers;
}

/** cam-room admin 接続を許可する role (Google ログイン JWT の role claim、Refs alc-app#129)。 */
export const CAM_ADMIN_ROLE = "admin";

/** Secrets Store binding (`.get()`) / 文字列 のいずれでも値を取り出す。 */
export async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === "string") return binding;
  if (binding && typeof (binding as { get?: unknown }).get === "function") {
    return (await (binding as { get(): Promise<string> }).get()) ?? null;
  }
  return null;
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
 * introspect 結果から admin WS ハンドシェイクの可否を決める (純粋関数)。
 * - `active` でない (署名不正 / exp 切れ / env 不一致) → 401
 * - role が "admin" でない (manager / viewer 等) → 403
 */
export function decideCamAdminAuth(result: IntrospectResult | null | undefined): 401 | 403 | 101 {
  if (!result || result.active !== true) return 401;
  if (result.role !== CAM_ADMIN_ROLE) return 403;
  return 101;
}

/**
 * 任意 token の introspect 結果から「dev端末の鍵か」を決める (純粋関数、Refs ippoan/alc-app#387)。
 * - `active` でない (署名不正 / exp 切れ / env 不一致 / introspect 失敗) → 401。
 *   「dev でない」に倒さない — 期限切れの token を付けた dev端末が本番側の部屋として
 *   登録されるのを防ぐ。
 * - dev かどうかは `dev_device === true` だけで決める (role や申告は見ない)。
 */
export function decideDevDevice(result: IntrospectResult | null | undefined): 401 | boolean {
  if (!result || result.active !== true) return 401;
  return result.dev_device === true;
}
