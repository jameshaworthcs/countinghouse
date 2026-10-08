// A stand-in for an OpenID Connect provider on loopback, for the OIDC tests: discovery, a JWKS, an authorize
// endpoint that signs in whoever the test says and redirects straight back, a token endpoint that
// checks the client secret, the redirect URI and PKCE, and ES256 ID tokens (an algorithm other than OIDC's default RS256).

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

export interface MockUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
}

export interface MockIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Who the next /authorize signs in. */
  user: MockUser;
  /** When set, /authorize redirects back with this OAuth error instead of a code. */
  denyWith: string | null;
  /** Leave the email out of the ID token (as a provider may), so the client has to ask userinfo. */
  emailOnlyInUserinfo: boolean;
  /** Authorization requests received, for assertions. */
  requests: URLSearchParams[];
  close(): Promise<void>;
}

export async function startMockIdp(opts: { clientId?: string; clientSecret?: string; redirectUri?: string } = {}): Promise<MockIdp> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; user: MockUser }>();
  const tokens = new Map<string, MockUser>();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', idp.issuer);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(200, {
          issuer: idp.issuer,
          authorization_endpoint: `${idp.issuer}/oauth/authorize`,
          token_endpoint: `${idp.issuer}/oauth/token`,
          userinfo_endpoint: `${idp.issuer}/oauth/userinfo`,
          jwks_uri: `${idp.issuer}/.well-known/jwks.json`,
          end_session_endpoint: `${idp.issuer}/logout`,
          response_types_supported: ['code'],
          id_token_signing_alg_values_supported: ['ES256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          subject_types_supported: ['public'],
        });
      }
      if (url.pathname === '/.well-known/jwks.json') return json(200, { keys: [jwk] });
      if (url.pathname === '/oauth/authorize') {
        const p = url.searchParams;
        idp.requests.push(p);
        const redirectUri = p.get('redirect_uri') ?? '';
        if (p.get('client_id') !== idp.clientId || (opts.redirectUri && redirectUri !== opts.redirectUri)) return json(400, { error: 'invalid_request' });
        const back = new URL(redirectUri);
        if (idp.denyWith) back.searchParams.set('error', idp.denyWith);
        else {
          const code = randomBytes(16).toString('base64url');
          codes.set(code, { nonce: p.get('nonce') ?? '', challenge: p.get('code_challenge') ?? '', redirectUri, user: { ...idp.user } });
          back.searchParams.set('code', code);
        }
        back.searchParams.set('state', p.get('state') ?? '');
        res.writeHead(303, { location: back.href });
        return res.end();
      }
      if (url.pathname === '/oauth/token' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += String(chunk);
        const form = new URLSearchParams(body);
        const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
        const [id, secret] = basic.split(':').map((s) => decodeURIComponent(s));
        if (id !== idp.clientId || secret !== idp.clientSecret) return json(401, { error: 'invalid_client' });
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!grant) return json(400, { error: 'invalid_grant' });
        if (form.get('redirect_uri') !== grant.redirectUri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri' });
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (challenge !== grant.challenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' });
        const { user } = grant;
        const claims: Record<string, unknown> = { nonce: grant.nonce };
        if (!idp.emailOnlyInUserinfo && user.email !== undefined) Object.assign(claims, { email: user.email, email_verified: user.email_verified ?? false });
        const idToken = await new SignJWT(claims)
          .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
          .setIssuer(idp.issuer)
          .setAudience(idp.clientId)
          .setSubject(user.sub)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        const accessToken = randomBytes(16).toString('base64url');
        tokens.set(accessToken, user);
        return json(200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idToken });
      }
      if (url.pathname === '/oauth/userinfo') {
        const user = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
        if (!user) return json(401, { error: 'invalid_token' });
        return json(200, { sub: user.sub, email: user.email, email_verified: user.email_verified ?? false });
      }
      json(404, { error: 'not_found' });
    })().catch((err: unknown) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const idp: MockIdp = {
    issuer: `http://127.0.0.1:${port}`,
    clientId: opts.clientId ?? 'finance-test',
    clientSecret: opts.clientSecret ?? 'test-client-secret',
    user: { sub: 'user-1', email: 'james@example.com', email_verified: true },
    denyWith: null,
    emailOnlyInUserinfo: false,
    requests: [],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return idp;
}
