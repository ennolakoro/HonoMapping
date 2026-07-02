import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client/web';
import * as schema from './schema';

export function getDb(env?: { TURSO_DATABASE_URL: string, TURSO_AUTH_TOKEN: string }) {
  const url = env?.TURSO_DATABASE_URL || (typeof process !== 'undefined' ? process.env.TURSO_DATABASE_URL : undefined);
  const authToken = env?.TURSO_AUTH_TOKEN || (typeof process !== 'undefined' ? process.env.TURSO_AUTH_TOKEN : undefined);

  if (!url) {
    throw new Error("LibsqlError: TURSO_DATABASE_URL is missing from environment bindings.");
  }

  const client = createClient({
    url,
    authToken,
  });
  
  return drizzle(client, { schema });
}
