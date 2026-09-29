// Sign-in through jemedia-auth, the owner's OpenID Connect provider (auth.jemedia.xyz).
//
// Authorization code flow with PKCE, state and nonce. openid-client verifies the ID token (ES256
// signature against the provider's JWKS, issuer, audience, expiry, nonce). jemedia-auth decides who
// may reach this client at all (membership of the client's tenant); this module then accepts only a
// verified email address on FINANCE_OIDC_ALLOWED_EMAILS and signs it in as FINANCE_USERNAME, the one
// user this app has. The session that follows is the ordinary one from auth.ts.
//
// Privacy: the server talks to the provider only for discovery, the token exchange, its signing keys
// and (if the ID token lacks an email) userinfo. Nothing about the finances goes there.

import * as client from 'openid-client';
import { isLoopbackHost } from './config';

export const DEFAULT_ISSUER = 'https://auth.jemedia.xyz';
export const OIDC_SCOPES = 'openid profile email';
export const CALLBACK_PATH = '/api/auth/oidc/callback';
export const LOGIN_PATH = '/api/auth/oidc/login';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Lower-cased. Only these (verified) addresses may sign in. */
  allowedEmails: string[];
}

/**
 * OIDC is on when FINANCE_OIDC_CLIENT_ID is set. Anything missing around it is a startup error, so a
 * half-configured deployment fails closed instead of falling back to another way in.
 */
export function oidcSettingsFromEnv(env: NodeJS.ProcessEnv, allowedHosts: string[]): OidcSettings | null {
  const clientId = env.FINANCE_OIDC_CLIENT_ID?.trim();
  if (!clientId) return null;
  const missing = (name: string) => new Error(`FINANCE_OIDC_CLIENT_ID is set, so ${name} is required.`);
  const clientSecret = env.FINANCE_OIDC_CLIENT_SECRET?.trim();
  if (!clientSecret) throw missing('FINANCE_OIDC_CLIENT_SECRET');
  if (!env.FINANCE_USERNAME?.trim()) throw missing('FINANCE_USERNAME (the user a jemedia-auth sign-in maps to)');
  const allowedEmails = (env.FINANCE_OIDC_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!allowedEmails.length) throw missing('FINANCE_OIDC_ALLOWED_EMAILS');
  const issuer = (env.FINANCE_OIDC_ISSUER?.trim() || DEFAULT_ISSUER).replace(/\/+$/, '');
  let redirectUri = env.FINANCE_OIDC_REDIRECT_URI?.trim();
  if (!redirectUri) {
    if (!allowedHosts[0]) throw missing('FINANCE_OIDC_REDIRECT_URI (or FINANCE_ALLOWED_HOSTS to derive it)');
    redirectUri = `https://${allowedHosts[0]}${CALLBACK_PATH}`;
  }
  const redirect = new URL(redirectUri);
  if (redirect.pathname !== CALLBACK_PATH) throw new Error(`FINANCE_OIDC_REDIRECT_URI must end in ${CALLBACK_PATH}.`);
  if (redirect.protocol !== 'https:' && !isLoopbackHost(redirect.hostname)) throw new Error('FINANCE_OIDC_REDIRECT_URI must be https.');
  return { issuer, clientId, clientSecret, redirectUri, allowedEmails };
}

/** What the login step stores (signed, in a short-lived cookie) for the callback to check. */
export interface OidcFlow {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
}

export type OidcFailure = 'idp_unreachable' | 'idp_denied' | 'invalid_response' | 'not_allowed';

export class OidcError extends Error {
  constructor(
    readonly code: OidcFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface OidcIdentity {
  sub: string;
  email: string;
}

export class OidcClient {
  private configPromise: Promise<client.Configuration> | null = null;

  constructor(readonly settings: OidcSettings) {}

  /** Discovery is lazy and memoised; a failure is forgotten so the next sign-in retries. */
  private config(): Promise<client.Configuration> {
    if (!this.configPromise) {
      const { issuer, clientId, clientSecret } = this.settings;
      // Plain http only for a provider on this machine (the tests' stand-in).
      const insecure = new URL(issuer).protocol === 'http:' && isLoopbackHost(new URL(issuer).hostname);
      this.configPromise = client
        .discovery(new URL(issuer), clientId, { id_token_signed_response_alg: 'ES256' }, client.ClientSecretBasic(clientSecret), insecure ? { execute: [client.allowInsecureRequests] } : {})
        .catch((err: unknown) => {
          this.configPromise = null;
          throw new OidcError('idp_unreachable', `jemedia-auth discovery failed: ${(err as Error).message}`);
        });
    }
    return this.configPromise;
  }

  /** The provider's authorize URL, and the checks the callback must match. */
  async start(next: string): Promise<{ url: string; flow: OidcFlow }> {
    const config = await this.config();
    const verifier = client.randomPKCECodeVerifier();
    const flow: OidcFlow = { state: client.randomState(), nonce: client.randomNonce(), verifier, next };
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.settings.redirectUri,
      scope: OIDC_SCOPES,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state: flow.state,
      nonce: flow.nonce,
    });
    return { url: url.href, flow };
  }

  /**
   * Exchange the code and check who came back. `query` is the callback's query string. The URL handed
   * to openid-client is rebuilt on the registered redirect URI: behind Caddy the request URL says
   * http://, and the token request's redirect_uri must match the registration exactly.
   */
  async finish(query: URLSearchParams, flow: OidcFlow): Promise<OidcIdentity> {
    if (query.has('error')) throw new OidcError('idp_denied', `jemedia-auth returned ${query.get('error')}`);
    const config = await this.config();
    const current = new URL(this.settings.redirectUri);
    current.search = query.toString();
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
    } catch (err) {
      throw new OidcError('invalid_response', `jemedia-auth sign-in could not be verified: ${(err as Error).message}`);
    }
    const claims = tokens.claims();
    if (!claims?.sub) throw new OidcError('invalid_response', 'jemedia-auth returned no subject');
    let email = claims.email;
    let verified = claims.email_verified;
    if (typeof email !== 'string') {
      try {
        const info = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
        email = info.email;
        verified = info.email_verified;
      } catch (err) {
        throw new OidcError('invalid_response', `jemedia-auth userinfo failed: ${(err as Error).message}`);
      }
    }
    if (typeof email !== 'string' || !email) throw new OidcError('not_allowed', 'jemedia-auth returned no email address');
    const normalised = email.trim().toLowerCase();
    // An unverified address is only something someone typed; it proves nothing.
    if (verified !== true) throw new OidcError('not_allowed', `${normalised} is not verified at jemedia-auth`);
    if (!this.settings.allowedEmails.includes(normalised)) throw new OidcError('not_allowed', `${normalised} is not in FINANCE_OIDC_ALLOWED_EMAILS`);
    return { sub: claims.sub, email: normalised };
  }
}
