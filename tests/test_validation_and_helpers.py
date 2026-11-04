import io
import os
import zipfile

import pytest
from fastapi import HTTPException

import server


def rand(prefix="u"):
    return f"{prefix}{os.urandom(4).hex()}"


def auth(body):
    return {"Authorization": f"Bearer {body['access_token']}"}


def register(client, password="correct-horse-1"):
    email = f"{rand()}@example.com"
    r = client.post("/api/auth/register", json={"username": rand(), "email": email, "password": password})
    assert r.status_code == 200, r.text
    return email, auth(r.json()), r.json()["user"]


# ---------------------------------------------------------------- pure helpers

@pytest.mark.parametrize(
    "raw,expected",
    [
        ("report.pdf", "report.pdf"),
        ("../../etc/passwd", "passwd"),
        ("C:\\Users\\me\\notes.txt", "notes.txt"),
        ("bad\x00name\n.txt", "badname.txt"),
        ("", "file"),
        (None, "file"),
    ],
)
def test_safe_filename(raw, expected):
    assert server.safe_filename(raw) == expected


def test_safe_filename_is_length_limited():
    assert len(server.safe_filename("a" * 1000 + ".txt")) <= 255


@pytest.mark.parametrize(
    "name,expected",
    [("a.txt", ".txt"), ("archive.tar.gz", ".gz"), ("noext", ""), ("x.<script>", ""), ("x." + "a" * 30, "")],
)
def test_safe_extension(name, expected):
    assert server.safe_extension(name) == expected


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("photos/2024/a.jpg", "photos/2024/a.jpg"),
        ("../../secret", "secret"),
        ("/abs/path/file", "abs/path/file"),
        ("a\\b\\..\\c", "a/b/c"),
        ("", None),
        (None, None),
        ("../..", None),
    ],
)
def test_safe_relpath(raw, expected):
    assert server.safe_relpath(raw) == expected


def test_content_disposition_handles_non_ascii_and_quotes():
    header = server.content_disposition("attachment", 'résumé "final".pdf')
    header.encode("latin-1")  # must be representable in an HTTP header
    assert '"' not in header.split("filename=")[1].split(";")[0].strip('"')
    assert "filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf" in header


def test_user_can_access_rules():
    owner = server.User(id="o", username="owner", email="o@example.com", is_guest=False)
    friend = server.User(id="f", username="friend", email="f@example.com", is_guest=False)
    stranger = server.User(id="s", username="stranger", email="s@example.com", is_guest=False)
    private = {"is_public": False, "owner_id": "o", "shared_with_users": ["f@example.com"]}
    assert server.user_can_access({"is_public": True}, None)
    assert not server.user_can_access(private, None)
    assert server.user_can_access(private, owner)
    assert server.user_can_access(private, friend)
    assert not server.user_can_access(private, stranger)


def test_read_upload_capped_rejects_oversize():
    import asyncio

    from starlette.datastructures import UploadFile

    async def run(size, limit):
        return await server.read_upload_capped(UploadFile(io.BytesIO(b"x" * size)), limit)

    assert len(asyncio.run(run(10, 10))) == 10
    with pytest.raises(HTTPException) as exc:
        asyncio.run(run(11, 10))
    assert exc.value.status_code == 413


# ------------------------------------------------------------ input validation

def test_guest_username_and_emoji_validation(client):
    assert client.post("/api/auth/guest", json={"username": "a", "emoji": "🙂"}).status_code == 422
    assert client.post("/api/auth/guest", json={"username": "x" * 33, "emoji": "🙂"}).status_code == 422
    assert client.post("/api/auth/guest", json={"username": "   ", "emoji": "🙂"}).status_code == 422
    assert client.post("/api/auth/guest", json={"username": rand("g"), "emoji": ""}).status_code == 422
    assert client.post("/api/auth/guest", json={"username": rand("g"), "emoji": "x" * 20}).status_code == 422


def test_register_validation(client):
    base = {"username": rand(), "email": f"{rand()}@example.com"}
    assert client.post("/api/auth/register", json={**base, "password": "short"}).status_code == 422
    assert client.post("/api/auth/register", json={**base, "password": "x" * 200}).status_code == 422
    assert client.post("/api/auth/register", json=base).status_code == 422  # no password at all
    assert client.post("/api/auth/register", json={**base, "email": "not-an-email", "password": "long-enough-1"}).status_code == 422
    assert client.post("/api/auth/register", json={**base, "username": "a", "password": "long-enough-1"}).status_code == 422


