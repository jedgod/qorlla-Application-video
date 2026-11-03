// Breadcrumbs for the portal (Documents, AI, Admin, billing, ...). The portal supplies ITS OWN routes and ITS OWN authorization; the logic is the shared /assets/breadcrumbs.js served by the main app (one implementation for
// every Qorlla application). If that file is not reachable the portal simply has no trail: nothing else depends on it.
import { ADMIN_SECTIONS } from './admin.js';

const PRIVATE = ['notes', 'support', 'billing', 'team', 'phone', 'receptionist', 'mate', 'suite', 'ai'];
const TITLES = { suite: 'Documents', billing: 'Plans & Billing', team: 'Team', notes: 'Notes' };       // what the trail calls them (the page heading can be longer)

/** The portal's route table. `modules` is the portal's own module list ([slug, icon, title, blurb]). */
export function portalRoutes(modules) {
  const routes = [
    { id: 'workspace', label: 'Workspace', href: '/qorlla.html#home' },                              // the workspace shell, a different application
    { id: 'home', label: 'Products', pattern: '/app', parent: 'workspace' }
  ];
  for (const [slug, , title] of modules) routes.push({ id: slug, label: TITLES[slug] || title, pattern: '/app/' + slug, parent: 'workspace', ...(PRIVATE.includes(slug) ? { requires: 'signedIn' } : {}) });
  for (const slug of ['billing', 'team']) routes.push({ id: slug, label: TITLES[slug], pattern: '/app/' + slug, parent: 'workspace', requires: 'signedIn' });
  routes.push({ id: 'suite-doc', label: 'Document', pattern: '/app/suite', whenQuery: ['doc'], parent: 'suite', requires: 'signedIn' });                 // the document id is never shown
  routes.push({ id: 'ai-report', label: 'Report', pattern: '/app/ai/reports/:id', parent: 'ai', requires: 'signedIn' });                                // nor is the report id
  routes.push({ id: 'admin', label: 'Admin', pattern: '/app/admin', parent: 'workspace', requires: 'platformAdmin' });
  for (const [tab, label] of Object.entries(ADMIN_SECTIONS)) routes.push({ id: 'admin-' + tab, label, pattern: '/app/admin', query: { tab }, parent: 'admin', requires: 'platformAdmin' });
  return routes;
}
/** The portal knows who is looking: signed in, and whether they are a platform administrator. Anything it cannot establish is "no". */
export const authorizeFor = (state) => (route) => !route.requires || (route.requires === 'signedIn' && state.signedIn === true) || (route.requires === 'platformAdmin' && state.signedIn === true && !!(state.me && state.me.platform_admin));

export function paintCrumbs({ state, modules }) {
  const nav = document.getElementById('crumbs'), B = window.QorllaBreadcrumbs; if (!nav || !B) return null;
  return B.render({ container: nav, path: location.pathname, query: location.search, routes: portalRoutes(modules), authorize: authorizeFor(state) });
}
