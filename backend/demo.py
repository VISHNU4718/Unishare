"""Disposable local demo: real API, encryption and WebSockets, in-memory metadata."""
import os
import secrets
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ['MONGO_URL'] = 'mongomock://demo'
os.environ['DB_NAME'] = 'unishare_demo'
os.environ['SECRET_KEY'] = secrets.token_hex(32)
os.environ['ADMIN_PASSWORD'] = secrets.token_urlsafe(32)
_data = tempfile.TemporaryDirectory(prefix='unishare-demo-')
os.environ['UNISHARE_DATA_DIR'] = _data.name
os.environ['FRONTEND_URL'] = 'http://127.0.0.1:8001'
os.environ['BACKEND_URL'] = 'http://127.0.0.1:8001'

from fastapi.staticfiles import StaticFiles  # noqa: E402
from starlette.exceptions import HTTPException  # noqa: E402
from server import app  # noqa: E402


class DemoFiles(StaticFiles):
    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code != 404 or path.startswith(('api/', 'static/')):
                raise
            return await super().get_response('index.html', scope)


build_dir = ROOT / 'frontend' / 'build'
if not (build_dir / 'index.html').exists():
    raise RuntimeError('Build the frontend first: cd frontend && npm run build')
app.router.routes[:] = [route for route in app.router.routes if getattr(route, 'path', None) != '/']
app.mount('/', DemoFiles(directory=build_dir, html=True), name='demo')

if __name__ == '__main__':
    import uvicorn
    print('Disposable demo at http://127.0.0.1:8001 — files and accounts reset on restart.')
    uvicorn.run(app, host='127.0.0.1', port=8001)
