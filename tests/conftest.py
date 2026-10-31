import os
import sys
import tempfile
from pathlib import Path

import pytest

# Environment must be set before the server module is imported.
_DATA = tempfile.mkdtemp(prefix="unishare-tests-")
os.environ.update(
    {
        "MONGO_URL": "mongomock://test",
        "DB_NAME": "unishare_test",
        "SECRET_KEY": "test-secret-key-not-for-production",
        "UNISHARE_DATA_DIR": _DATA,
        "ADMIN_EMAIL": "admin@example.com",
        "ADMIN_PASSWORD": "admin-test-password",
        "CORS_ORIGINS": "http://localhost:3000",
    }
)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from fastapi.testclient import TestClient  # noqa: E402

import server  # noqa: E402

server.limiter.enabled = False


@pytest.fixture(scope="session")
def client():
    with TestClient(server.app) as c:
        yield c


@pytest.fixture()
def guest(client):
    """A fresh guest account: returns (auth headers, user dict)."""
    name = f"guest{os.urandom(3).hex()}"
    r = client.post("/api/auth/guest", json={"username": name, "emoji": "🙂"})
    assert r.status_code == 200, r.text
    body = r.json()
    return {"Authorization": f"Bearer {body['access_token']}"}, body["user"]
