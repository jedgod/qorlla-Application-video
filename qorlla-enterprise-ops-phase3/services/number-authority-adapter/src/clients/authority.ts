export interface NumberAuthority {lookupAssignment(tenantId:string,userId:string):Promise<{number:string;country:string}|null>;}
export function requireNumberAuthority(provider?:NumberAuthority):NumberAuthority {if(!provider)throw new Error('NUMBER_AUTHORITY_NOT_CERTIFIED');return provider;}
