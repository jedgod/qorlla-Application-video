const fs = require('node:fs');
module.exports = async function teardown(config) {
    const pidFile = config.metadata.testServerPidFile;
    if (!pidFile || !fs.existsSync(pidFile)) return;
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid disposable server PID.');
    try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
};
