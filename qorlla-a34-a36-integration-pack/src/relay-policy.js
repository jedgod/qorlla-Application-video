// The actual browser/native WebRTC client must enforce these constraints.
// TURN relay-only does not grant server-side media kill unless the relay
// allocation is actively revoked/isolated by infrastructure controls.
export const rtcConfiguration = ({iceServers})=>({
  iceServers,
  iceTransportPolicy:'relay',
  bundlePolicy:'max-bundle'
});
export function closeMediaOnRevocation(peerConnection,localStreams=[]) {
  for(const stream of localStreams) for(const track of stream.getTracks()) track.stop();
  for(const sender of peerConnection.getSenders()) sender.track?.stop();
  peerConnection.close();
}
