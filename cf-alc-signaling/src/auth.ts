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
