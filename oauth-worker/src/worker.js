// DETAIL Lab — access gatekeeper (Cloudflare Worker)
//
// Routes:
//   GET  /auth      -> 302 to GitHub's authorize endpoint (sets CSRF state cookie)
//   GET  /callback  -> verifies state, exchanges code for token, 302 to SITE_URL#access_token=...
//   POST /unlock     -> { password } ; if it matches VIEW_PASSWORD, returns a signed,
//                       short-lived read-only session token (HMAC). Used by the page's
//                       "view with a password" path.
//   GET  /content    -> ?path=data/reading/...&ref=main ; requires a valid session token
//                       (Authorization: Bearer <session>). Proxies the PRIVATE content repo
//                       via CONTENT_TOKEN (server-side only) and returns the GitHub
//                       Contents JSON. Path is restricted to data/reading/* (read-only).
//
// Secrets (wrangler secret put):  GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, VIEW_PASSWORD, CONTENT_TOKEN
//                                  (optional) SESSION_SECRET — dedicated HMAC key for /unlock sessions
// Vars (wrangler.toml):           SITE_URL, SCOPE, CONTENT_REPO  (e.g. "detail-vu/detail-lab-content")

const STATE_COOKIE = 'detail_oauth_state';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h read-only session

function randomState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function redirect(location, extraHeaders) {
  const headers = { Location: location };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return new Response(null, { status: 302, headers });
}

// ── CORS ──────────────────────────────────────────────────
function allowedOrigin(siteUrl) {
  try { return new URL(siteUrl).origin; } catch (e) { return '*'; }
}
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}

// ── Signed session (HMAC-SHA256 over the expiry) ──────────
function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}
function timingEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function mintSession(key) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = b64url(String(exp));
  const sig = await hmacHex(key, payload);
  return payload + '.' + sig;
}
async function verifySession(key, token) {
  if (!token || token.indexOf('.') < 0) return false;
  const dot = token.indexOf('.');
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = await hmacHex(key, payload);
  if (!timingEqual(sig, expect)) return false;
  let exp;
  try { exp = parseInt(b64urlDecode(payload), 10); } catch (e) { return false; }
  return Number.isFinite(exp) && Date.now() < exp;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const workerOrigin = url.origin;
    const siteUrl = env.SITE_URL || '/';
    const scope = env.SCOPE || 'repo';
    const origin = allowedOrigin(siteUrl);
    const cors = corsHeaders(origin);
    // Sign read-only sessions with a dedicated secret; fall back to the OAuth client
    // secret (already configured) — NEVER the content PAT, to keep key separation so
    // rotating the content token doesn't invalidate sessions and vice versa.
    const sessionKey = env.SESSION_SECRET || env.GITHUB_CLIENT_SECRET || '';

    // ── CORS preflight for the XHR endpoints ──────────────
    if (request.method === 'OPTIONS' && (url.pathname === '/unlock' || url.pathname === '/content')) {
      return new Response(null, { status: 204, headers: cors });
    }

    // ── GET /auth ───────────────────────────────────────────
    if (url.pathname === '/auth') {
      const state = randomState();
      const authorize = new URL('https://github.com/login/oauth/authorize');
      authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID || '');
      authorize.searchParams.set('redirect_uri', workerOrigin + '/callback');
      authorize.searchParams.set('scope', scope);
      authorize.searchParams.set('state', state);
      const cookie = `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
      return redirect(authorize.toString(), { 'Set-Cookie': cookie });
    }

    // ── GET /callback ───────────────────────────────────────
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const cookies = parseCookies(request.headers.get('Cookie'));
      const expectedState = cookies[STATE_COOKIE];
      const clearCookie = `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

      if (!code) {
        return redirect(siteUrl + '#error=' + encodeURIComponent('missing_code'), { 'Set-Cookie': clearCookie });
      }
      if (!returnedState || !expectedState || returnedState !== expectedState) {
        return redirect(siteUrl + '#error=' + encodeURIComponent('state_mismatch'), { 'Set-Cookie': clearCookie });
      }

      try {
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: workerOrigin + '/callback',
          }),
        });
        const data = await tokenRes.json();
        if (data && data.access_token) {
          return redirect(siteUrl + '#access_token=' + encodeURIComponent(data.access_token), { 'Set-Cookie': clearCookie });
        }
        const msg = (data && (data.error_description || data.error)) || 'token_exchange_failed';
        return redirect(siteUrl + '#error=' + encodeURIComponent(msg), { 'Set-Cookie': clearCookie });
      } catch (e) {
        return redirect(siteUrl + '#error=' + encodeURIComponent('token_exchange_error'), { 'Set-Cookie': clearCookie });
      }
    }

    // ── POST /unlock ────────────────────────────────────────
    if (url.pathname === '/unlock' && request.method === 'POST') {
      if (!env.VIEW_PASSWORD || !sessionKey) {
        return json({ error: 'password access not configured' }, 500, cors);
      }
      let body = {};
      try { body = await request.json(); } catch (e) { body = {}; }
      const pw = (body && typeof body.password === 'string') ? body.password : '';
      if (!timingEqual(pw, env.VIEW_PASSWORD)) {
        return json({ error: 'wrong password' }, 401, cors);
      }
      const session = await mintSession(sessionKey);
      return json({ session, expiresInMs: SESSION_TTL_MS }, 200, cors);
    }

    // ── GET /content ────────────────────────────────────────
    if (url.pathname === '/content' && request.method === 'GET') {
      if (!env.CONTENT_TOKEN || !env.CONTENT_REPO || !sessionKey) {
        return json({ error: 'content proxy not configured' }, 500, cors);
      }
      const auth = request.headers.get('Authorization') || '';
      const token = auth.replace(/^Bearer\s+/i, '').trim();
      if (!(await verifySession(sessionKey, token))) {
        return json({ error: 'invalid or expired session' }, 401, cors);
      }
      const path = url.searchParams.get('path') || '';
      const ref = 'main'; // pinned — viewers can only see the default branch
      // Restrict to the reading notes — read-only viewers can't reach anything else.
      // Every segment must start alphanumeric (blocks '..', '.', dotfiles, empty segments).
      const segs = path.split('/');
      const safePath = path.startsWith('data/reading/')
        && segs.length >= 3
        && segs.every((s) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s));
      if (!safePath) {
        return json({ error: 'forbidden path' }, 403, cors);
      }
      const ghUrl = 'https://api.github.com/repos/' + env.CONTENT_REPO + '/contents/'
        + path.split('/').map(encodeURIComponent).join('/')
        + '?ref=' + encodeURIComponent(ref);
      const ghRes = await fetch(ghUrl, {
        headers: {
          'Authorization': 'Bearer ' + env.CONTENT_TOKEN,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'detail-lab-worker',
        },
      });
      const text = await ghRes.text();
      return new Response(text, {
        status: ghRes.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
      });
    }

    // ── Anything else ───────────────────────────────────────
    return new Response('DETAIL Lab gatekeeper. Endpoints: /auth, /callback, /unlock, /content', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
