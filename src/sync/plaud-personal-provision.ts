import { createDecipheriv, createHmac, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchPlaudAuthorization } from './plaud-http';
import { isBluetoothIdentifier } from './plaud-bridge';
import {
  deviceTypeForSerial, normalizeAccessToken, parseAccessToken, PLAUD_SERIAL_PATTERN,
  PlaudIdentityProvisioner, provisionWithDeveloperCredentials,
  type PlaudDomain, type ProvisionedIdentity,
} from './plaud-provision';

// Consumer protocol documented by roopen219/plaude-archiver (MIT), e87f345.
// This public response-envelope key is not a user's device key or credential.
// See THIRD_PARTY_NOTICES.md; requests still require the owner's pld_ut cookie.
const ENVELOPE_KEY = Buffer.from('8rRmMCskL3NaUiGr-UsmEEeI8NKH-ZfeGbpRGqSLpuI=', 'base64url');
const REGIONS: Record<string, string> = {
  'aws:ap-southeast-1': 'https://api-apse1.plaud.ai',
  'aws:us-east-1': 'https://api-use1.plaud.ai',
  'aws:eu-central-1': 'https://api-euc1.plaud.ai',
  'aws:us-west-2': 'https://api-usw2.plaud.ai',
};
const API_HOSTS = new Set(['https://api.plaud.ai', ...Object.values(REGIONS)]);
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    throw new Error('Plaud returned invalid authorization material.');
  }
  return Buffer.from(value, 'base64');
}

function decodeEnvelope(text: string, encrypted: boolean): ObjectValue {
  try {
    if (encrypted) {
      const encoded: unknown = text.trim().startsWith('"') ? JSON.parse(text) : text.trim();
      const raw = decodeBase64(encoded);
      if (raw.length < 73 || raw[0] !== 0x80 || (raw.length - 57) % 16 !== 0) throw new Error();
      const body = raw.subarray(0, -32);
      const mac = createHmac('sha256', ENVELOPE_KEY.subarray(0, 16)).update(body).digest();
      if (!timingSafeEqual(mac, raw.subarray(-32))) throw new Error();
      const decipher = createDecipheriv('aes-128-cbc', ENVELOPE_KEY.subarray(16), raw.subarray(9, 25));
      text = Buffer.concat([decipher.update(raw.subarray(25, -32)), decipher.final()]).toString('utf8');
    }
    const envelope = object(JSON.parse(text));
    if (!envelope) throw new Error();
    return envelope;
  } catch {
    // Never echo the response: it may contain private keys or account tokens.
    throw new Error('Plaud returned an unreadable or unauthenticated authorization response.');
  }
}

/** Uses consumer /device-app endpoints, never partner SDK or device bind/reset. */
export class PlaudPersonalIdentityProvisioner {
  constructor(private readonly fetcher: Fetcher = fetchPlaudAuthorization) {}

