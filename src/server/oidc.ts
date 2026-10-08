// Sign-in through an OpenID Connect provider of your choosing (FINANCE_OIDC_ISSUER), named in the UI by
// FINANCE_OIDC_NAME.
//
// Authorization code flow with PKCE, state and nonce. openid-client verifies the ID token (its
// signature against the provider's JWKS, issuer, audience, expiry, nonce). The provider may decide who
// can reach this client at all; this module then accepts only a verified email address on
// FINANCE_OIDC_ALLOWED_EMAILS and signs it in as FINANCE_USERNAME, the one user this app has. The
// session that follows is the ordinary one from auth.ts.
//
// Privacy: the server talks to the provider only for discovery, the token exchange, its signing keys
// and (if the ID token lacks an email) userinfo. Nothing about the finances goes there.

import * as client from 'openid-client';
import { isLoopbackHost } from './config';

export const OIDC_SCOPES = 'openid profile email';
export const CALLBACK_PATH = '/api/auth/oidc/callback';
export const LOGIN_PATH = '/api/auth/oidc/login';

export interface OidcSettings {
  issuer: string;
  /** What the sign-in page calls the provider ("Sign in with …"): FINANCE_OIDC_NAME, else the issuer's host. */
  name: string;
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
  if (!env.FINANCE_USERNAME?.trim()) throw missing('FINANCE_USERNAME (the user an OIDC sign-in maps to)');
  const allowedEmails = (env.FINANCE_OIDC_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!allowedEmails.length) throw missing('FINANCE_OIDC_ALLOWED_EMAILS');
  const issuer = env.FINANCE_OIDC_ISSUER?.trim().replace(/\/+$/, '');
  if (!issuer) throw missing("FINANCE_OIDC_ISSUER (your provider's issuer URL)");
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new Error('FINANCE_OIDC_ISSUER must be a URL.');
  }
  if (issuerUrl.protocol !== 'https:' && !isLoopbackHost(issuerUrl.hostname)) throw new Error('FINANCE_OIDC_ISSUER must be https.');
  const name = env.FINANCE_OIDC_NAME?.trim() || issuerUrl.hostname;
  let redirectUri = env.FINANCE_OIDC_REDIRECT_URI?.trim();
  if (!redirectUri) {
    if (!allowedHosts[0]) throw missing('FINANCE_OIDC_REDIRECT_URI (or FINANCE_ALLOWED_HOSTS to derive it)');
    redirectUri = `https://${allowedHosts[0]}${CALLBACK_PATH}`;
  }
  const redirect = new URL(redirectUri);
  if (redirect.pathname !== CALLBACK_PATH) throw new Error(`FINANCE_OIDC_REDIRECT_URI must end in ${CALLBACK_PATH}.`);
  if (redirect.protocol !== 'https:' && !isLoopbackHost(redirect.hostname)) throw new Error('FINANCE_OIDC_REDIRECT_URI must be https.');
  return { issuer, name, clientId, clientSecret, redirectUri, allowedEmails };
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

  /**
   * Discovery is lazy and memoised; a failure is forgotten so the next sign-in retries. ID tokens are
   * expected signed with RS256 (OIDC's default) when the provider offers it, else with the first
   * algorithm it lists (ES256, say).
   */
  private config(): Promise<client.Configuration> {
    if (!this.configPromise) {
      const { issuer, clientId, clientSecret } = this.settings;
      // Plain http only for a provider on this machine (the tests' stand-in).
      const insecure = new URL(issuer).protocol === 'http:' && isLoopbackHost(new URL(issuer).hostname);
      this.configPromise = client
        .discovery(new URL(issuer), clientId, undefined, client.ClientSecretBasic(clientSecret), insecure ? { execute: [client.allowInsecureRequests] } : {})
        .then((found) => {
          const algs = found.serverMetadata().id_token_signing_alg_values_supported ?? [];
          if (!algs.length || algs.includes('RS256')) return found;
          const config = new client.Configuration(found.serverMetadata(), clientId, { id_token_signed_response_alg: algs[0] }, client.ClientSecretBasic(clientSecret));
          if (insecure) client.allowInsecureRequests(config);
          return config;
        })
        .catch((err: unknown) => {
          this.configPromise = null;
          throw new OidcError('idp_unreachable', `${this.settings.name}: discovery failed: ${(err as Error).message}`);
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
    if (query.has('error')) throw new OidcError('idp_denied', `${this.settings.name} returned ${query.get('error')}`);
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
      throw new OidcError('invalid_response', `${this.settings.name} sign-in could not be verified: ${(err as Error).message}`);
    }
    const claims = tokens.claims();
    if (!claims?.sub) throw new OidcError('invalid_response', `${this.settings.name} returned no subject`);
    let email = claims.email;
    let verified = claims.email_verified;
    if (typeof email !== 'string') {
      try {
        const info = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
        email = info.email;
        verified = info.email_verified;
      } catch (err) {
        throw new OidcError('invalid_response', `${this.settings.name} userinfo failed: ${(err as Error).message}`);
      }
    }
    if (typeof email !== 'string' || !email) throw new OidcError('not_allowed', `${this.settings.name} returned no email address`);
    const normalised = email.trim().toLowerCase();
    // An unverified address is only something someone typed; it proves nothing.
    if (verified !== true) throw new OidcError('not_allowed', `${normalised} is not verified at ${this.settings.name}`);
    if (!this.settings.allowedEmails.includes(normalised)) throw new OidcError('not_allowed', `${normalised} is not in FINANCE_OIDC_ALLOWED_EMAILS`);
    return { sub: claims.sub, email: normalised };
  }
}