def test_username_is_unique_case_insensitively(client):
    name = rand("Case")
    assert client.post("/api/auth/guest", json={"username": name, "emoji": "🙂"}).status_code == 200
    assert client.post("/api/auth/guest", json={"username": name.upper(), "emoji": "🙂"}).status_code == 409


def test_rename_and_avatar_rules(client, guest):
    guest_headers, _ = guest
    assert client.patch("/api/auth/me/username", headers=guest_headers, json={"username": rand()}).status_code == 403
    assert client.patch("/api/auth/me/avatar", headers=guest_headers, json={"avatar_url": None}).status_code == 403

    _, headers, _ = register(client)
    assert client.patch("/api/auth/me/username", headers=headers, json={"username": "x"}).status_code == 400
    new = rand("renamed")
    assert client.patch("/api/auth/me/username", headers=headers, json={"username": new}).json()["username"] == new
    assert client.get("/api/auth/me", headers=headers).json()["username"] == new
    assert client.patch("/api/auth/me/avatar", headers=headers, json={"avatar_url": "https://evil.example/x.png"}).status_code == 400
    ok = client.patch("/api/auth/me/avatar", headers=headers, json={"avatar_url": "https://api.dicebear.com/7.x/x/svg"})
    assert ok.status_code == 200


# --------------------------------------------------------------------- uploads

def upload(client, headers, name="a.txt", data=b"data", **form):
    return client.post("/api/upload", headers=headers, files={"file": (name, data, "text/plain")}, data=form)


def test_upload_over_limit_is_rejected_without_storing(client, guest, monkeypatch):
    headers, _ = guest
    monkeypatch.setattr(server, "CLOUD_UPLOAD_MAX", 1024)
    before = len(list(server.UPLOAD_DIR.iterdir()))
    r = upload(client, headers, data=b"x" * 2048)
    assert r.status_code == 413
    assert len(list(server.UPLOAD_DIR.iterdir())) == before


def test_guest_data_limit_is_enforced(client, guest, monkeypatch):
    headers, _ = guest
    monkeypatch.setattr(server, "GUEST_DATA_LIMIT", 100)
    assert upload(client, headers, data=b"x" * 60).status_code == 200
    r = upload(client, headers, data=b"x" * 60)
    assert r.status_code == 403 and "limit" in r.json()["detail"].lower()


def test_upload_sanitises_names_extension_and_folder(client, guest):
    headers, _ = guest
    r = upload(client, headers, name="../../evil.<b>", folder_path="../../top/./sub")
    assert r.status_code == 200, r.text
    meta = r.json()
    assert "/" not in meta["original_filename"] and ".." not in meta["original_filename"]
    assert meta["filename"].count(".") == 0  # unsafe extension dropped
    assert meta["folder_path"] == "top/sub"
    assert (server.UPLOAD_DIR / meta["filename"]).exists()


def test_upload_requires_auth(client):
    assert client.post("/api/upload", files={"file": ("a.txt", b"x")}).status_code in (401, 403)


def test_non_ascii_filename_downloads_with_valid_header(client, guest):
    headers, _ = guest
    meta = upload(client, headers, name="résumé.txt", data=b"cv").json()
    dl = client.get(meta["download_url"])
    assert dl.status_code == 200 and dl.content == b"cv"
    assert "attachment" in dl.headers["content-disposition"]
    assert dl.headers["x-content-type-options"] == "nosniff"


def test_html_preview_is_sandboxed(client, guest):
    headers, _ = guest
    r = client.post(
        "/api/upload", headers=headers,
        files={"file": ("page.html", b"<script>alert(1)</script>", "text/html")},
    )
    pv = client.get(f"/api/files/{r.json()['id']}/preview")
    assert pv.status_code == 200
    assert "sandbox" in pv.headers["content-security-policy"]
    assert pv.headers["x-content-type-options"] == "nosniff"
    assert pv.headers["content-disposition"].startswith("inline")


def test_private_preview_needs_access_and_accepts_token_query(client, guest):
    headers, _ = guest
    meta = upload(client, headers, data=b"secret", is_public="false").json()
    url = f"/api/files/{meta['id']}/preview"
    assert client.get(url).status_code == 403
    token = headers["Authorization"].split()[1]
    assert client.get(url, params={"token": token}).content == b"secret"


def test_file_shared_with_email_is_readable_by_that_user_only(client, guest):
    headers, _ = guest
    email, friend_headers, _ = register(client)
    _, stranger_headers, _ = register(client)
    meta = upload(client, headers, data=b"for you", is_public="false", shared_with=f" {email} ").json()
    assert client.get(meta["download_url"], headers=friend_headers).content == b"for you"
    assert client.get(meta["download_url"], headers=stranger_headers).status_code == 403
    listed = {f["id"] for f in client.get("/api/files", headers=friend_headers).json()}
    assert meta["id"] in listed


