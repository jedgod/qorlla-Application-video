import {z} from 'zod';
export const reactionSchema=z.object({emoji:z.enum(['👍','👏','❤️','🎉','😂','🙌','🤔','👎','✋','✅'])});
export const questionSchema=z.object({body:z.string().trim().min(1).max(4000),anonymous:z.boolean().default(false)});
export const roomSchema=z.object({title:z.string().trim().min(1).max(100),leadParticipantId:z.string().max(200).nullable().optional()});
export const boardOpSchema=z.object({operation:z.object({type:z.enum(['stroke','shape','text','sticky','erase','page','undo','redo']),page:z.number().int().min(0).max(100),data:z.record(z.unknown())})});
export function requireRole(actor,roles){if(!roles.includes(actor.role)) {const e=new Error('forbidden');e.status=403;throw e;}}
export function featureGate(flags,key){if(flags?.[key]!==true){const e=new Error(`${key} unavailable`);e.status=503;throw e;}}
export function safeFilename(name){return name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,160);}
