// Fake LCU app-management edge. Never invokes native authentication or a real store.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const trace = process.argv[2];
const [action, app] = process.argv.slice(4);
const record = value => appendFileSync(trace, JSON.stringify(value) + '\n');
const path = `${trace}.apps.json`;
const control = existsSync(`${trace}.apps-control.json`)
  ? JSON.parse(readFileSync(`${trace}.apps-control.json`, 'utf8')) : {};
record({ event: 'apps_command', action, app, pid: process.pid });
if (control.fail === action) {
  console.error(`Fixture ${action} failure; nothing was changed.`);
  process.exit(2);
}
const document = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { approvedBundleIdentifiers: [] };
if (action === '--json') {
  if (control.invalidList) {
    console.log('{"apps":"invalid"}');
  } else {
    console.log(JSON.stringify({ apps: document.approvedBundleIdentifiers.map(bundleId => ({
      bundleId, name: bundleId, installed: true, blocked: false,
    })), file: path }));
  }
} else if (action === 'allow') {
  if (control.waitForAuth) {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise(resolve => child.stdout.once('data', resolve));
    record({ event: 'apps_auth_wait', pid: process.pid, helperPid: child.pid });
    process.on('SIGTERM', () => process.exit(0));
    await new Promise(() => {});
  }
  record({ event: 'apps_owner_authenticated', app });
  if (!control.skipWrite) {
    const ids = [...new Set([...document.approvedBundleIdentifiers, app])];
    writeFileSync(path, JSON.stringify({ ...document, approvedBundleIdentifiers: ids }));
  }
  console.log(`Always allowed: ${app}.`);
} else {
  throw new Error(`Unexpected fixture app-management action: ${action}`);
}
