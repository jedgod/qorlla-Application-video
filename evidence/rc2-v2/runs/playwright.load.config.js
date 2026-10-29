// Evidence-run override (untracked): one worker and a 15 s assertion timeout, because OneDrive was holding the 4-core machine at 100% CPU. Everything else is the repository config.
const base = require('./playwright.config.js'); module.exports = { ...base, workers: 1, fullyParallel: false, expect: { timeout: 15000 } };
