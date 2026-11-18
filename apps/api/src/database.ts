import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
const cwdEnv = path.resolve(process.cwd(), '.env');
const workspaceEnv = path.resolve(process.cwd(), '../../.env');
dotenv.config({ path: fs.existsSync(cwdEnv) ? cwdEnv : workspaceEnv });
import pg from 'pg';

export const database = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});
