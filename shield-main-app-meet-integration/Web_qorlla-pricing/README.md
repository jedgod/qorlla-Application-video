# Qorlla™ Workplace Pricing Portal

Full pricing page matching the Zoom Workplace layout, rebranded to Qorlla™.

- Left sidebar: Popular + Explore more
- Plans: Basic (Free), Pro ($16.99 / $14.99 annual), Business ($21.99 / $18.33 annual), Enterprise (Talk to us)
- Annual/Monthly toggle
- Highlights expand/collapse correctly
- 40-minute limit warning is hidden by default (only shown when the limit expires)

Open index.html in a browser.

## Portal integration (v4)

The page talks to the Qorlla Portal (`qorlla-meet-video/qorlla-portal-v4`, default `http://<this host>:5500`; override once with `?portal=http://host:port`).

- Header/sidebar/apps-menu entries open the matching portal page (`/app/products`, `/app/phone`, `/app/mate`, ...).
- Monthly Pro/Business prices are read from the portal's PostgreSQL `GET /api/v1/plans`. If the portal is offline the built-in prices are used. The portal has no annual pricing, so if a live monthly price differs from the built-in one, the annual toggle is disabled.
- Buy buttons do not fake a purchase: Basic -> sign-up, Pro/Business -> portal pricing page (checkout is not connected), Enterprise -> portal support.
- The portal only answers cross-origin reads for origins listed in `PORTAL_PUBLIC_ORIGINS` (GET `/api/v1/plans` and `/api/v1/products` only).
