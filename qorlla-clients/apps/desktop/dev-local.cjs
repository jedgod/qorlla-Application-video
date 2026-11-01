'use strict';
// Starts the desktop shell against the Qorlla server on this machine (http://localhost:3200 unless QORLLA_APP_URL says otherwise).
// The shell has no database and starts no server: it shows the pages of that one server, so accounts, meetings, mail and notes are the same as in the browser.
// Development only: the http://localhost allowance is ignored by a packaged build.
const { spawn } = require('node:child_process');
const electron = require('electron');

// The Qorlla Meet video page runs on its own origin (3300 in the local stack); the shell must trust it or a meeting cannot leave the app page. Same pair the phone app is built with (apps/mobile/scripts/local-stack.cjs).
const url = process.env.QORLLA_APP_URL || 'http://localhost:3200';
const meet = process.env.QORLLA_MEET_URLS || 'http://localhost:3300';
const env = { ...process.env, QORLLA_APP_URL: url, QORLLA_MEET_URLS: meet, QORLLA_DEV_ALLOW_LOCALHOST_HTTP: '1' };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env, cwd: __dirname }).on('exit', (code) => process.exit(code === null ? 1 : code));
