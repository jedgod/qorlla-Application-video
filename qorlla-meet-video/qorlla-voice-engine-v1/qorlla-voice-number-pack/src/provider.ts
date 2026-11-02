import {config} from './config.js';
export interface NumberProvider {
 provision(input:{operationId:string;providerNumberId:string;userId:string}):Promise<void>;
 release(input:{operationId:string;providerNumberId:string}):Promise<void>;
}
// Mock is intentionally blocked from activating a production number.
export const provider:NumberProvider={
 async provision(){if(config.PROVIDER_MODE!=='mock')throw new Error('PROVIDER_NOT_CONFIGURED');},
 async release(){if(config.PROVIDER_MODE!=='mock')throw new Error('PROVIDER_NOT_CONFIGURED');}
};
