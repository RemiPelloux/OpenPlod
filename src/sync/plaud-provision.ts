import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PlaudDeviceAuth, readDeviceCredentials } from './plaud-device-auth';
import { isBluetoothIdentifier } from './plaud-bridge';

/**
 * Plaud device authorization.
 *
 * A recorder only accepts an encrypted session from a client that can present
 * three things:
 *
 *  1. a per-user RSA-2048 key pair issued by Plaud (`gen-key`),
 *  2. a signature over the recorder's serial number issued by Plaud (`sn-sign`),
 *  3. the account's device binding token (the `sub` claim of the user token).
 *
 * All three are minted by the Plaud Partner API from a **user access token**.
 * That endpoint is the same one the official Plaud SDK uses
 * (`PlaudDeviceAgent.initSDK(userAccessToken:)`), which is why authorizing here
 * makes the recorder work identically on Linux, macOS and Windows.
 */

/** Partner API regions. `platform.plaud.ai` has no partner SDK surface. */
export const PLAUD_DOMAINS = ['platform-us.plaud.ai', 'platform-jp.plaud.ai'] as const;
export type PlaudDomain = (typeof PLAUD_DOMAINS)[number];
export const DEFAULT_PLAUD_DOMAIN: PlaudDomain = 'platform-us.plaud.ai';
export const isPlaudDomain = (value: string): value is PlaudDomain =>
  (PLAUD_DOMAINS as readonly string[]).includes(value);

/** The binding token becomes the 32-byte ASCII handshake field. */
export const BINDING_TOKEN_PATTERN = /^[\x21-\x7e]{1,64}$/;
/** Recorder serial numbers are 16 uppercase hex characters (e.g. `8810…`). */
export const PLAUD_SERIAL_PATTERN = /^[0-9A-F]{16}$/;

export interface PlaudAccessTokenClaims {
  /** `sub` — the account's device binding token. */
  sub: string;
  userId: string;
  clientId: string;
  /** Epoch milliseconds, or 0 when the token carries no expiry. */
  expiresAt: number;
}

/** The on-disk `plaud-device.json` shape the native bridge consumes. */
export interface PlaudDeviceIdentity {
  identifier: string;
  serial: string;
  bindingToken: string;
  signature: string;
  publicKey: string;
  privateKey: string;
}

export interface ProvisionedIdentity extends PlaudDeviceIdentity {
  deviceType: string;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Accept the token in every shape a user might paste: raw JWT, a quoted string,
 * a JSON blob copied from browser storage, or a `Bearer …` header value.
 */
export function normalizeAccessToken(raw: string): string {
  let token = (raw ?? '').trim();
  if (token.startsWith('{')) {
    try {
      const parsed = JSON.parse(token) as Record<string, unknown>;
      token = String(parsed.tokenstr ?? parsed.access_token ?? parsed.token ?? '').trim();
    } catch {
      // Fall through: treat the value as an opaque token.
    }
  }
  if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
    token = token.slice(1, -1).trim();
  }
  if (/^bearer\s/i.test(token)) token = token.replace(/^bearer\s+/i, '').trim();
  return token;
}

/** Decode (never verify) a Plaud user access token into the claims we need. */
export function parseAccessToken(raw: string): PlaudAccessTokenClaims {
  const token = normalizeAccessToken(raw);
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => part.length === 0)) {
    throw new Error('That does not look like a Plaud sign-in token.');
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('The Plaud sign-in token could not be read.');
  }
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (!BINDING_TOKEN_PATTERN.test(sub)) {
    throw new Error('The Plaud sign-in token is missing a usable device binding token.');
  }
  const rawExpiry = Number(payload.exp ?? 0);
  return {
    sub,
    userId: typeof payload.user_id === 'string' && payload.user_id ? payload.user_id : sub,
    clientId: typeof payload.client_id === 'string' ? payload.client_id : '',
    expiresAt: Number.isFinite(rawExpiry) && rawExpiry > 0 ? rawExpiry * 1000 : 0,
  };
}

/** Map a recorder serial prefix to the cloud device type used by `sn-sign`. */
export function deviceTypeForSerial(serial: string): string {
  if (!PLAUD_SERIAL_PATTERN.test(serial)) {
    throw new Error('A 16-character Plaud serial number is required.');
  }
  return ({ '880': 'notepin', '881': 'notepro', '882': 'notepins', '883': 'notepro' } as Record<string, string>)[serial.slice(0, 3)] ?? 'note';
}

const describePlaudError = (status: number, detail: string): string => {
  if (detail === 'ACCESS_TOKEN_INVALID') return 'Plaud rejected the sign-in token. Sign in again and paste a fresh token.';
  if (detail === 'CLIENT_USER_NOT_FOUND') return 'This Plaud account is not enabled for device authorization in that region.';
  if (detail === 'TOKEN_EXPIRED') return 'The Plaud sign-in token has expired. Sign in again and paste a fresh token.';
  return `Plaud authorization failed (HTTP ${status}).`;
};

/**
 * Mints the key material and serial signature a recorder demands.
 * Injectable fetcher keeps this testable without touching the network.
 */
