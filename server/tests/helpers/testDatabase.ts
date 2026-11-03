// Tests never touch the development database: they use a sibling database with a
// "_test" suffix, recreated before every run (see tests/globalSetup.ts).
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function toTestDatabaseUrl(url: string): string {
  const parsed = new URL(url);
  // Tests drop and recreate their database, so only ever point them at this machine.
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`Tests only run against a local database, not ${parsed.hostname}`);
  }
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unexpected database name "${name}"`);
  // Idempotent: a URL that already names the test database is returned unchanged.
  if (!name.endsWith("_test")) parsed.pathname = `/${name}_test`;
  return parsed.toString();
}
