/**
 * backend (rust-alc-api) のテストダブル。worker の外向き fetch を全部ここで受ける。
 *
 * - `POST /api/devices/fcm-notify-call` … 着信通知 (FCM) の body を記録する。
 * - `GET /__spy/fcm` / `POST /__spy/reset` … テストからの観測用。
 */

let fcmCalls = [];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/devices/fcm-notify-call") {
      fcmCalls.push(await request.json());
      return Response.json({ sent: 0 });
    }
    if (url.pathname === "/__spy/fcm") return Response.json(fcmCalls);
    if (request.method === "POST" && url.pathname === "/__spy/reset") {
      fcmCalls = [];
      return new Response(null, { status: 204 });
    }
    // 他の外向き fetch (test-fcm-all-exclude 等) は body を読み捨てて空の応答を返す
    await request.arrayBuffer();
    return Response.json({});
  },
};
