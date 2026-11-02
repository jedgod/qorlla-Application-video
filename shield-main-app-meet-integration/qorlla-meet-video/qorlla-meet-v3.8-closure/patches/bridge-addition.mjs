// Append to the existing src/bridge.mjs, which already exports meetBridge.
export const rotateHost = sourceId => meetBridge(`/api/integrations/scheduled-meetings/${encodeURIComponent(sourceId)}/rotate-host`,'POST');
