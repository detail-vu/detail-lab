# DETAIL Lab — OAuth Gatekeeper Worker

A small Cloudflare Worker that runs the GitHub OAuth web flow (Decap/netlify-cms
pattern, full-redirect variant) so the Paper Reading page can sign members in with
GitHub without exposing the client secret in the browser.

## Endpoints

- `GET /auth` — 302 redirects to GitHub's authorize page and sets a short-lived
  HttpOnly `state` cookie for CSRF protection.
- `GET /callback` — verifies `state` against the cookie, exchanges the `code` for
  an access token, then 302 redirects to `SITE_URL#access_token=<token>`
  (or `SITE_URL#error=<msg>` on failure).

## Configuration

- **Vars** (in `wrangler.toml`):
  - `SITE_URL` — the page that consumes the token (must match the deployed page).
  - `SCOPE` — OAuth scope; defaults to `repo` (needed to read the private content repo).
- **Secrets** (never committed — set via `wrangler secret put`):
  - `GITHUB_CLIENT_ID`
  - `GITHUB_CLIENT_SECRET`

## Deploy steps

1. **Register a GitHub OAuth App**
   (GitHub → Settings → Developer settings → OAuth Apps → New OAuth App).
   Set the **Authorization callback URL** to:
   ```
   https://detail-lab-oauth.<your-subdomain>.workers.dev/callback
   ```
   (You will learn `<your-subdomain>` after the first deploy in step 3; you can
   create the app with a placeholder and edit the callback URL afterwards.)
   Note the generated **Client ID** and **Client Secret**.

2. **Install wrangler** (or use `npx`):
   ```
   npm i -g wrangler
   ```
   (Alternatively prefix the commands below with `npx`.)

3. **Deploy the worker**:
   ```
   export CLOUDFLARE_API_TOKEN=...
   npx wrangler deploy
   ```
   The output prints the deployed URL, e.g.
   `https://detail-lab-oauth.<your-subdomain>.workers.dev`.

4. **Set the secrets**:
   ```
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```

5. **Wire the front end**: copy the deployed worker URL (no trailing slash) into
   `DETAIL_OAUTH_BASE` in `paper-reading.html`. If the deployed page path differs
   from the default, also update `SITE_URL` in `wrangler.toml`.

6. **Redeploy** the worker after editing `wrangler.toml`:
   ```
   npx wrangler deploy
   ```

## Notes

- The token is returned to the browser in the URL hash; the page strips it from
  the URL with `history.replaceState` and stores it in `localStorage`.
- The worker holds no state of its own beyond the short-lived `state` cookie.
