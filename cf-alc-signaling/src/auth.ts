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

/**
 * cam-room admin 接続を許可する role (JWT の role claim、Refs alc-app#129)。
 * `admin` = Google ログインの管理者、`device-tenko-manager` = 運行管理者席の鍵
 * (device JWT。遠隔点呼の画面はこちらで動く。運行管理者の user role は存在しない)。
 */
export const CAM_ADMIN_ROLES: readonly string[] = ["admin", "device-tenko-manager"];

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
 * - role が "admin" / "device-tenko-manager" でない (viewer・他の device 鍵等) → 403
 */
export function decideCamAdminAuth(result: IntrospectResult | null | undefined): 401 | 403 | 101 {
  if (!result || result.active !== true) return 401;
  if (!result.role || !CAM_ADMIN_ROLES.includes(result.role)) return 403;
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

/**
 * cam-room の device (拠点 PC の拡張 alc-cam) が持つ鍵の role。auth-worker `/device/alarm-token`
 * の usage=`cam-host` で CoreS3 の署名から発行される (kiosk の鍵は拡張に渡さない)。
 */
export const CAM_DEVICE_ROLE = "device-cam-host";

/**
 * cam-room の device に token を必須にするか。拠点の拡張を token 付きの版へ入れ替え終えるまでは
 * false (token 無しの device も通す)。入れ替え後に true にするだけで必須化できる。
 * token を付けて来た device は false の間も検証する (落ちたら 401/403)。
 */
export const CAM_DEVICE_TOKEN_REQUIRED: boolean = false;

/** token を付けずに来た cam-room の device の可否 (純粋関数。既定は `CAM_DEVICE_TOKEN_REQUIRED`)。 */
export function decideCamDeviceWithoutToken(required: boolean = CAM_DEVICE_TOKEN_REQUIRED): 401 | 101 {
  return required ? 401 : 101;
}

/**
 * token を付けて来た cam-room の device の introspect 結果から可否を決める (純粋関数)。
 * - `active` でない → 401
 * - role が `device-cam-host` でない (kiosk の鍵・admin 等) → 403
 */
export function decideCamDeviceAuth(result: IntrospectResult | null | undefined): 401 | 403 | 101 {
  if (!result || result.active !== true) return 401;
  if (result.role !== CAM_DEVICE_ROLE) return 403;
  return 101;
}

/**
 * worker が `/room` と `/cam-room` の device の鍵から取り出した sub を DO へ渡すヘッダ。DEV_HEADER と同じく
 * client が付けてきた同名のヘッダは worker が必ず消す / 上書きするので、DO はこの値だけを信じてよい。
 */
export const DEVICE_SUB_HEADER = "X-Alc-Signaling-Device-Sub";
