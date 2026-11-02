export interface MeetingDiagnostics {getMeetingHealth(tenantId:string,meetingId:string):Promise<{state:string;participants:number;signalingHealthy:boolean}>;}
export function requireMeetingDiagnostics(provider?:MeetingDiagnostics):MeetingDiagnostics {if(!provider)throw new Error('MEETING_DIAGNOSTICS_UNAVAILABLE');return provider;}
