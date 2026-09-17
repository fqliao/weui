import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const example = await fs.readFile('.env.example', 'utf8');
const data = example
  .replace('uiagent:CHANGE_ME', 'uiagent:ci_database_password')
  .replaceAll('REPLACE_WITH_RANDOM_32_BYTES', randomBytes(32).toString('hex'))
  .replaceAll('REPLACE_WITH_STRONG_PASSWORD', randomBytes(18).toString('base64url'));
await fs.writeFile('.env', data, { mode: 0o600 });
await fs.mkdir('.runtime/logs', { recursive: true });
