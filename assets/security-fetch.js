/* Attach the current session-bound token to same-origin API mutations only. */
(() => {
    'use strict';
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(new URL(input, location.href));
        const outgoing = new Request(request, init);
        const url = new URL(outgoing.url);
        if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(outgoing.method)) return originalFetch(outgoing);
        const response = await originalFetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error('Unable to obtain request security token.');
        const { token } = await response.json();
        const headers = new Headers(outgoing.headers);
        if (token) headers.set('X-CSRF-Token', token);
        return originalFetch(new Request(outgoing, { headers }));
    };
})();
