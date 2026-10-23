// signaling room (SignalingRoom / CameraSignalingRoom) の keepalive。
// 下の文字列ちょうどの ping には runtime が pong を返し、DO は起きない
// (webSocketMessage が呼ばれず、hibernate したまま)。1 文字でも違う ping
// (空白入り・項目追加など) は従来どおり DO が起きて webSocketMessage の
// `ping` 分岐で pong を返す。

/** device / admin が keepalive で送る文字列。`JSON.stringify({ type: 'ping' })` と同じ。 */
export const KEEPALIVE_PING = '{"type":"ping"}';

/** KEEPALIVE_PING への応答。 */
export const KEEPALIVE_PONG = '{"type":"pong"}';

/** constructor で ctx に設定する。 */
export function setKeepaliveAutoResponse(ctx: DurableObjectState): void {
  ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(KEEPALIVE_PING, KEEPALIVE_PONG));
}
