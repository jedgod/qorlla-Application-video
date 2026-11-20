'use strict';
// Is Qorlla Meet running next to this server? Asked with a short limit, so ONE slow or failed answer must not be read as "Meet is gone": the last address that did answer is kept for a grace
// period. (Without this, a single timeout under load made every start and join for the next few seconds fall into the basic built-in room, even for a meeting that already lives in Meet.)
function createMeetProbe({ check, now = () => Date.now(), refreshMs = 4000, graceMs = 60000 }) {
    let state = { at: 0, port: 0, okAt: 0 };
    return async function probe() {
        if (now() - state.at < refreshMs) return state.port;
        let port = 0;
        try { port = Number(await check()) || 0; } catch (e) { port = 0; }
        if (port) state = { at: now(), port, okAt: now() };
        else if (state.port && now() - state.okAt < graceMs) state = { at: now(), port: state.port, okAt: state.okAt };       // a failed answer inside the grace period: keep the last good address, ask again soon
        else state = { at: now(), port: 0, okAt: state.okAt };
        return state.port;
    };
}
module.exports = { createMeetProbe };