  async provision(options: { token: string; serial: string; identifier: string; signal?: AbortSignal }): Promise<ProvisionedIdentity> {
    const { serial, identifier } = options;
    if (!PLAUD_SERIAL_PATTERN.test(serial)) throw new Error('A 16-character Plaud serial number is required.');
    if (!isBluetoothIdentifier(identifier)) throw new Error('A Bluetooth address for the recorder is required.');
    const token = normalizeAccessToken(options.token);
    const claims = parseAccessToken(token);
    if (claims.expiresAt && claims.expiresAt <= Date.now()) {
      throw new Error('Your Plaud session has expired. Sign in again.');
    }
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as ObjectValue;
    let host = typeof payload.region === 'string' ? REGIONS[payload.region] ?? 'https://api.plaud.ai' : 'https://api.plaud.ai';

    const post = async (path: string, body: ObjectValue): Promise<ObjectValue> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        options.signal?.throwIfAborted();
        let response: Response;
        try {
          response = await this.fetcher(`${host}${path}`, {
            method: 'POST', redirect: 'error', signal: options.signal
              ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
            headers: {
              Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
              'app-platform': 'web', 'edit-from': 'web', 'X-Encrypt-Response': '1',
            },
            body: JSON.stringify(body),
          });
        } catch {
          options.signal?.throwIfAborted();
          if (attempt === 0 && path.endsWith('/sn-sign')) {
            await delay(1000, undefined, { signal: options.signal });
            continue;
          }
          throw new Error('Plaud could not be reached to authorize the recorder.');
        }
        if (!response.ok) {
          // Signing an existing serial is safe to retry. Do not blindly replay
          // key generation after a response was lost or the server returned 5xx.
          if (attempt === 0 && path.endsWith('/sn-sign') && response.status >= 500) {
            await delay(1000, undefined, { signal: options.signal });
            continue;
          }
          if (response.status === 401 || response.status === 403) {
            const step = path.endsWith('/sn-sign') ? 'sn-sign' : 'gen_key';
            if ((response.headers.get('content-type') ?? '').includes('text/html')) {
              throw new Error(`Plaud access was blocked by an HTML response (HTTP ${response.status}, ${step}). This does not prove the account token is invalid.`);
            }
            throw new Error(`Plaud refused authorization (HTTP ${response.status}, ${step}). Recorder access is not authorized.`);
          }
          throw new Error(`Plaud authorization failed (HTTP ${response.status}).`);
        }
        const envelope = decodeEnvelope(await response.text(), response.headers.get('x-encrypt-response') === '1');
        const status = envelope.status ?? envelope.code;
        const data = object(envelope.data);
        if (status === -302) {
          const regionalHost = object(data?.domains)?.api;
          // Do not forward credentials to arbitrary URLs from a server response.
          if (typeof regionalHost !== 'string' || !API_HOSTS.has(regionalHost.replace(/\/$/, ''))) {
            throw new Error('Plaud returned an unsupported authorization region.');
          }
          host = regionalHost.replace(/\/$/, '');
          continue;
        }
        if (status !== 0 || !data) {
          throw new Error('Plaud refused device authorization. Sign in with the account already linked to this recorder.');
        }
        return data;
      }
      throw new Error('Plaud authorization region could not be resolved.');
    };

    // Check ownership before requesting account keys; no rebind or reset occurs.
    const signed = await post('/device-app/device/sn-sign', { sns: [serial] });
    const signature = object(signed.signature)?.[serial];
    if (decodeBase64(signature).length !== 256) throw new Error('Plaud returned an invalid recorder signature.');
    const keys = await post('/device-app/e2ee/gen_key', {});
    const privatePem = decodeBase64(keys.private_key_base64).toString('utf8');
    const publicKey = decodeBase64(keys.public_key_base64).toString('utf8');
    let privateKey: string;
    try {
      const privateObject = createPrivateKey(privatePem);
      const publicObject = createPublicKey(publicKey);
      if (privateObject.asymmetricKeyType !== 'rsa' || privateObject.asymmetricKeyDetails?.modulusLength !== 2048) throw new Error();
      const derived = createPublicKey(privateObject).export({ type: 'spki', format: 'der' });
      const supplied = publicObject.export({ type: 'spki', format: 'der' });
      if (!derived.equals(supplied)) throw new Error();
      // Both the Rust bridge and macOS Security accept Base64 PKCS#1 DER.
      // The public key stays PEM because the recorder expects PEM over BLE.
      privateKey = privateObject.export({ type: 'pkcs1', format: 'der' }).toString('base64');
    } catch {
      throw new Error('Plaud returned an invalid or mismatched RSA recorder key pair.');
    }
    return { identifier, serial, bindingToken: claims.sub, signature: signature as string, publicKey, privateKey, deviceType: deviceTypeForSerial(serial) };
  }
}

/** Explicit selection prevents personal tokens from reaching partner SDK APIs. */
export async function provisionPlaudAccount(options: {
  token?: string; accountType?: string; domain?: PlaudDomain; serial: string; identifier: string; signal?: AbortSignal;
}, fetcher?: Fetcher): Promise<ProvisionedIdentity> {
  const accountType = options.accountType ?? 'partner';
  if (accountType !== 'personal' && accountType !== 'partner') throw new Error('Unsupported Plaud account type.');
  if (accountType === 'personal') {
    if (typeof options.token !== 'string' || !options.token.trim()) throw new Error('Sign in to your Plaud account to authorize this computer.');
    return new PlaudPersonalIdentityProvisioner(fetcher).provision({ ...options, token: options.token });
  }
  return options.token?.trim()
    ? new PlaudIdentityProvisioner(fetcher).provision({ ...options, token: normalizeAccessToken(options.token) })
    : provisionWithDeveloperCredentials(options);
}