def test_file_list_requires_login_and_hides_private_files(client, guest):
    headers, _ = guest
    meta = upload(client, headers, is_public="false").json()
    assert client.get("/api/files").json() == []
    _, other_headers, _ = register(client)
    assert meta["id"] not in {f["id"] for f in client.get("/api/files", headers=other_headers).json()}
    assert meta["id"] in {f["id"] for f in client.get("/api/files", headers=headers).json()}


def test_delete_updates_usage_and_removes_disk_file(client, guest):
    headers, _ = guest
    meta = upload(client, headers, data=b"x" * 500).json()
    assert client.get("/api/auth/me", headers=headers).json()["total_data_shared"] == 500
    assert client.delete(f"/api/files/{meta['id']}", headers=headers).status_code == 200
    assert not (server.UPLOAD_DIR / meta["filename"]).exists()
    assert client.get("/api/auth/me", headers=headers).json()["total_data_shared"] == 0


def test_file_reaction_toggles(client, guest):
    headers, _ = guest
    meta = upload(client, headers).json()
    url = f"/api/files/{meta['id']}/react"
    assert client.post(url, headers=headers).json() == {"reaction_count": 1, "reacted": True}
    assert client.post(url, headers=headers).json() == {"reaction_count": 0, "reacted": False}
    assert client.post("/api/files/nope/react", headers=headers).status_code == 404


def test_history_records_upload_and_download(client, guest):
    headers, _ = guest
    meta = upload(client, headers, name="tracked.txt").json()
    client.get(meta["download_url"], headers=headers)
    actions = [(h["action"], h["file_name"]) for h in client.get("/api/history", headers=headers).json()]
    assert ("upload", "tracked.txt") in actions and ("download", "tracked.txt") in actions


# ---------------------------------------------------------------------- folders

def test_folder_download_zips_decrypted_files_with_token_query(client, guest):
    headers, _ = guest
    folder = rand("album")
    upload(client, headers, name="a.txt", data=b"AAA", folder_path=f"{folder}/a.txt")
    upload(client, headers, name="b.txt", data=b"BBB", folder_path=f"{folder}/inner/b.txt")
    token = headers["Authorization"].split()[1]
    r = client.get("/api/files/download-folder", params={"folder_path": folder, "token": token})
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        assert sorted(zf.namelist()) == [f"{folder}/a.txt", f"{folder}/inner/b.txt"]
        assert zf.read(f"{folder}/a.txt") == b"AAA"
    # no stray archives are left in the uploads directory
    assert not list(server.UPLOAD_DIR.glob("*.zip"))


def test_folder_download_rules(client, guest):
    headers, _ = guest
    assert client.get("/api/files/download-folder", params={"folder_path": "x"}).status_code == 401
    assert client.get("/api/files/download-folder", headers=headers, params={"folder_path": "nothing-here"}).status_code == 404
    assert client.get("/api/files/download-folder", headers=headers, params={"folder_path": "../.."}).status_code == 400
    # another user's folder is invisible
    folder = rand("mine")
    upload(client, headers, folder_path=f"{folder}/a.txt")
    _, other, _ = register(client)
    assert client.get("/api/files/download-folder", headers=other, params={"folder_path": folder}).status_code == 404


# ------------------------------------------------------------------------- chat

def test_chat_edit_delete_react_and_pin(client, guest):
    headers, _ = guest
    _, other_headers, _ = register(client)
    msg = client.post("/api/chat/messages", headers=headers, json={"content": "first"}).json()
    mid = msg["id"]

    assert client.patch(f"/api/chat/messages/{mid}", headers=headers, json={"content": "edited"}).status_code == 200
    assert client.patch(f"/api/chat/messages/{mid}", headers=other_headers, json={"content": "hax"}).status_code == 403
    assert client.patch(f"/api/chat/messages/{mid}", headers=headers, json={"content": "  "}).status_code == 400

    assert client.post(f"/api/chat/messages/{mid}/react", headers=other_headers, params={"emoji": "👍"}).status_code == 200
    assert client.post(f"/api/chat/messages/{mid}/react", headers=other_headers, params={"emoji": "x" * 20}).status_code == 400
    listed = {m["id"]: m for m in client.get("/api/chat/messages", headers=headers).json()}
    assert listed[mid]["content"] == "edited" and "👍" in listed[mid]["reactions"]

    assert client.post(f"/api/chat/messages/{mid}/pin", headers=headers).status_code == 403

    assert client.delete(f"/api/chat/messages/{mid}", headers=other_headers).status_code == 403
    assert client.delete(f"/api/chat/messages/{mid}", headers=headers).status_code == 200
    gone = {m["id"]: m for m in client.get("/api/chat/messages", headers=headers).json()}[mid]
    assert gone["deleted"] is True and gone["content"] != "edited"


