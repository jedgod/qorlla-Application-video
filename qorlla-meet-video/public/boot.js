// Runs before the page is drawn: arriving from Qorlla Home with a hand-off in the address (or with a saved session) goes straight to the meeting,
// so the start/join page must never flash up first. app.js clears the marker when the meeting shows or when the hand-off fails.
try { if (/[#&](qh|qs)=/.test(location.hash || '') || sessionStorage.getItem('qorlla-session')) document.documentElement.classList.add('entering'); } catch (e) { /* storage unavailable */ }
