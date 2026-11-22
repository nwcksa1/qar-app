# NWC Quality Assurance Review (QAR) — v1.2

Secure, zero-dependency Node.js (v18+) web application for NWC monthly control reviews.
No `npm install` is needed.

## What's new in v1.2

| Area | Change |
|---|---|
| Design | New UI with an NWC-style blue/teal theme, light/dark switch, SVG icons (no emoji boxes), responsive mobile menu, redesigned sign-in pages |
| Sign-in | Sign in with **username or email**, show/hide password, clear messages when the server cannot be reached |
| Admin recovery | `ADMIN_PASSWORD` is re-applied to the admin on every start, so a lost password is fixed from the hosting dashboard |
| Brute-force protection | Only failed attempts are counted: 5 per IP+user per minute, 30 per IP per minute, 10 per account per 15 minutes. Successful sign-ins from a shared office IP are never blocked |
| Temporary passwords | Users must set a personal password before using the portal |
| Headers | Added COOP, CORP and X-Permitted-Cross-Domain-Policies on top of CSP, HSTS, nosniff and frame-deny |
| Sessions | `SESSION_SECRET` env var keeps users signed in across restarts |
| Tests | 213 automated checks (was 193). Deployment is blocked if any check fails |

## Deploy on Render (recommended)

1. Push this folder to your GitHub repository (the files must sit at the repository root).
2. In Render open your service, or create one with **New → Blueprint** using `render.yaml`. Then check these settings:

   | Setting | Value |
   |---|---|
   | Build command | `node test.js` |
   | Start command | `node server.js` |
   | Health check path | `/api/health` |

3. Under **Environment**, set the following variables:

   | Variable | Value |
   |---|---|
   | `ADMIN_USERNAME` | `admin`, or an email-style name such as `admin@qar.local` |
   | `ADMIN_PASSWORD` | A strong new password: 8+ characters with letters **and** numbers. The server refuses to start with a weak one |
   | `ADMIN_EMAIL` | Optional. The admin can also sign in with this email |
   | `SESSION_SECRET` | 32+ random characters. The blueprint generates it automatically |
   | `TRUST_PROXY` | `true` |
   | `DATA_DIR` | `/var/data`. Only set this if you attach a disk |

4. **Persistent data.** On the free plan, all users and reviews are erased on every restart or redeploy. For real use, choose a paid instance and add a **Disk** (mount path `/var/data`, 1 GB) with `DATA_DIR=/var/data`.
5. Deploy. Open `https://<your-app>.onrender.com/api/health`; it should show `"status":"ok","version":"1.2.0"`.
6. Sign in at `https://<your-app>.onrender.com/admin/login.html` with `ADMIN_USERNAME` (or `ADMIN_EMAIL`) and `ADMIN_PASSWORD`.

**Lost admin password?** Change `ADMIN_PASSWORD` in Render and redeploy. The admin password is reset and existing admin sessions are signed out.

### GitHub Pages

GitHub Pages only serves static files and **cannot** run this app; sign-in will always fail there.
The root `index.html` forwards Pages visitors to `https://qar-app.onrender.com/login.html`. If your Render URL is different, edit that file.

## Run on a PC or office server

| Platform | Command |
|---|---|
| Windows | Double-click `start.bat`. Run `allow-firewall-port-3000.bat` once for LAN access |
| Linux / macOS | `./start.sh` |
| Any | `node launch.js` (same as `npm start`) |

Every launcher runs all test checks first. Production starts **only if all of them pass**.

## NWC logo

Replace `public/img/logo.svg` with the official NWC logo, keeping the same file name. It is used in the sidebar and on the sign-in pages.
To use a PNG, save it as `public/img/logo.png` and change `logo.svg` to `logo.png` in the four HTML files.

## Security summary

- Passwords are hashed with scrypt and a unique 16-byte salt; plaintext is never stored or logged.
- Sessions use HMAC-signed, HttpOnly, SameSite=Lax cookies (Secure over HTTPS) and are stored server-side as SHA-256 hashes. They last 7 days, and a password change revokes them.
- Every state-changing request is checked for a CSRF token and its Origin.
- Content-Security-Policy with no inline scripts, plus HSTS, nosniff, frame-deny, COOP/CORP and a restrictive Permissions-Policy.
- Admin and User portals are kept strictly separate. Internal notes and hidden fields are removed on the server before reaching employees.
- Evidence uploads are limited by type and size (5 MB), stored outside the web root, and downloadable only by the owner or an admin.
- CSV exports are protected against spreadsheet formula injection.
- Failed sign-ins are rate-limited and logged as `[security] failed login …`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `HOST` | 0.0.0.0 | Bind address |
| `DATA_DIR` | ./data | JSON storage and evidence files |
| `SESSION_SECRET` | auto (file) | Session signing key (32+ characters) |
| `SESSION_TTL_SECONDS` | 604800 | Session lifetime |
| `TRUST_PROXY` | auto on Render | Trust `X-Forwarded-*` headers |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_EMAIL` | admin / random / – | Bootstrap and recovery administrator |
| `ALLOWED_ORIGINS` | – | Extra allowed origins (comma separated) |

## Layout

```
server.js      HTTP server, security, workflow, CSV, notifications
launch.js      Release gate: run tests, then start production
test.js        213 automated checks (isolated temporary data)
lib/           definitions.js (rubric + 50 controls) · store.js · security.js
public/        HTML / CSS / JS front-end, img/logo.svg
index.html     GitHub Pages redirect to the live server
render.yaml · Dockerfile · .github/workflows/release.yml · start.bat · start.sh
```
