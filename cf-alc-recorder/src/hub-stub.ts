/**
 * テナント単位の RecorderHub DO stub を引くための最小限の helper
 * (Refs ippoan/rust-alc-api#644)。
 *
 * `index.ts` (HTTP/WS ハンドラ) と `battery-snapshot.ts` (cron) の両方から
 * 呼ばれるため、循環 import を避けるためだけに独立したモジュールとして
 * 切り出している。この 2 関数と、それに必要な最小の型以外はここに置かない。
 */

/** DO の storage キー (版つき)。DO は作成後に data location を変更できない
 * (Cloudflare 公式: "Durable Objects do not currently change locations after
 * they are created") ため、locationHint を効かせて置き直すには**別のキー**で
 * 新しい DO を作る必要がある。置き直すたびにこのサフィックスを上げる。
 */
export function hubObjectName(tenantId: string): string {
  return `${tenantId}/v2`;
}

/**
 * テナント単位の DO stub を引く。locationHint で APAC (日本近傍) の colo に
 * 固定し、米国側に作られて太平洋を跨いで ingest する事故を避ける。
 */
export function hubStub(
  env: { RECORDER_HUB: DurableObjectNamespace },
  tenantId: string,
): DurableObjectStub {
  return env.RECORDER_HUB.get(env.RECORDER_HUB.idFromName(hubObjectName(tenantId)), {
    locationHint: "apac-ne",
  });
}
