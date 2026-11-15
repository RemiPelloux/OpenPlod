/**
 * REL-07: writes src-tauri/tauri.release.conf.json, merged by `tauri build --config`.
 *
 * Everything secret or release-specific comes from the environment at build time;
 * nothing is committed. Missing values disable the matching feature instead of
 * failing the build:
 *
 *   TAURI_UPDATER_PUBKEY + TAURI_SIGNING_PRIVATE_KEY -> signed updater artifacts (latest.json, .sig)
 *   APPLE_SIGNING_IDENTITY                           -> macOS code signing (hardened runtime)
 *   APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID, or
 *   APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH -> notarization (read by Tauri directly)
 *
 * Prints a summary of what the build will and will not do.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const env = (name: string) => process.env[name]?.trim() || '';
const updater = Boolean(env('TAURI_UPDATER_PUBKEY') && env('TAURI_SIGNING_PRIVATE_KEY'));
const endpoint = env('OPENPLOD_UPDATE_ENDPOINT');
if (endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('OPENPLOD_UPDATE_ENDPOINT must be an HTTPS URL without credentials or a fragment.');
  }
}
const macSigning = Boolean(env('APPLE_SIGNING_IDENTITY'));
const notarization = Boolean((env('APPLE_ID') && env('APPLE_PASSWORD') && env('APPLE_TEAM_ID'))
  || (env('APPLE_API_KEY') && env('APPLE_API_ISSUER') && env('APPLE_API_KEY_PATH')));

const config = {
  bundle: {
    createUpdaterArtifacts: updater,
    macOS: macSigning ? { signingIdentity: env('APPLE_SIGNING_IDENTITY'), hardenedRuntime: true } : { signingIdentity: '-' },
  },
  plugins: { updater: { pubkey: updater ? env('TAURI_UPDATER_PUBKEY') : '', ...(endpoint ? { endpoints: [endpoint] } : {}) } },
};

const output = resolve(process.argv[2] || 'src-tauri/tauri.release.conf.json');
writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
console.log(`[release] wrote ${output}`);
console.log(`[release] updater artifacts: ${updater ? 'signed' : 'disabled (TAURI_UPDATER_PUBKEY/TAURI_SIGNING_PRIVATE_KEY not set)'}`);
console.log(`[release] macOS signing: ${macSigning ? 'Developer ID' : 'ad-hoc (APPLE_SIGNING_IDENTITY not set)'}`);
console.log(`[release] macOS notarization: ${macSigning && notarization ? 'enabled' : 'disabled'}`);
