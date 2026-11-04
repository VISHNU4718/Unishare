# UniShare — Fast & Secure File Sharing

Full-stack file-sharing platform with peer-to-peer transfers, encrypted storage, and real-time chat.

**Stack:** FastAPI · MongoDB (Motor) · WebSockets · React 18 · Tailwind CSS · WebRTC · Web Bluetooth · JWT

---

## Features

- **Multiple sharing paths** — direct upload/download, WebRTC P2P transfers, QR code sharing, social sharing, optional Google Drive integration
- **Encryption at rest** — each upload is encrypted with a per-file Fernet key, then RSA-wrapped (2048-bit) before hitting disk
- **Guest & registered users** — anonymous guest access (2 GB cap) or full accounts with unlimited storage
- **Real-time chat** — WebSocket chat with reactions and message pinning
- **Progress tracking** — live upload/download progress with speed and ETA
- **File permissions** — public/private files with per-user sharing
- **Responsive + dark mode** — works on desktop, tablet, and mobile

## Architecture

```
browser ──REST / WS──► FastAPI (port 8001 dev / 8000 docker)
                         ├── MongoDB   # users, files, chat, drive credentials
                         ├── WebSocket # P2P signaling + chat
                         ├── WebRTC    # 16KB-chunked DataChannel file transfer
                         └── disk      # AES-encrypted file blobs (backend/uploads/)
```

Backend is a single-file monolith (`backend/server.py`); all routes live under `/api`. WebSocket endpoint: `/api/ws/{user_id}`.

## Quick Start

### Docker (full stack: mongo + backend + nginx frontend)

```bash
docker-compose up --build
```

### Local dev

Backend (port **8001**):

```bash
cd backend
pip install -r requirements.txt
uvicorn server:app --reload --host 0.0.0.0 --port 8001
```

Frontend (port 3000, CRACO):

```bash
cd frontend
npm ci
npm start
```

> Keep `REACT_APP_BACKEND_URL` aligned with whichever backend you run (empty string = same-origin; Docker nginx proxies `/api`).

## Environment Variables

`backend/.env`:

```
MONGO_URL="mongodb://localhost:27017"
DB_NAME="test_database"
SECRET_KEY="change-this-in-production"
FRONTEND_URL="https://your-frontend-url.com"
BACKEND_URL="http://localhost:8001"
CORS_ORIGINS="http://localhost:3000"

# Optional: Google Drive integration
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
GOOGLE_DRIVE_REDIRECT_URI=""
```

`frontend/.env`:

```
REACT_APP_BACKEND_URL=https://your-backend-url.com
```

Other backend variables:

- `ENV=production` makes `SECRET_KEY` mandatory.
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` seed the first admin account. If the password is unset, a random one is generated and written to `ADMIN_CREDENTIALS.txt` (git-ignored).
- `UNISHARE_DATA_DIR` sets where `uploads/`, `keys/` and the admin credentials file are stored. Default: the `backend/` directory.
- `MONGO_URL=mongomock://local` uses an in-memory database (needs `requirements-dev.txt`). Data is lost on restart. It exists for the test-suite and quick local trials.

RSA/Fernet keys are auto-generated on first boot into `<data dir>/keys/`. Keep that directory: files already uploaded can only be decrypted with the key that encrypted them.

## Data Limits and Validation

- **Guest users:** 2 GB total (enforced server-side)
- **Registered users:** no total cap
- **Cloud upload:** 100 MB per file, read in chunks and rejected with `413` when over the limit; use P2P for anything larger
- **Usernames:** 2-32 characters. **Passwords:** 8-128 characters. Invalid input returns `422`.
- **Uploads:** filenames, extensions and folder paths are sanitised; a file can be shared with at most 50 users.
- **Downloads and previews** check ownership, public status or the share list first. Previews of HTML, SVG and XML are served with a sandboxing Content-Security-Policy.

## WebSocket Authentication

`/api/ws/{user_id}` requires the caller's JWT as `?token=...` and the token must belong to `user_id`; otherwise the socket is closed with code `4401`. Signaling messages (offer, answer, ICE candidate) are relayed with the authenticated sender id, not one supplied by the client.

## Tests and Lint

```bash
# backend tests, in-memory database and a temporary data directory
pip install -r backend/requirements-dev.txt
python -m pytest tests
ruff check backend tests

# frontend: utility, URL routing and P2P transfer regression tests, plus ESLint
cd frontend
npm ci
CI=true npx craco test --watchAll=false
npm run lint
```

The backend tests cover registration and login validation, upload limits and sanitising, encrypted storage, download and preview access control, sharing, folder zips, chat (edit, delete, react, pin), admin block/unblock/delete and WebSocket auth and signaling. The frontend tests only cover small utilities (class names, auth storage, ICE server config, offline mode); the UI and the WebRTC code are not covered by automated tests. ESLint reports no errors but still has warnings (unused variables, hook dependencies). CI runs all of the above plus a production build.

## Deployment

- Backend: Dockerized FastAPI. `render.yaml` describes a Render web service; it needs a MongoDB connection string (MongoDB Atlas has a free M0 shared cluster, 512 MB) and a persistent disk for `UNISHARE_DATA_DIR`, otherwise uploads and keys are lost on redeploy.
- Free hosting caveat: Render's free web service has an ephemeral disk and spins down after 15 minutes idle, so uploads and keys would not survive there. Free tiers are fine for trying the app, not for keeping files.
- Frontend: React build served by nginx; `REACT_APP_BACKEND_URL` must point at the deployed backend.

### Why there is no hosted demo

The app needs three things that a serverless host such as Vercel does not provide: long-lived WebSocket connections (chat and P2P signaling), a persistent disk for encrypted uploads and the server keys, and one shared MongoDB. Running it there would silently lose data between requests, so no live demo is published. Run it with Docker as above.

### Disposable local demo (no MongoDB installation)

Install Python 3.11–3.13 and Node 20 or newer, then run:

```bash
pip install -r backend/requirements-dev.txt
cd frontend
npm ci
REACT_APP_DEMO_MODE=true npm run build
cd ..
python backend/demo.py
```

On PowerShell, set the build flag with `$env:REACT_APP_DEMO_MODE='true'` before `npm run build`.
Open http://127.0.0.1:8001. This uses the real API, encrypted files and WebSocket signaling,
with an in-memory database and temporary storage. Everything resets on restart. It binds
only to the local computer and is not a persistent public deployment.

To verify it: enter as a guest, upload a sample text file using the Upload tab, preview and
download it, then open an independent browser profile for a second guest. Send a chat
message and transfer a file between both guests. For a P2P link, keep the sender tab open.
Cross-network WebRTC may require a TURN relay; public STUN servers alone cannot traverse
every firewall. Google Drive requires separate OAuth credentials and is optional.

Bluetooth is experimental code for a custom BLE peripheral, not browser-to-browser file
sharing, and is not exposed as a supported sharing path in the current interface.

## Project Layout

```
backend/    FastAPI server (server.py), requirements*.txt
frontend/   React 18 + CRACO + Tailwind + shadcn/ui
tests/      backend tests (pytest)
frontend/src/__tests__/   frontend tests (jest)
```

## Author

Vishnu B — [github.com/VISHNU4718](https://github.com/VISHNU4718)
