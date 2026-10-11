import http from 'node:http';
import { randomBytes, createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { openBrowser } from './platform.mjs';
import { readCredential, saveCredential } from './storage.mjs';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const random = () => randomBytes(32).toString('base64url');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`OpenAI authorization returned HTTP ${response.status}. Sign in again if the grant expired.`);
  return response.json();
}
export async function validateIdentity(token, clientId, nonce) {
  const parts = token?.split('.') || [];
  if (parts.length !== 3) throw new Error('The ID token is malformed.');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unsupported ID-token signature.');
  const { keys } = await jsonFetch(`${issuer}/.well-known/jwks.json`);
  const key = keys.find(value => value.kid === header.kid && value.kty === 'RSA' && (!value.use || value.use === 'sig'));
  if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error('ID-token signature verification failed.');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || !audiences.includes(clientId) || typeof claims.exp !== 'number' || claims.exp <= Date.now() / 1000 || (claims.nbf && claims.nbf > Date.now() / 1000 + 30) || !same(claims.nonce, nonce) || typeof claims.sub !== 'string' || (audiences.length > 1 && claims.azp !== clientId)) throw new Error('ID-token identity validation failed.');
  return claims;
}
export class ChatGPTSignIn {
  constructor(state, onComplete, onStatus) { this.state = state; this.onComplete = onComplete; this.onStatus = onStatus; }
  async begin() {
    if (this.listener) throw new Error('A browser sign-in is already pending.');
    const previous = await readCredential();
    const transaction = { state: random(), nonce: random(), verifier: random(), clientId: previous?.client_id || 'dynamic_agent_client' };
    const listener = http.createServer(async (request, response) => {
      try {
        const address = new URL(request.url, transaction.redirect);
        if (request.method !== 'GET' || address.pathname !== '/auth/callback') { response.writeHead(404).end(); return; }
        if (transaction.consumed || !same(address.searchParams.get('state'), transaction.state)) throw new Error('Authorization state did not match.');
        transaction.consumed = true;
        if (address.searchParams.has('error')) throw new Error('ChatGPT sign-in was declined or did not complete.');
        const issued = address.searchParams.get('client_id') || (transaction.clientId !== 'dynamic_agent_client' ? transaction.clientId : null);
        if (!issued || issued === 'dynamic_agent_client' || (previous && issued !== previous.client_id)) throw new Error('The issued client registration did not match.');
        const code = address.searchParams.get('code');
        if (!code) throw new Error('No authorization code was returned.');
        const tokens = await jsonFetch(`${issuer}/api/accounts/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: issued, code, code_verifier: transaction.verifier, redirect_uri: transaction.redirect, resource }) });
        const identity = await validateIdentity(tokens.id_token, issued, transaction.nonce);
        if (previous && previous.subject !== identity.sub) throw new Error('The returning ChatGPT account did not match.');
        const scopes = String(tokens.scope || '').split(' ');
        if (!scopes.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke') || !tokens.access_token || tokens.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error('ChatGPT plan permission or valid token lifetime was not granted.');
        await saveCredential({ ...tokens, client_id: issued, subject: identity.sub, email: identity.email, issuer, scopes, saved_at: Date.now(), ext_agent_host_id: this.state.hostId });
        response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ChatGPT sign-in completed. Return to Microsoft Volterra.');
        await this.onComplete();
      } catch (error) {
        if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Sign-in could not complete. Return to Microsoft Volterra for details.');
        this.onStatus(error.message);
      } finally { if (transaction.consumed) this.cancel(); }
    });
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    this.listener = listener;
    transaction.redirect = `http://127.0.0.1:${listener.address().port}/auth/callback`;
    const address = new URL(`${issuer}/api/accounts/authorize`);
    const params = { client_id: transaction.clientId, ext_agent_host_id: this.state.hostId, response_type: 'code', redirect_uri: transaction.redirect, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource, state: transaction.state, nonce: transaction.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(transaction.verifier).digest('base64url') };
    if (transaction.clientId === 'dynamic_agent_client') params.agent_name_hint = 'volterra_workspace';
    if (previous?.id_token) params.id_token_hint = previous.id_token;
    for (const [key, value] of Object.entries(params)) address.searchParams.set(key, value);
    this.timer = setTimeout(() => { this.cancel(); this.onStatus('ChatGPT browser sign-in expired. Try again.'); }, 10 * 60_000);
    try { await openBrowser(address.href); } catch (error) { this.cancel(); throw error; }
    return { status: 'Waiting for browser sign-in' };
  }
  cancel() { clearTimeout(this.timer); this.listener?.close(); this.listener = null; }
  async accessToken() {
    let credential = await readCredential();
    if (!credential) throw new Error('Continue with ChatGPT before starting the agent.');
    if (Date.now() < credential.saved_at + (credential.expires_in - 120) * 1000) return credential.access_token;
    if (!this.refreshing) this.refreshing = (async () => {
      if (!credential.refresh_token) throw new Error('Sign in with ChatGPT again to renew access.');
      const tokens = await jsonFetch(`${issuer}/api/accounts/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: credential.client_id, refresh_token: credential.refresh_token, resource }) });
      const scopes = tokens.scope ? tokens.scope.split(' ') : credential.scopes;
      if (!scopes.includes('chatgpt.tokens.use.direct') || !tokens.access_token) throw new Error('ChatGPT plan access needs new authorization.');
      credential = { ...credential, ...tokens, scopes, saved_at: Date.now() };
      await saveCredential(credential);
      return credential.access_token;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
}
