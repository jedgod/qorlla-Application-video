import {WebSocket} from 'ws';
// Local delivery + cross-instance fanout. A device target is mandatory for SDP/ICE.
export class VoiceRouter {
 constructor(bus) {this.bus=bus;this.sockets=new Map();}
 attach(ws) {const s=this.sockets.get(ws.account)||new Set();s.add(ws);this.sockets.set(ws.account,s);}
 detach(ws) {const s=this.sockets.get(ws.account);s?.delete(ws);if(s?.size===0)this.sockets.delete(ws.account);}
 local(account,device,payload) {
  for(const ws of this.sockets.get(account)||[]) {
   if(ws.readyState===WebSocket.OPEN && (!device || ws.deviceId===device)) ws.send(JSON.stringify(payload));
  }
 }
 async deliver(account,device,payload) {
  // Publish first: don't acknowledge an event as delivered when cross-node transport is down.
  await this.bus.publish(account,device,payload);
  this.local(account,device,payload);
 }
}
