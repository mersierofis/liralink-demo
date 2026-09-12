// jest-e2e `setupFiles`: runs in every spec's environment before the spec imports AppModule
// (ConfigModule snapshots process.env on import, and process.env beats the .env file).
// e2e must never touch the live database — .env.test points DATABASE_URL at a *_test DB,
// and this refuses to run otherwise, so the test app's listener/settlement jobs write there only.
import * as path from 'path';
import * as dotenv from 'dotenv';

const backendRoot = path.resolve(__dirname, '..');
dotenv.config({
  path: path.join(backendRoot, '.env.test'),
  override: true,
  quiet: true,
});
dotenv.config({ path: path.join(backendRoot, '.env'), quiet: true });

const databaseUrl = process.env.DATABASE_URL;
const dbName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : '';
if (!dbName.endsWith('_test')) {
  throw new Error(
    `e2e refuses to run against database "${dbName}": set DATABASE_URL in backend/.env.test ` +
      `to a *_test database (see .env.test.example)`,
  );
}
