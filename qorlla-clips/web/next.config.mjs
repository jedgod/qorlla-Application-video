// The browser only ever talks to this Next.js server (same origin as the Qorlla app), which forwards /api/* to the Clips API.
// That keeps the Qorlla session cookie first-party and means the API needs no CORS for the browser.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const API_URL = (process.env.CLIPS_API_URL || 'http://127.0.0.1:5400').replace(/\/+$/, '');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',                         // a small self-contained server for the Docker image
  outputFileTracingRoot: here,                 // this folder is its own project, even though a parent folder has a lockfile
  // When the app is mounted under a path of the main site (for example https://host/clips) set CLIPS_BASE_PATH=/clips at BUILD time.
  basePath: process.env.CLIPS_BASE_PATH || undefined,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ] }];
  },
};
export default nextConfig;
