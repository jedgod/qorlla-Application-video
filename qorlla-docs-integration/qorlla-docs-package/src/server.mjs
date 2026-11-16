// Reference standalone server. NOT safe for production without a real Qorlla auth adapter.
// Intentionally refuses to start rather than accept spoofable user headers.
import express from 'express';
import pg from 'pg';
import helmet from 'helmet';
import {createDocsRouter} from './docs-api.mjs';
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');
throw Error('Integration required: replace this bootstrap with Qorlla authenticated session, workspace membership, CSRF and SBACS adapters. See README.md.');
// Example wiring in the existing app:
// app.use('/api/v1/docs-next',createDocsRouter({db:existingPgPool,identity:verifiedSessionIdentity,resolveEntitlements:existingSbacsResolver}));
