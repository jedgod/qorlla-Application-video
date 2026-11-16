import {randomUUID} from 'node:crypto';
import {assert,requireDependencies} from './security.mjs';
import {appendEvent} from './outbox.mjs';

// Peer-to-peer media cannot be independently verified by a signaling server.
// The strongest truthful status here is 'client_reported', optionally with TURN observations.
export function createMediaAuthority({pool,meetAuth,roomAuthority,signaling}){
 requireDependencies({pool,meetAuth,roomAuthority,signaling},['pool','meetAuth','roomAuthority','signaling']);
 return {
  async beginMove({session,occurrenceId,participantId,targetRoom}){
   const actor=await meetAuth.verify(session,occurrenceId);assert(actor?.active);
   await roomAuthority.authorizeMove({actor,occurrenceId,participantId,targetRoom});
   const db=await pool.connect();try{await db.query('BEGIN');
    // Integrator must implement row locking and membership mutation atomically.
    const move=await roomAuthority.moveWithEpoch(db,{occurrenceId,participantId,targetRoom});
    assert(Number.isSafeInteger(move.epoch)&&move.epoch>0,'Missing movement epoch');
    const id=randomUUID();
    await db.query(`INSERT INTO smartrooms_v18.media_transitions(id,occurrence_id,participant_id,source_room,target_room,epoch)
      VALUES($1,$2,$3,$4,$5,$6)`,[id,occurrenceId,participantId,move.sourceRoom??null,targetRoom??null,move.epoch]);
    await appendEvent(db,{occurrenceId,roomId:targetRoom,kind:'room.media.move',payload:{id,participantId,epoch:move.epoch,targetRoom}});
    await db.query('COMMIT');return {transitionId:id,epoch:move.epoch,status:'connecting'};
   }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  },
  async authorizeSignal({session,occurrenceId,peerId,epoch}){
   const actor=await meetAuth.verify(session,occurrenceId);assert(actor?.active);
   const [sender,peer]=await Promise.all([
    roomAuthority.currentLocation({occurrenceId,participantId:actor.participantId}),
    roomAuthority.currentLocation({occurrenceId,participantId:peerId})]);
   assert(sender&&peer&&sender.epoch===epoch&&sender.roomId===peer.roomId,'Stale or cross-room signal');
   return {senderId:actor.participantId,peerId,roomId:sender.roomId,epoch};
  },
  async reportClientState({session,occurrenceId,transitionId,epoch,state}){
   assert(['client_reported','failed'].includes(state),'Invalid state');
   const actor=await meetAuth.verify(session,occurrenceId);assert(actor?.active);
   const loc=await roomAuthority.currentLocation({occurrenceId,participantId:actor.participantId});
   assert(loc?.epoch===epoch,'Stale media report');
   const {rows:[r]}=await pool.query(`UPDATE smartrooms_v18.media_transitions SET client_state=$1
    WHERE id=$2 AND occurrence_id=$3 AND participant_id=$4 AND epoch=$5
    RETURNING client_state,relay_observation`,[state,transitionId,occurrenceId,actor.participantId,epoch]);
   assert(r,'Unknown transition');return {status:r.client_state,relayObservation:r.relay_observation,verified:false};
  },
  async observeRelay({trustedRelayIdentity,transitionId,observation}){
   // This endpoint must ONLY be called through a separately authenticated TURN telemetry collector.
   assert(await signaling.verifyRelayCollector(trustedRelayIdentity),'Untrusted relay collector');
   assert(['allocation_observed','traffic_observed'].includes(observation),'Invalid observation');
   const {rowCount}=await pool.query(`UPDATE smartrooms_v18.media_transitions SET relay_observation=$1 WHERE id=$2`,[observation,transitionId]);
   return {recorded:!!rowCount,verified:false};
  }
 };
}
