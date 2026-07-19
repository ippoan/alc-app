export { SignalingRoom } from './signaling-room';
export { RoomRegistry } from './room-registry';
export { CameraSignalingRoom } from './camera-signaling-room';

export interface Env {
  SIGNALING_ROOM: DurableObjectNamespace;
  ROOM_REGISTRY: DurableObjectNamespace;
  CAMERA_SIGNALING_ROOM: DurableObjectNamespace;
  BACKEND_API_URL?: string;
  FCM_INTERNAL_SECRET?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return new Response('ok');
    }

    // POST /device-log → 端末診断ログを observability に流す (cf_logging で読める)。
    // 認証なし・値は log のみ。RoomWatcher の接続挙動や fileLog を端末から送って
    // リモートで WS 未接続の原因を切り分けるための経路 (Refs ippoan/rust-alc-api#480)。
    if (request.method === 'POST' && url.pathname === '/device-log') {
      let body: { device_id?: unknown; tag?: unknown; message?: unknown; lines?: unknown } = {};
      try {
        body = await request.json();
      } catch { /* ignore parse error */ }
      // 非認証エンドポイントなので log injection (CR/LF で偽 log 行を捏造) を防ぐ:
      // 文字列に強制し、制御文字 (C0) を空白へ潰してから 1 行に収める。
      const clean = (v: unknown, max: number): string =>
        (typeof v === 'string' ? v : '')
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001F\u007F]/g, ' ')
          .slice(0, max);
      const dev = clean(body.device_id, 64) || '(none)';
      const tag = clean(body.tag, 32) || 'device';
      const rawMsgs: unknown[] = Array.isArray(body.lines) ? body.lines : [body.message];
      // 1 行ずつ console.log (observability の 1 event = 1 行、制御文字除去済み)。
      for (const m of rawMsgs.slice(0, 200)) {
        console.log(`[device-log] dev=${dev} tag=${tag} ${clean(m, 2000)}`);
      }
      return new Response(null, {
        status: 204,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    // OPTIONS preflight (device-log を fetch で叩く webview 向け CORS)
    if (request.method === 'OPTIONS' && url.pathname === '/device-log') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // GET /active-rooms → list rooms with device connected
    if (request.method === 'GET' && url.pathname === '/active-rooms') {
      const id = env.ROOM_REGISTRY.idFromName('registry');
      const stub = env.ROOM_REGISTRY.get(id);
      const res = await stub.fetch('https://registry/rooms');
      const data = await res.json<{ rooms: string[] }>();
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // PUT /device-schedule/:deviceId → update schedule in RoomRegistry DO
    const scheduleMatch = url.pathname.match(/^\/device-schedule\/([^/]+)$/);
    if (request.method === 'PUT' && scheduleMatch) {
      const deviceId = scheduleMatch[1];
      const id = env.ROOM_REGISTRY.idFromName('registry');
      const stub = env.ROOM_REGISTRY.get(id);
      await stub.fetch(new Request(`https://registry/schedule/${deviceId}`, {
        method: 'PUT',
        body: await request.text(),
        headers: { 'Content-Type': 'application/json' },
      }));
      return new Response(null, {
        status: 204,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    // DELETE /device-schedule/:deviceId → delete schedule from RoomRegistry DO
    if (request.method === 'DELETE' && scheduleMatch) {
      const deviceId = scheduleMatch[1];
      const id = env.ROOM_REGISTRY.idFromName('registry');
      const stub = env.ROOM_REGISTRY.get(id);
      await stub.fetch(new Request(`https://registry/schedule/${deviceId}`, {
        method: 'DELETE',
      }));
      return new Response(null, {
        status: 204,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    // GET /watchers → list connected watcher device_ids (debug)
    if (request.method === 'GET' && url.pathname === '/watchers') {
      const id = env.ROOM_REGISTRY.idFromName('registry');
      const stub = env.ROOM_REGISTRY.get(id);
      const res = await stub.fetch('https://registry/watchers');
      return new Response(res.body, {
        status: res.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // POST /test-call-all-with-fcm → WebSocket + FCM fallback test
    if (request.method === 'POST' && url.pathname === '/test-call-all-with-fcm') {
      const id = env.ROOM_REGISTRY.idFromName('registry');
      const stub = env.ROOM_REGISTRY.get(id);
      const res = await stub.fetch('https://registry/test-call-all-with-fcm', { method: 'POST' });
      return new Response(res.body, {
        status: res.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // POST /test-call-all → send test call to all connected devices
    if (request.method === 'POST' && url.pathname === '/test-call-all') {
      const id = env.ROOM_REGISTRY.idFromName('registry');
      const stub = env.ROOM_REGISTRY.get(id);
      const res = await stub.fetch('https://registry/test-call-all', { method: 'POST' });
      return new Response(res.body, {
        status: res.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // POST /test-call/:deviceId → send test call notification to device
    const testCallMatch = url.pathname.match(/^\/test-call\/([^/]+)$/);
    if (request.method === 'POST' && testCallMatch) {
      const deviceId = testCallMatch[1];
      const id = env.ROOM_REGISTRY.idFromName('registry');
      const stub = env.ROOM_REGISTRY.get(id);
      const res = await stub.fetch(`https://registry/test-call/${deviceId}`, { method: 'POST' });
      return new Response(res.body, {
        status: res.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // DELETE /active-rooms/:roomId → manually remove stale room
    const delRoomMatch = url.pathname.match(/^\/active-rooms\/([a-zA-Z0-9_-]+)$/);
    if (request.method === 'DELETE' && delRoomMatch) {
      const id = env.ROOM_REGISTRY.idFromName('registry');
      const stub = env.ROOM_REGISTRY.get(id);
      await stub.fetch(`https://registry/rooms/${delRoomMatch[1]}`, { method: 'DELETE' });
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    // GET /watch-rooms → WebSocket for real-time room list updates
    if (url.pathname === '/watch-rooms') {
      const id = env.ROOM_REGISTRY.idFromName('registry');
      const stub = env.ROOM_REGISTRY.get(id);
      // Forward device_id query param to DO
      const deviceId = url.searchParams.get('device_id') || '';
      return stub.fetch(new Request(`https://registry/watch?device_id=${encodeURIComponent(deviceId)}`, request));
    }

    // WebSocket endpoint: /cam-room/:siteId → 拠点カメラ中継 (RoomRegistryを
    // 経由しない独立系統、ippoan/alc-app#129)
    const camMatch = url.pathname.match(/^\/cam-room\/([a-zA-Z0-9_-]+)$/);
    if (camMatch) {
      const roomId = camMatch[1];
      const role = url.searchParams.get('role');
      if (role !== 'device' && role !== 'admin') {
        return new Response('Missing or invalid role query param. Use ?role=device or ?role=admin', {
          status: 400,
        });
      }
      const id = env.CAMERA_SIGNALING_ROOM.idFromName(roomId);
      const stub = env.CAMERA_SIGNALING_ROOM.get(id);
      return stub.fetch(request);
    }

    // WebSocket endpoint: /room/:roomId
    const match = url.pathname.match(/^\/room\/([a-zA-Z0-9_-]+)$/);
    if (!match) {
      return new Response('Not Found. Use /room/:roomId or /cam-room/:siteId', { status: 404 });
    }

    const roomId = match[1];
    const role = url.searchParams.get('role');
    if (role !== 'device' && role !== 'admin') {
      return new Response('Missing or invalid role query param. Use ?role=device or ?role=admin', {
        status: 400,
      });
    }

    // Route to Durable Object by room ID
    const id = env.SIGNALING_ROOM.idFromName(roomId);
    const stub = env.SIGNALING_ROOM.get(id);

    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
