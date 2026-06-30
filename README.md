# DETAIL Lab Website

Public website for the DETAIL Lab, with a members-only **Paper Reading** section
gated behind GitHub authentication.

- **Live site:** https://detail-vu.github.io/detail-lab/
- **Paper Reading (gated):** https://detail-vu.github.io/detail-lab/paper-reading.html
- **Public site repo:** https://github.com/wdzhwsh4067/detail-lab
- **Private content repo:** https://github.com/wdzhwsh4067/detail-lab-content

---

## Architecture overview

The site is split into two repositories:

1. **Public site repo** (`wdzhwsh4067/detail-lab`) — all the HTML pages,
   assets, and front-end logic. Served as static files by **GitHub Pages**.
   Anyone can read this repo and view the public pages. It contains **no**
   reading-group notes.

2. **Private content repo** (`wdzhwsh4067/detail-lab-content`) — holds the
   reading-group data under `data/reading/`:
   - `index.json` — the list of sessions (id, date, title, presenter, venue,
     tags, file, paperUrl).
   - one `.md` file per session — the actual notes.
   This repo is **private**. Only collaborators can read it.

### Why the gate is secure

The security boundary is **GitHub's repository permissions on the private
content repo**, not the front-end JavaScript.

- The notes never ship inside the public site. The Paper Reading page contains
  only the loader code; the content lives in the private repo.
- When a viewer signs in, the browser fetches the content **with that viewer's
  own GitHub token** directly from the GitHub Contents API:
  `GET https://api.github.com/repos/wdzhwsh4067/detail-lab-content/contents/data/reading/index.json?ref=main`
  with `Authorization: Bearer <token>`.
- GitHub itself enforces access: a collaborator's token returns **200** (and the
  base64-encoded content); a non-collaborator, an unauthenticated request, or an
  invalid token returns **401 / 403 / 404**, which the page treats as
  **"No access"**.
- Because each request is authorized by GitHub against the caller's own token,
  bypassing or patching the front-end gets you nothing — without read access to
  the private repo, GitHub will not return the content to anyone.

The front-end "gate" UI is purely a convenience/UX layer over this real,
server-side check.

---

## Two ways to log in

The Paper Reading page supports two sign-in paths:

### 1. GitHub OAuth (recommended — requires the worker to be deployed)

"Log in with GitHub" runs the standard GitHub OAuth web flow via a small
Cloudflare Worker (`oauth-worker/`). The worker holds the OAuth client secret so
it never reaches the browser; it returns a token to the page, which stores it in
`localStorage`. **This path is inactive until you complete the manual steps
below** (`DETAIL_OAUTH_BASE` in `paper-reading.html` is currently the
placeholder `REPLACE_WITH_WORKER_URL`).

### 2. Access-token fallback (works today)

On the gate screen, click **"Use an access token instead"**, paste a token, and
click **Unlock**. Create a **fine-grained personal access token** scoped to the
`detail-lab-content` repository with **Contents: Read** permission
(https://github.com/settings/personal-access-tokens), or a classic token with
the `repo` scope. The token is verified against the private repo and, on success,
stored in `localStorage` for that browser. This path is fully functional now and
needs no worker.

---

## MANUAL STEPS THE USER MUST DO (to enable GitHub OAuth login)

These steps require a GitHub OAuth App + a Cloudflare account and cannot be done
by the automation. Do them in order.

1. **Register a GitHub OAuth App.** Go to
   https://github.com/settings/developers → **New OAuth App**:
   - **Homepage URL:** `https://detail-vu.github.io/detail-lab/`
   - **Authorization callback URL:**
     `https://detail-lab-oauth.<your-workers-subdomain>.workers.dev/callback`
     (you'll learn the real subdomain after step 2 — a placeholder is fine for
     now and can be edited in step 4).
   - Copy the **Client ID** and generate a **Client Secret**.

2. **Deploy the worker:**
   ```
   cd oauth-worker
   export CLOUDFLARE_API_TOKEN=...   # or: npx wrangler login
   npx wrangler deploy
   ```
   Note the deployed URL it prints (e.g.
   `https://detail-lab-oauth.<your-subdomain>.workers.dev`).

3. **Set the worker secrets:**
   ```
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```

4. **Fix the callback URL if needed.** If the deployed worker subdomain differs
   from what you registered in step 1, edit the OAuth App's **Authorization
   callback URL** to match the real `https://<worker-url>/callback`.

5. **Wire the front end.** In `paper-reading.html`, set `DETAIL_OAUTH_BASE` to
   the deployed worker base URL (no trailing slash), then commit and push.
   Also confirm `SITE_URL` in `oauth-worker/wrangler.toml` matches the Paper
   Reading page URL
   (`https://detail-vu.github.io/detail-lab/paper-reading.html`); if you
   change it, redeploy the worker (`npx wrangler deploy`).

6. **Add lab members as collaborators on the PRIVATE repo**
   (`wdzhwsh4067/detail-lab-content` → **Settings → Collaborators**). This single
   action grants both **read** (view gated notes) and **write** (submit
   sessions). Non-collaborators get the **"No access"** screen.

---

## How submit works

Signed-in members can click **"Submit a session"** on the Paper Reading page.
The form commits directly to the private content repo using the logged-in user's
token via the GitHub Contents API:

1. `PUT data/reading/<slug>.md` — creates the new session's markdown file.
2. Reads the current `data/reading/index.json` (to get its `sha`), prepends the
   new session entry, and `PUT`s the updated `index.json`.

Because these are writes, the member must have **write access** — i.e. be a
collaborator on `detail-lab-content` (granted by step 6 above). The new session
appears once the GitHub Pages build/refresh completes.

---

## Worker specifics

See [`oauth-worker/README.md`](oauth-worker/README.md) for the worker's
endpoints (`/auth`, `/callback`), configuration vars/secrets, and deploy
details.

## Image credits
Card/topic photos are from [Unsplash](https://unsplash.com) (free license, commercial use OK) and are stored in `assets/research/` and `assets/artifacts/`. The PI photo and lab photos are the lab's own.
