import os

import server


def test_health(client):
    body = client.get("/health").json()
    assert body["status"] == "healthy"


def test_encryption_round_trip():
    data = os.urandom(5000)
    encrypted, key = server.encrypt_file_content(data)
    assert encrypted != data
    assert server.decrypt_file_content(encrypted, key) == data


def test_guest_and_me(client, guest):
    headers, user = guest
    me = client.get("/api/auth/me", headers=headers).json()
    assert me["id"] == user["id"] and me["is_guest"] is True


def test_duplicate_guest_username_rejected(client, guest):
    _, user = guest
    r = client.post("/api/auth/guest", json={"username": user["username"], "emoji": "🙂"})
    assert r.status_code == 409


def test_register_login_and_bad_password(client):
    email = f"user{os.urandom(3).hex()}@example.com"
    reg = client.post(
        "/api/auth/register",
        json={"username": f"u{os.urandom(3).hex()}", "email": email, "password": "correct-horse-1"},
    )
    assert reg.status_code == 200, reg.text
    assert client.post("/api/auth/register", json={"username": "other1", "email": email, "password": "x" * 10}).status_code == 400
    ok = client.post("/api/auth/login", json={"email": email, "password": "correct-horse-1"})
    assert ok.status_code == 200 and ok.json()["access_token"]
    bad = client.post("/api/auth/login", json={"email": email, "password": "wrong"})
    assert bad.status_code in (400, 401)


def test_me_requires_token(client):
    assert client.get("/api/auth/me").status_code in (401, 403)
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer nonsense"}).status_code == 401


def test_upload_download_round_trip_is_encrypted_on_disk(client, guest):
    headers, _ = guest
    payload = b"hello unishare " * 100
    r = client.post("/api/upload", headers=headers, files={"file": ("hello.txt", payload, "text/plain")}, data={"is_public": "true"})
    assert r.status_code == 200, r.text
    meta = r.json()
    assert meta["size"] == len(payload)

    stored = (server.UPLOAD_DIR / meta["filename"]).read_bytes()
    assert payload not in stored

    dl = client.get(meta["download_url"])
    assert dl.status_code == 200 and dl.content == payload


def test_private_file_access_control(client, guest):
    owner_headers, _ = guest
    r = client.post("/api/upload", headers=owner_headers, files={"file": ("secret.txt", b"private", "text/plain")}, data={"is_public": "false"})
    url = r.json()["download_url"]
    assert client.get(url).status_code == 403
    other = client.post("/api/auth/guest", json={"username": f"g{os.urandom(3).hex()}", "emoji": "🙂"}).json()
    other_headers = {"Authorization": f"Bearer {other['access_token']}"}
    assert client.get(url, headers=other_headers).status_code == 403
    assert client.get(url, headers=owner_headers).content == b"private"


def test_delete_file_only_by_owner(client, guest):
    headers, _ = guest
    meta = client.post("/api/upload", headers=headers, files={"file": ("x.txt", b"x", "text/plain")}).json()
    other = client.post("/api/auth/guest", json={"username": f"g{os.urandom(3).hex()}", "emoji": "🙂"}).json()
    other_headers = {"Authorization": f"Bearer {other['access_token']}"}
    assert client.delete(f"/api/files/{meta['id']}", headers=other_headers).status_code in (403, 404)
    assert client.delete(f"/api/files/{meta['id']}", headers=headers).status_code == 200
    assert client.get(meta["download_url"]).status_code == 404


def test_download_unknown_file_is_404(client):
    assert client.get("/api/files/does-not-exist/download").status_code == 404


def test_chat_send_validation_and_list(client, guest):
    headers, _ = guest
    assert client.post("/api/chat/messages", headers=headers, json={"content": "   "}).status_code == 400
    assert client.post("/api/chat/messages", headers=headers, json={"content": "x" * 100000}).status_code == 400
    ok = client.post("/api/chat/messages", headers=headers, json={"content": "hi there"})
    assert ok.status_code == 200, ok.text
    assert any(m["content"] == "hi there" for m in client.get("/api/chat/messages", headers=headers).json())
    assert client.post("/api/chat/messages", json={"content": "anon"}).status_code in (401, 403)


def test_admin_endpoints_forbidden_to_guests(client, guest):
    headers, _ = guest
    assert client.get("/api/admin/users", headers=headers).status_code == 403


def test_admin_can_list_users(client):
    login = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "admin-test-password"})
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert client.get("/api/admin/users", headers=headers).status_code == 200
