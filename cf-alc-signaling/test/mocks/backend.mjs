/**
 * alc-devices-worker (ALC_DEVICES service binding) のテストダブル。
 *
 * - `POST /api/devices/fcm-notify-call` … 着信通知 (FCM) の body と X-Internal-Secret を記録する
 *   (`_internal_secret` として body に足す)。
 * - `GET /__spy/fcm` / `POST /__spy/reset` … テストからの観測用。
 */

let fcmCalls = [];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/devices/fcm-notify-call") {
      fcmCalls.push({
        ...(await request.json()),
        _internal_secret: request.headers.get("X-Internal-Secret"),
      });
      return Response.json({ sent: 0 });
    }
    if (url.pathname === "/__spy/fcm") return Response.json(fcmCalls);
    if (request.method === "POST" && url.pathname === "/__spy/reset") {
      fcmCalls = [];
      return new Response(null, { status: 204 });
    }
    // 他の口 (test-fcm-all-exclude 等) は body を読み捨てて空の応答を返す
    await request.arrayBuffer();
    return Response.json({});
  },
};
