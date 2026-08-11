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
yarn install
yarn start
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

RSA/Fernet keys are auto-generated on first boot into `backend/keys/`.

## Data Limits

- **Guest users:** 2 GB total (enforced server-side)
- **Registered users:** unlimited

## Deployment

- Backend: Dockerized FastAPI, deployable to Render / AWS (see `render.yaml`)
- Frontend: React build served by nginx; `REACT_APP_BACKEND_URL` must point at the deployed backend

## Project Layout

```
backend/    FastAPI server (server.py, keys/, uploads/)
frontend/   React 18 + CRACO + Tailwind + shadcn/ui
tests/      backend tests
```

## Author

Vishnu B — [github.com/VISHNU4718](https://github.com/VISHNU4718)
