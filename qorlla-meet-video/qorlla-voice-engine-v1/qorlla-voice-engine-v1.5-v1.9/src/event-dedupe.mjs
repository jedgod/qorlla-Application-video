import {safeCursor} from './reliability-core.mjs';
export class EventDeduplicator{
 constructor(limit=2000){this.limit=limit;this.ids=new Set();}
 accept(id){if(!safeCursor(id)||this.ids.has(id))return false;this.ids.add(id);if(this.ids.size>this.limit)this.ids.delete(this.ids.values().next().value);return true;}
}
