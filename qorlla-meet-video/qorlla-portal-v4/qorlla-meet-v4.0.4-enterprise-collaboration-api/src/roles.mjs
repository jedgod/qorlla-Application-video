export const hostRole=role=>role==='host'||role==='cohost';
export const editorRole=role=>hostRole(role)||role==='presenter';
