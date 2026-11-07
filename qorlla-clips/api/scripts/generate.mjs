// Generates the Prisma client for the provider named by DATABASE_URL (the Docker build passes a placeholder PostgreSQL URL).
import { generate } from './lib.mjs';
generate();