export class PlaudIdentityProvisioner {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  private async post(path: string, token: string, domain: PlaudDomain, body?: unknown): Promise<Record<string, unknown>> {
    if (!isPlaudDomain(domain)) throw new Error('Unsupported Plaud region.');
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetcher(`https://${domain}${path}`, {
        method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error('Plaud could not be reached to authorize this recorder.');
    }
    if (!response.ok) {
      const detail = await response.json().then((payload: unknown) => {
        const value = (payload as { detail?: unknown } | null)?.detail;
        return typeof value === 'string' ? value : '';
      }).catch(() => '');
      throw new Error(describePlaudError(response.status, detail));
    }
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== 'object') throw new Error('Plaud returned an unreadable authorization response.');
    return payload as Record<string, unknown>;
  }

  /** `POST /developer/api/open/partner/sdk/gen-key` */
  async generateKeyPair(token: string, domain: PlaudDomain = DEFAULT_PLAUD_DOMAIN) {
    const result = await this.post('/developer/api/open/partner/sdk/gen-key', token, domain);
    const publicKey = typeof result.public_key === 'string' ? result.public_key : '';
    const privateKey = typeof result.private_key === 'string' ? result.private_key : '';
    if (!publicKey || !privateKey) throw new Error('Plaud returned no recorder key material.');
    return { publicKey, privateKey };
  }

  /** `POST /developer/api/open/partner/sdk/sn-sign` */
  async signSerial(token: string, serial: string, domain: PlaudDomain = DEFAULT_PLAUD_DOMAIN, deviceType = deviceTypeForSerial(serial)) {
    const result = await this.post('/developer/api/open/partner/sdk/sn-sign', token, domain, { type: deviceType, sn: serial });
    const signature = typeof result.signature === 'string' ? result.signature : '';
    if (!signature) throw new Error('Plaud returned no recorder signature.');
    return signature;
  }

  /** Provision a complete identity for one recorder. */
  async provision(options: { token: string; serial: string; identifier: string; domain?: PlaudDomain }): Promise<ProvisionedIdentity> {
    const { token, serial, identifier } = options;
    const domain = options.domain ?? DEFAULT_PLAUD_DOMAIN;
    if (!PLAUD_SERIAL_PATTERN.test(serial)) throw new Error('A 16-character Plaud serial number is required.');
    if (!isBluetoothIdentifier(identifier)) throw new Error('A Bluetooth address for the recorder is required.');
    const claims = parseAccessToken(token);
    const deviceType = deviceTypeForSerial(serial);
    const { publicKey, privateKey } = await this.generateKeyPair(token, domain);
    const signature = await this.signSerial(token, serial, domain, deviceType);
    return { identifier, serial, bindingToken: claims.sub, publicKey, privateKey, signature, deviceType };
  }
}

/** Directory that holds `plaud-device.json` (for example `~/.local/share/com.openplod.vault`). */
export const identityDirectory = () => dirname(resolve(process.env.OPENPLOD_LIBRARY_PATH || './data/recordings'));
export const identityFilePath = () => process.env.OPENPLOD_DEVICE_IDENTITY || join(identityDirectory(), 'plaud-device.json');

export const identityFileExists = () => existsSync(identityFilePath());

/** Read the saved identity without throwing when it is absent or unreadable. */
export async function readStoredIdentity(): Promise<PlaudDeviceIdentity | null> {
  try {
    const parsed = JSON.parse(await readFile(identityFilePath(), 'utf8')) as PlaudDeviceIdentity;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist an identity with owner-only permissions (the loader enforces this). */
export async function writeStoredIdentity(identity: PlaudDeviceIdentity): Promise<void> {
  const path = identityFilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Create with 0o600 up front so the key material is never briefly world-readable.
  await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

export async function clearStoredIdentity(): Promise<boolean> {
  const path = identityFilePath();
  if (!existsSync(path)) return false;
  await rm(path, { force: true });
  return true;
}

/**
 * Authorize using Plaud developer/partner credentials
 * (`plaud-developer.json` or `PLAUD_CLIENT_ID` / `PLAUD_CLIENT_SECRET`).
 * This is the officially supported, account-independent route.
 */
export async function provisionWithDeveloperCredentials(options: {
  serial: string;
  identifier: string;
  domain?: PlaudDomain;
  auth?: PlaudDeviceAuth;
  credentials?: Awaited<ReturnType<typeof readDeviceCredentials>>;
  provisioner?: PlaudIdentityProvisioner;
}): Promise<ProvisionedIdentity> {
  const credentials = options.credentials ?? await readDeviceCredentials();
  const domain = options.domain ?? (isPlaudDomain(credentials.domain) ? credentials.domain : DEFAULT_PLAUD_DOMAIN);
  if (!credentials.clientId || !credentials.clientSecret) {
    throw new Error('Add your Plaud developer client ID and secret to authorize this recorder.');
  }
  const auth = options.auth ?? new PlaudDeviceAuth();
  const session = await auth.session({ ...credentials, domain });
  const provisioner = options.provisioner ?? new PlaudIdentityProvisioner();
  return provisioner.provision({ token: session.userAccessToken, serial: options.serial, identifier: options.identifier, domain });
}
