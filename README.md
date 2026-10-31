# UniShare — Fast & Secure File Sharing

Full-stack file-sharing platform with peer-to-peer transfers, encrypted storage, and real-time chat.

**Stack:** FastAPI · MongoDB (Motor) · WebSockets · React 18 · Tailwind CSS · WebRTC · Web Bluetooth · JWT

---

## Features

- **Multiple sharing paths** — direct upload/download, WebRTC P2P transfers (LAN & offline), Bluetooth sharing, QR code sharing, social sharing, optional Google Drive integration
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

## Data Limits

- **Guest users:** 2 GB total (enforced server-side)
- **Registered users:** no total cap
- **Cloud upload:** 100 MB per file; use P2P for anything larger

## Tests

```bash
pip install -r backend/requirements-dev.txt
python -m pytest tests
```

The backend tests run against an in-memory database and a temporary data directory. They cover auth, upload/download with encryption on disk, private-file access control, deletion, chat validation and admin permissions. The frontend has no automated tests; CI only checks that it builds.

## Deployment

- Backend: Dockerized FastAPI. `render.yaml` describes a Render web service; it needs a MongoDB connection string (for example MongoDB Atlas) and a persistent disk for `UNISHARE_DATA_DIR`, otherwise uploads and keys are lost on redeploy.
- Frontend: React build served by nginx; `REACT_APP_BACKEND_URL` must point at the deployed backend.

### Why there is no hosted demo

The app needs three things that a serverless host such as Vercel does not provide: long-lived WebSocket connections (chat and P2P signaling), a persistent disk for encrypted uploads and the server keys, and one shared MongoDB. Running it there would silently lose data between requests, so no live demo is published. Run it with Docker as above.

## Project Layout

```
backend/    FastAPI server (server.py), requirements*.txt
frontend/   React 18 + CRACO + Tailwind + shadcn/ui
tests/      backend tests (pytest)
```

## Author

Vishnu B — [github.com/VISHNU4718](https://github.com/VISHNU4718)