def admin_headers(client):
    login = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "admin-test-password"})
    return auth(login.json())


def test_admin_can_pin_messages(client, guest):
    headers, _ = guest
    mid = client.post("/api/chat/messages", headers=headers, json={"content": "pin me"}).json()["id"]
    assert client.post(f"/api/chat/messages/{mid}/pin", headers=admin_headers(client)).json() == {"pinned": True}


# ------------------------------------------------------------------------ admin

def test_admin_block_and_unblock_user(client):
    admin = admin_headers(client)
    email, headers, user = register(client)
    assert upload(client, headers).status_code == 200

    assert client.post(f"/api/admin/users/{user['id']}/block", headers=admin).status_code == 200
    assert upload(client, headers).status_code == 403
    login = client.post("/api/auth/login", json={"email": email, "password": "correct-horse-1"})
    assert login.status_code in (401, 403)

    assert client.post(f"/api/admin/users/{user['id']}/unblock", headers=admin).status_code == 200
    assert upload(client, headers).status_code == 200


def test_admin_cannot_block_self_or_unknown_user(client):
    admin = admin_headers(client)
    me = client.get("/api/auth/me", headers=admin).json()
    assert client.post(f"/api/admin/users/{me['id']}/block", headers=admin).status_code == 400
    assert client.post("/api/admin/users/missing/block", headers=admin).status_code == 404


def test_admin_can_delete_any_file(client, guest):
    headers, _ = guest
    meta = upload(client, headers).json()
    assert client.delete(f"/api/admin/files/{meta['id']}", headers=admin_headers(client)).status_code == 200
    assert client.get(meta["download_url"]).status_code == 404


# -------------------------------------------------------------------- websocket

def test_admin_bulk_delete_uses_static_route(client, guest):
    headers, _ = guest
    first = upload(client, headers).json()
    second = upload(client, headers).json()
    response = client.delete('/api/admin/files/bulk-delete', headers=admin_headers(client),
                             params=[('file_ids', first['id']), ('file_ids', second['id'])])
    assert response.status_code == 200, response.text
    assert response.json()['deleted_count'] == 2
    assert client.get(first['download_url']).status_code == 404


def test_websocket_rejects_missing_or_foreign_token(client, guest):
    from starlette.websockets import WebSocketDisconnect

    headers, user = guest
    token = headers["Authorization"].split()[1]
    for url in (f"/api/ws/{user['id']}", f"/api/ws/{user['id']}?token=garbage", f"/api/ws/someone-else?token={token}"):
        with client.websocket_connect(url) as ws, pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 4401


def test_websocket_relays_signaling_and_stamps_sender(client):
    a = client.post("/api/auth/guest", json={"username": rand("a"), "emoji": "🙂"}).json()
    b = client.post("/api/auth/guest", json={"username": rand("b"), "emoji": "🙂"}).json()
    ua, ub = a["user"]["id"], b["user"]["id"]
    with client.websocket_connect(f"/api/ws/{ua}?token={a['access_token']}") as wa, \
            client.websocket_connect(f"/api/ws/{ub}?token={b['access_token']}") as wb:

        def next_of(ws, kind):
            for _ in range(10):
                msg = ws.receive_json()
                if msg.get("type") == kind:
                    return msg
            raise AssertionError(f"no {kind} message received")

        next_of(wb, "online_users")
        # 'sender' supplied by the client must be ignored
        wa.send_json({"type": "offer", "target": ub, "offer": {"sdp": "x"}, "sender": "spoofed"})
        got = next_of(wb, "offer")
        assert got["offer"] == {"sdp": "x"} and got["sender"] == ua
        wb.send_json({"type": "answer", "target": ua, "answer": {"sdp": "y"}})
        assert next_of(wa, "answer")["sender"] == ub
        wa.send_json({"type": "ice-candidate", "target": ub, "candidate": {"c": 1}})
        assert next_of(wb, "ice-candidate")["candidate"] == {"c": 1}
        # malformed frames are ignored rather than killing the socket
        wa.send_json([1, 2, 3])
        wa.send_json({"type": "offer", "target": 5})
        wa.send_json({"type": "offer", "target": ub, "offer": {"sdp": "z"}})
        assert next_of(wb, "offer")["offer"] == {"sdp": "z"}
