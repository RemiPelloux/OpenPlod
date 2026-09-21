/**
 * `bun run doctor` — autodetect what this computer can do.
 *
 * Prints the same host report the desktop app shows on its Plaud page, so a
 * problem can be diagnosed from a terminal, over SSH, or in a bug report
 * without launching the UI. Exits 1 when something blocks direct transfer, so
 * it also works as a setup gate in a script.
 *
 * `--json` prints the raw report instead of the readable summary.
 */
import { detectPlaudEnvironment } from '../src/sync/plaud-environment';

const json = process.argv.includes('--json');
const environment = await detectPlaudEnvironment();

if (json) {
  console.log(JSON.stringify(environment, null, 2));
} else {
  const backend = environment.backend ?? 'none';
  console.log(`OpenPlod host check — ${environment.platform} ${environment.arch} (${environment.osRelease})`);
  console.log(`Bluetooth backend: ${backend} · bridge: ${environment.bridgeBackend}`);
  if (environment.adapter) console.log(`Adapter: ${environment.adapter}`);
  console.log('');
  for (const check of environment.checks) {
    console.log(`${check.ok ? '  ok ' : ' !! '} ${check.label}: ${check.detail}`);
    if (check.remediation) console.log(`       → ${check.remediation}`);
  }
  console.log('');
  console.log(environment.ready
    ? 'Ready: this computer can transfer directly over Bluetooth.'
    : `Not ready: ${environment.blockers.length} check${environment.blockers.length === 1 ? ' needs' : 's need'} attention.`);
}

process.exit(environment.ready ? 0 : 1);
