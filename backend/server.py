from contextlib import asynccontextmanager
from fastapi import FastAPI, APIRouter, UploadFile, File, HTTPException, WebSocket, WebSocketDisconnect, Depends, Header, Query, Request, Form
from fastapi.responses import FileResponse as FastAPIFileResponse, RedirectResponse, Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import OperationFailure
from pydantic import BaseModel, Field, ConfigDict, EmailStr
from typing import List, Optional, Dict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from jose import JWTError, jwt
from googleapiclient.discovery import build
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleRequest
import os
import secrets
import logging
import uuid
import zipfile
import time
import re
import bcrypt
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.backends import default_backend
import base64

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load environment variables
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
if mongo_url.startswith("mongomock://"):
    # In-memory database for tests and local trials without MongoDB. Data is lost on restart.
    from mongomock_motor import AsyncMongoMockClient

    client = AsyncMongoMockClient()
else:
    client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Create uploads directory
# Uploads and encryption keys live under UNISHARE_DATA_DIR (default: next to server.py).
DATA_DIR = Path(os.getenv("UNISHARE_DATA_DIR") or ROOT_DIR)
DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

SECRET_KEY = os.getenv("SECRET_KEY")
ALGORITHM = "HS256"

# Enforce a real SECRET_KEY in production, but auto-generate one for dev
if not SECRET_KEY:
    if os.getenv("ENV", "development").lower() == "production":
        logger.error("FATAL: SECRET_KEY environment variable is required in production.")
        raise RuntimeError("SECRET_KEY is not set. Generate one with: openssl rand -hex 32")
    SECRET_KEY = secrets.token_hex(32)
    logger.warning("WARNING: Using auto-generated SECRET_KEY for development only.")
    logger.warning("Set SECRET_KEY in your .env file before deploying to production.")
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days

# Encryption Keys Setup
KEYS_DIR = DATA_DIR / "keys"
KEYS_DIR.mkdir(exist_ok=True)
PRIVATE_KEY_PATH = KEYS_DIR / "private_key.pem"
PUBLIC_KEY_PATH = KEYS_DIR / "public_key.pem"

def generate_keys():
    if not PRIVATE_KEY_PATH.exists() or not PUBLIC_KEY_PATH.exists():
        logger.info("Generating new RSA keys...")
        private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=2048,
            backend=default_backend()
        )
        public_key = private_key.public_key()

        with open(PRIVATE_KEY_PATH, "wb") as f:
            f.write(private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption()
            ))

        with open(PUBLIC_KEY_PATH, "wb") as f:
            f.write(public_key.public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo
            ))
        logger.info("RSA keys generated successfully")

generate_keys()

def load_private_key():
    with open(PRIVATE_KEY_PATH, "rb") as f:
        return serialization.load_pem_private_key(
            f.read(),
            password=None,
            backend=default_backend()
        )

def load_public_key():
    with open(PUBLIC_KEY_PATH, "rb") as f:
        return serialization.load_pem_public_key(
            f.read(),
            backend=default_backend()
        )

server_private_key = load_private_key()
server_public_key = load_public_key()

def encrypt_file_content(content: bytes) -> tuple[bytes, bytes]:
    """Encrypt content with a random AES key, then encrypt the AES key with RSA"""
    key = Fernet.generate_key()
    f = Fernet(key)
    encrypted_content = f.encrypt(content)
    
    encrypted_key = server_public_key.encrypt(
        key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None
        )
    )
    return encrypted_content, base64.b64encode(encrypted_key)

def decrypt_file_content(encrypted_content: bytes, encrypted_key_b64: bytes) -> bytes:
    """Decrypt the AES key with RSA, then decrypt content with AES"""
    encrypted_key = base64.b64decode(encrypted_key_b64)
    
    key = server_private_key.decrypt(
        encrypted_key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None
        )
    )
    
    f = Fernet(key)
    return f.decrypt(encrypted_content)

# Guest data limit (2GB in bytes)
GUEST_DATA_LIMIT = 2 * 1024 * 1024 * 1024  # 2GB

# ============================================================================
# Database Indexes and Startup Configuration
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifecycle manager for the FastAPI app"""
    # Startup
    try:
        # User collection indexes
        await db.users.create_index("id", unique=True)
        await db.users.create_index("email", unique=True, sparse=True)
        await db.users.create_index("username")
        await db.users.create_index([("is_guest", 1), ("created_date", -1)])
        
        # Files collection indexes
        await db.files.create_index("id", unique=True)
        await db.files.create_index([("owner_id", 1), ("upload_date", -1)])
        await db.files.create_index([("is_public", 1), ("upload_date", -1)])
        await db.files.create_index("drive_file_id", sparse=True)
        
        # History collection indexes
        await db.history.create_index([("user_id", 1), ("timestamp", -1)])

        # Chat collection indexes
        await db.chat_messages.create_index([("created_at", -1)])
        await db.chat_messages.create_index("id", unique=True)

        logger.info("✅ Database indexes created successfully")
        logger.info(f"✅ Configured BACKEND_URL: {os.getenv('BACKEND_URL')}")

        # Seed admin user if none exists
        await ensure_admin_user()

        logger.info("✅ UniShare API started - Windows Compatible Mode")
    except Exception as e:
        logger.warning(f"⚠️ Index creation warning: {e}")

    # Background: message TTL sweep (2 hours for ALL messages)
    ttl_task = asyncio.create_task(_all_msg_ttl_loop())
    unmute_task = asyncio.create_task(_auto_unmute_loop())

    yield

    # Shutdown
    try:
        ttl_task.cancel()
        unmute_task.cancel()
        for t in list(guest_msg_cleanup_tasks.values()):
            t.cancel()
        client.close()
        logger.info("✅ Database connection closed")
    except Exception as e:
        logger.error(f"Error during shutdown: {e}")

# Create the main app
app = FastAPI(
    title="UniShare API",
    description="Secure file sharing with P2P, WebRTC, and cloud integration",
    version="2.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    lifespan=lifespan
)

# Server start time for uptime tracking
SERVER_START_TIME = time.time()

# Rate limiting setup
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")

# Security
security = HTTPBearer()


# ============================================================================
# Chat message TTL infrastructure
# ============================================================================
import asyncio

# Pending guest cleanup tasks keyed by user_id. Cancelled on reconnect within window.
guest_msg_cleanup_tasks: Dict[str, "asyncio.Task"] = {}
GUEST_MSG_GRACE_SECONDS = 5 * 60          # 5 minutes after WS disconnect
ALL_MSG_TTL_SECONDS = 60 * 60          # 1 hour for ALL messages
TTL_CLEANUP_INTERVAL = 60 * 5             # sweep TTL every 5 minutes


async def _delete_user_messages(user_id: str, reason: str) -> int:
    """Soft-delete every non-deleted message authored by user_id."""
    result = await db.chat_messages.update_many(
        {"user_id": user_id, "deleted": {"$ne": True}},
        {"$set": {"deleted": True, "deleted_by": "ttl"}},
    )
    if result.modified_count > 0:
        logger.info(f"TTL ({reason}) cleared {result.modified_count} messages for user {user_id}")
        await manager.broadcast_all({
            "type": "chat_clear",
            "scope": "user",
            "user_id": user_id,
            "deleted_by": "ttl",
        })
    return result.modified_count


async def _guest_cleanup_after_grace(user_id: str):
    try:
        await asyncio.sleep(GUEST_MSG_GRACE_SECONDS)
        await _delete_user_messages(user_id, "guest-disconnect")
    except asyncio.CancelledError:
        # User reconnected within grace window — keep messages.
        raise
    finally:
        guest_msg_cleanup_tasks.pop(user_id, None)


def schedule_guest_msg_cleanup(user_id: str):
    """Start a 5-min countdown to wipe a disconnected guest's chat messages."""
    existing = guest_msg_cleanup_tasks.get(user_id)
    if existing and not existing.done():
        return
    guest_msg_cleanup_tasks[user_id] = asyncio.create_task(_guest_cleanup_after_grace(user_id))


def cancel_guest_msg_cleanup(user_id: str):
    """Cancel a pending guest message cleanup (user reconnected)."""
    task = guest_msg_cleanup_tasks.pop(user_id, None)
    if task and not task.done():
        task.cancel()


async def _all_msg_ttl_loop():
    """Background sweep: hard-delete ALL chat messages older than 1 hour."""
    while True:
        try:
            await asyncio.sleep(TTL_CLEANUP_INTERVAL)
            cutoff = (datetime.now(timezone.utc) - timedelta(seconds=ALL_MSG_TTL_SECONDS)).isoformat()
            result = await db.chat_messages.delete_many({"created_at": {"$lt": cutoff}})
            if result.deleted_count > 0:
                logger.info(f"TTL sweep cleared {result.deleted_count} messages older than 1 hour")
                await manager.broadcast_all({"type": "chat_clear", "scope": "ttl-sweep", "deleted_by": "ttl"})
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"TTL loop error: {e}")


UNMUTE_CHECK_INTERVAL = 30

async def _auto_unmute_loop():
    """Background loop: auto-unmute users when their mute period expires."""
    while True:
        try:
            await asyncio.sleep(UNMUTE_CHECK_INTERVAL)
            now = datetime.now(timezone.utc)
            now_iso = now.isoformat()
            result = await db.users.update_many(
                {"muted_until": {"$ne": None, "$lte": now_iso}},
                {"$set": {"muted_until": None}}
            )
            if result.modified_count > 0:
                logger.info(f"Auto-unmuted {result.modified_count} user(s)")
                await manager.broadcast_all({
                    "type": "auto_unmuted",
                    "user_count": result.modified_count
                })
                await manager.broadcast_online_users()
        except asyncio.CancelledError:
            break
        except OperationFailure as e:
            msg = str(e).lower()
            code = getattr(e, "code", None)
            if code == 59 or "command update not found" in msg:
                logger.error(
                    "Auto-unmute disabled: Mongo target does not support update commands. "
                    "Use a writable Atlas cluster URI (mongodb+srv://...) instead of a read-only/federated endpoint."
                )
                break
            logger.error(f"Auto-unmute loop error: {e}")
        except Exception as e:
            logger.error(f"Auto-unmute loop error: {e}")



# ============================================================================
# WebSocket Connection Manager for WebRTC Signaling
# ============================================================================
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.user_info: Dict[str, dict] = {}
    
    async def connect(self, user_id: str, websocket: WebSocket, username: str = None, emoji: str = None):
        await websocket.accept()
        self.active_connections[user_id] = websocket
        self.user_info[user_id] = {
            "username": username or "Anonymous",
            "emoji": emoji or "👤",
            "connected_at": datetime.now(timezone.utc).isoformat()
        }
        logger.info(f"User {user_id} ({username}) connected")
        # Notify all users about new connection
        await self.broadcast_online_users()
    
    def disconnect(self, user_id: str):
        if user_id in self.active_connections:
            del self.active_connections[user_id]
        if user_id in self.user_info:
            del self.user_info[user_id]
        logger.info(f"User {user_id} disconnected")
    
    async def send_message(self, user_id: str, message: dict):
        if user_id in self.active_connections:
            try:
                await self.active_connections[user_id].send_json(message)
            except Exception as e:
                msg = str(e).lower()
                # Common transient WS shutdown races are expected during reconnects.
                if "not connected" in msg or "accept" in msg or "closed" in msg:
                    logger.info(f"WS send skipped for {user_id}: {e}")
                else:
                    logger.error(f"Error sending message to {user_id}: {e}")
                self.disconnect(user_id)
    
    async def broadcast_online_users(self):
        """Notify all connected users about who's online"""
        online_users = []
        for uid, info in self.user_info.items():
            user_doc = await db.users.find_one({"id": uid}, {"_id": 0, "is_admin": 1})
            is_admin = user_doc.get("is_admin", False) if user_doc else False
            online_users.append({
                "id": uid,
                **info,
                "is_admin": is_admin
            })
        message = {"type": "online_users", "users": online_users}
        for user_id in list(self.active_connections.keys()):
            await self.send_message(user_id, message)

    async def broadcast_all(self, message: dict):
        """Send a message to every connected client (chat fan-out)."""
        for user_id in list(self.active_connections.keys()):
            await self.send_message(user_id, message)

    def get_online_users(self):
        return [{"id": uid, **info} for uid, info in self.user_info.items()]

manager = ConnectionManager()

# ============================================================================
# Pydantic Models
# ============================================================================

class UserBase(BaseModel):
    username: str
    email: Optional[EmailStr] = None

class UserCreate(UserBase):
    password: Optional[str] = None  # Optional for guests

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class GuestCreate(BaseModel):
    username: str
    emoji: str = "👤"

class User(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    username: str
    email: Optional[str] = None
    password_hash: Optional[str] = None
    is_guest: bool = True
    is_admin: bool = False
    is_blocked: bool = False
    muted_until: Optional[datetime] = None
    last_seen: Optional[datetime] = None
    emoji: str = "👤"
    avatar_url: Optional[str] = None  # DiceBear-style URL for registered users
    total_data_shared: int = 0  # in bytes
    google_drive_connected: bool = False
    google_id: Optional[str] = None  # Google OAuth ID
    created_date: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    drive_access_token: Optional[str] = None
    drive_refresh_token: Optional[str] = None
    google_access_token: Optional[str] = None

class UserResponse(BaseModel):
    id: str
    username: str
    email: Optional[str] = None
    is_guest: bool
    is_admin: bool = False
    is_blocked: bool = False
    emoji: str
    avatar_url: Optional[str] = None
    total_data_shared: int
    google_drive_connected: bool
    created_date: str
    muted_until: Optional[str] = None

class Token(BaseModel):
    access_token: str
    token_type: str
    user: UserResponse

class FileMetadata(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    filename: str
    original_filename: str
    size: int
    content_type: Optional[str] = None
    upload_date: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    owner_id: str
    owner_username: str
    owner_type: str = "guest"  # "guest" or "user"
    session_id: Optional[str] = None  # For guest tracking
    is_public: bool = True
    shared_with_users: List[str] = Field(default_factory=list)
    source: str = "upload"  # "upload" or "google_drive"
    drive_file_id: Optional[str] = None
    encrypted_key: Optional[str] = None
    reactions: List[str] = Field(default_factory=list)
    folder_path: Optional[str] = None  # Relative path within uploaded folder (e.g., "folder/subfolder")

class FileResponse(BaseModel):
    id: str
    filename: str
    original_filename: str
    size: int
    content_type: Optional[str]
    upload_date: str
    download_url: str
    share_url: str
    owner_id: str
    owner_username: str
    owner_type: str
    is_public: bool
    source: str
    drive_file_id: Optional[str] = None
    shared_with_users: List[str] = []
    reaction_count: int = 0
    reacted: bool = False
    folder_path: Optional[str] = None

class HistoryResponse(BaseModel):
    id: str
    action: str
    file_name: str
    timestamp: str
    details: Optional[str]


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    username: str
    emoji: str = "👤"
    avatar_url: Optional[str] = None
    is_admin: bool = False
    content: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    edited_at: Optional[datetime] = None
    deleted: bool = False
    deleted_by: Optional[str] = None
    pinned: bool = False
    reply_to: Optional[str] = None
    reactions: Dict[str, List[str]] = Field(default_factory=dict)


class ChatMessageCreate(BaseModel):
    content: str
    reply_to: Optional[str] = None


class ChatMessageEdit(BaseModel):
    content: str


class DriveFileInfo(BaseModel):
    id: str
    name: str
    mimeType: str
    size: Optional[int] = 0
    webViewLink: Optional[str] = None
    iconLink: Optional[str] = None

# ============================================================================
# Helper Functions
# ============================================================================

ADMIN_CREDS_PATH = DATA_DIR / "ADMIN_CREDENTIALS.txt"

def _truncate_to_72_bytes(password: str) -> bytes:
    """Truncate password to 72 bytes (bcrypt limit), not 72 characters."""
    encoded = password.encode('utf-8')
    if len(encoded) <= 72:
        return encoded
    return encoded[:72]


def hash_password(password: str) -> str:
    truncated = _truncate_to_72_bytes(password)
    return bcrypt.hashpw(truncated, bcrypt.gensalt()).decode('utf-8')


def verify_password(plain_password: str, hashed_password: str) -> bool:
    truncated = _truncate_to_72_bytes(plain_password)
    try:
        return bcrypt.checkpw(truncated, hashed_password.encode('utf-8'))
    except ValueError:
        # Fallback for legacy passlib-generated hashes (bcrypt 4.x compatibility)
        from passlib.context import CryptContext
        legacy_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
        return legacy_ctx.verify(truncated.decode('utf-8', errors='ignore'), hashed_password)


async def ensure_admin_user():
    """Create a default admin account on first boot if none exists.

    Email + password are configurable via env (ADMIN_EMAIL / ADMIN_PASSWORD).
    If ADMIN_PASSWORD is unset, a random password is generated and written to
    backend/ADMIN_CREDENTIALS.txt (and printed once to the log) so the user can
    log in. The file is git-ignored.
    """
    try:
        existing = await db.users.find_one({"is_admin": True})
        if existing:
            return

        email = os.getenv("ADMIN_EMAIL", "admin@unishare.app")
        password = os.getenv("ADMIN_PASSWORD")
        generated = False

        # If a user with ADMIN_EMAIL already exists, promote it to admin
        # instead of trying to insert a duplicate email.
        existing_by_email = await db.users.find_one({"email": email}, {"_id": 0})
        if existing_by_email:
            update_doc = {
                "is_admin": True,
                "is_guest": False,
            }
            # Optional: if ADMIN_PASSWORD is provided, refresh password hash.
            if password:
                update_doc["password_hash"] = hash_password(password)

            await db.users.update_one({"id": existing_by_email["id"]}, {"$set": update_doc})
            logger.info(f"Promoted existing user to admin: {email}")
            return

        if not password:
            password = secrets.token_urlsafe(12)
            generated = True

        admin = User(
            username="admin",
            email=email,
            password_hash=hash_password(password),
            is_guest=False,
            is_admin=True,
            emoji="🛡️",
        )
        doc = admin.model_dump()
        doc["created_date"] = doc["created_date"].isoformat()
        await db.users.insert_one(doc)

        if generated:
            try:
                ADMIN_CREDS_PATH.write_text(
                    f"UniShare admin account\n"
                    f"email:    {email}\n"
                    f"password: {password}\n"
                    f"(generated on first boot — delete this file once you've copied it)\n",
                    encoding="utf-8",
                )
            except Exception as ex:
                logger.warning(f"Could not write admin creds file: {ex}")
            logger.warning("=" * 60)
            logger.warning("ADMIN ACCOUNT CREATED")
            logger.warning(f"  email:    {email}")
            logger.warning(f"  password: {password}")
            logger.warning(f"  creds also saved to: {ADMIN_CREDS_PATH}")
            logger.warning("=" * 60)
        else:
            logger.info(f"Admin account ensured for {email}")
    except Exception as e:
        logger.error(f"ensure_admin_user failed: {e}")

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> User:
    """Get current user from JWT token"""
    try:
        token = credentials.credentials
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="Invalid authentication credentials")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid authentication credentials")
    
    user_doc = await db.users.find_one({"id": user_id}, {"_id": 0})
    if user_doc is None:
        raise HTTPException(status_code=401, detail="User not found")

    # Best-effort update of last_seen so the directory shows "last active"
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        await db.users.update_one({"id": user_id}, {"$set": {"last_seen": now_iso}})
    except Exception:
        pass

    return User(**user_doc)

async def get_admin_user(current_user: User = Depends(get_current_user)) -> User:
    """Dependency that requires the authenticated user to be an admin."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return current_user


async def get_optional_user(
    authorization: str = Header(None),
    token: Optional[str] = None,
) -> Optional[User]:
    """Get current user if token provided (header OR ?token= query), otherwise None.

    The query-param fallback exists so <img>/<iframe>/<video> src= URLs (which
    cannot set custom headers) can still authenticate against private files.
    """
    raw_token: Optional[str] = None
    if authorization:
        raw_token = authorization.replace("Bearer ", "")
    elif token:
        raw_token = token

    if not raw_token:
        return None

    try:
        payload = jwt.decode(raw_token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            return None
    except JWTError:
        return None

    user_doc = await db.users.find_one({"id": user_id}, {"_id": 0})
    if user_doc is None:
        return None

    return User(**user_doc)

async def check_data_limit(user: User, file_size: int) -> bool:
    """Check if user can upload more data (2GB limit for guests)"""
    if not user.is_guest:
        return True  # No limit for logged-in users
    
    if user.total_data_shared + file_size > GUEST_DATA_LIMIT:
        return False
    
    return True

async def update_user_data_shared(user_id: str, file_size: int):
    """Update user's total data shared"""
    await db.users.update_one(
        {"id": user_id},
        {"$inc": {"total_data_shared": file_size}}
    )

async def log_history(user_id: str, action: str, file_name: str, file_id: str = None, details: str = None):
    """Log user activity to history"""
    try:
        history_entry = {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "action": action,
            "file_name": file_name,
            "file_id": file_id,
            "details": details,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
        await db.history.insert_one(history_entry)
    except Exception as e:
        logger.error(f"Failed to log history: {e}")
        # Don't raise exception - history logging shouldn't break the main flow


async def ensure_username_available(username: str, exclude_user_id: Optional[str] = None) -> str:
    """Normalize + enforce unique username across guests and registered users."""
    normalized = (username or "").strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="Username is required")

    query = {
        "username": {
            "$regex": f"^{re.escape(normalized)}$",
            "$options": "i",
        }
    }
    if exclude_user_id:
        query["id"] = {"$ne": exclude_user_id}

    existing = await db.users.find_one(query, {"_id": 0, "id": 1})
    if existing:
        raise HTTPException(status_code=409, detail="Username already taken")

    return normalized

# ============================================================================
# Authentication Routes
# ============================================================================

@api_router.post("/auth/guest", response_model=Token)
@limiter.limit("10/minute")
async def create_guest(request: Request, guest: GuestCreate):
    """Create a guest user with username and emoji - Rate limited to 10 per minute"""
    try:
        username = await ensure_username_available(guest.username)

        # Create guest user
        user = User(
            username=username,
            emoji=guest.emoji,
            is_guest=True
        )
        
        doc = user.model_dump()
        if doc.get('email') is None:
            del doc['email']
        doc['created_date'] = doc['created_date'].isoformat()
        await db.users.insert_one(doc)
        
        # Create access token
        access_token = create_access_token(data={"sub": user.id})
        
        user_response = UserResponse(
            id=user.id,
            username=user.username,
            email=user.email,
            is_guest=user.is_guest,
            is_admin=user.is_admin,
            is_blocked=user.is_blocked,
            emoji=user.emoji,
            total_data_shared=user.total_data_shared,
            google_drive_connected=user.google_drive_connected,
            created_date=doc['created_date']
        )
        
        return Token(access_token=access_token, token_type="bearer", user=user_response)

    except HTTPException:
        raise
    
    except Exception as e:
        logger.error(f"Guest creation failed: {e}")
        raise HTTPException(status_code=500, detail=f"Guest creation failed: {str(e)}")

@api_router.post("/auth/register", response_model=Token)
@limiter.limit("5/minute")
async def register(request: Request, user_create: UserCreate):
    """Register a new user account - Rate limited to 5 per minute"""
    try:
        # Check if email already exists
        existing_user = await db.users.find_one({"email": user_create.email})
        if existing_user:
            raise HTTPException(status_code=400, detail="Email already registered")

        username = await ensure_username_available(user_create.username)
        
        # Create user
        user = User(
            username=username,
            email=user_create.email,
            password_hash=hash_password(user_create.password),
            is_guest=False,
            emoji="👤"
        )
        
        doc = user.model_dump()
        doc['created_date'] = doc['created_date'].isoformat()
        await db.users.insert_one(doc)
        
        # Create access token
        access_token = create_access_token(data={"sub": user.id})
        
        user_response = UserResponse(
            id=user.id,
            username=user.username,
            email=user.email,
            is_guest=user.is_guest,
            is_admin=user.is_admin,
            is_blocked=user.is_blocked,
            emoji=user.emoji,
            total_data_shared=user.total_data_shared,
            google_drive_connected=user.google_drive_connected,
            created_date=doc['created_date']
        )
        
        return Token(access_token=access_token, token_type="bearer", user=user_response)
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Registration failed: {e}")
        raise HTTPException(status_code=500, detail=f"Registration failed: {str(e)}")

@api_router.post("/auth/login", response_model=Token)
@limiter.limit("10/minute")
async def login(request: Request, user_login: UserLogin):
    """Login with email and password - Rate limited to 10 per minute"""
    try:
        # Find user by email
        user_doc = await db.users.find_one({"email": user_login.email}, {"_id": 0})
        if not user_doc:
            raise HTTPException(status_code=401, detail="Invalid email or password")
        
        user = User(**user_doc)

        # Verify password
        if not user.password_hash or not verify_password(user_login.password, user.password_hash):
            raise HTTPException(status_code=401, detail="Invalid email or password")

        if user.is_blocked:
            raise HTTPException(status_code=403, detail="This account has been blocked by an administrator")

        # Create access token
        access_token = create_access_token(data={"sub": user.id})

        user_response = UserResponse(
            id=user.id,
            username=user.username,
            email=user.email,
            is_guest=user.is_guest,
            is_admin=user.is_admin,
            is_blocked=user.is_blocked,
            emoji=user.emoji,
            avatar_url=user.avatar_url,
            total_data_shared=user.total_data_shared,
            google_drive_connected=user.google_drive_connected,
            created_date=user_doc['created_date']
        )

        return Token(access_token=access_token, token_type="bearer", user=user_response)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Login failed: {e}")
        raise HTTPException(status_code=500, detail=f"Login failed: {str(e)}")

async def _wipe_guest_data(user_id: str) -> dict:
    """Delete a guest user's files (disk + DB), history, and the user doc."""
    deleted_disk = 0
    async for f in db.files.find(
        {"owner_id": user_id, "source": "upload"},
        {"_id": 0, "filename": 1},
    ):
        try:
            p = UPLOAD_DIR / f["filename"]
            if p.exists():
                p.unlink()
                deleted_disk += 1
        except Exception as ex:
            logger.warning(f"Failed to remove guest file {f.get('filename')}: {ex}")

    files_res = await db.files.delete_many({"owner_id": user_id})
    history_res = await db.history.delete_many({"user_id": user_id})
    # Soft-delete this guest's chat messages so peers see "Message deleted" rather than orphan text.
    await db.chat_messages.update_many(
        {"user_id": user_id, "deleted": {"$ne": True}},
        {"$set": {"deleted": True, "deleted_by": "ttl"}},
    )
    try:
        await manager.broadcast_all({"type": "chat_clear", "scope": "user", "user_id": user_id, "deleted_by": "ttl"})
    except Exception:
        pass
    user_res = await db.users.delete_one({"id": user_id})
    return {
        "files_deleted": files_res.deleted_count,
        "history_deleted": history_res.deleted_count,
        "user_deleted": user_res.deleted_count,
        "disk_files_removed": deleted_disk,
    }


@api_router.post("/auth/logout")
async def logout(current_user: User = Depends(get_current_user)):
    """Logout via explicit button click. Guest accounts are wiped; registered
    accounts only clear the client-side token."""
    try:
        if not current_user.is_guest:
            return {"success": True, "wiped": False}
        stats = await _wipe_guest_data(current_user.id)
        return {"success": True, "wiped": True, **stats}
    except Exception as e:
        logger.error(f"Logout failed: {e}")
        raise HTTPException(status_code=500, detail=f"Logout failed: {str(e)}")


@api_router.post("/auth/logout-beacon")
async def logout_beacon(token: Optional[str] = None):
    """Beacon-friendly logout (called on tab close via navigator.sendBeacon,
    which cannot set custom headers — token comes from query string).
    Always returns 204 so the browser does not log errors during unload."""
    from fastapi.responses import Response as RawResponse
    try:
        if not token:
            return RawResponse(status_code=204)
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            user_id = payload.get("sub")
        except JWTError:
            return RawResponse(status_code=204)
        if not user_id:
            return RawResponse(status_code=204)
        user_doc = await db.users.find_one({"id": user_id}, {"_id": 0, "is_guest": 1})
        if user_doc and user_doc.get("is_guest"):
            await _wipe_guest_data(user_id)
        return RawResponse(status_code=204)
    except Exception as e:
        logger.warning(f"logout-beacon swallowed error: {e}")
        from fastapi.responses import Response as RawResponse
        return RawResponse(status_code=204)

@api_router.get("/auth/me", response_model=UserResponse)
async def get_me(current_user: User = Depends(get_current_user)):
    """Get current user info"""
    user_doc = await db.users.find_one({"id": current_user.id}, {"_id": 0, "muted_until": 1})
    muted_until = user_doc.get("muted_until") if user_doc else None
    if isinstance(muted_until, datetime):
        muted_until = muted_until.isoformat()
    return UserResponse(
        id=current_user.id,
        username=current_user.username,
        email=current_user.email,
        is_guest=current_user.is_guest,
        is_admin=current_user.is_admin,
        is_blocked=current_user.is_blocked,
        emoji=current_user.emoji,
        avatar_url=current_user.avatar_url,
        total_data_shared=current_user.total_data_shared,
        google_drive_connected=current_user.google_drive_connected,
        created_date=current_user.created_date.isoformat(),
        muted_until=muted_until
    )


@api_router.patch("/auth/me/avatar")
async def update_avatar(payload: dict, current_user: User = Depends(get_current_user)):
    """Set or clear the user's DiceBear avatar URL. Guests are not allowed."""
    if current_user.is_guest:
        raise HTTPException(status_code=403, detail="Guests cannot set an avatar")
    url = payload.get("avatar_url")
    if url is not None:
        if not isinstance(url, str) or len(url) > 512:
            raise HTTPException(status_code=400, detail="Invalid avatar URL")
        if url and not url.startswith("https://api.dicebear.com/"):
            raise HTTPException(status_code=400, detail="Only DiceBear avatar URLs are allowed")
    await db.users.update_one({"id": current_user.id}, {"$set": {"avatar_url": url or None}})
    return {"success": True, "avatar_url": url or None}


@api_router.patch("/auth/me/username")
async def update_my_username(payload: dict, current_user: User = Depends(get_current_user)):
    """Let a registered user rename themselves. Guests cannot rename."""
    if current_user.is_guest:
        raise HTTPException(status_code=403, detail="Guests cannot rename")
    new_name = (payload.get("username") or "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Username is required")
    if len(new_name) < 2 or len(new_name) > 32:
        raise HTTPException(status_code=400, detail="Username must be 2-32 characters")

    new_name = await ensure_username_available(new_name, exclude_user_id=current_user.id)
    await db.users.update_one({"id": current_user.id}, {"$set": {"username": new_name}})
    await db.chat_messages.update_many({"user_id": current_user.id}, {"$set": {"username": new_name}})

    if current_user.id in manager.user_info:
        manager.user_info[current_user.id]["username"] = new_name
        await manager.broadcast_online_users()

    return {"success": True, "username": new_name}

# ============================================================================
# Admin Endpoints
# ============================================================================

def _serialize_user_doc(doc: dict) -> dict:
    out = {
        "id": doc.get("id"),
        "username": doc.get("username"),
        "email": doc.get("email"),
        "is_guest": doc.get("is_guest", True),
        "is_admin": doc.get("is_admin", False),
        "is_blocked": doc.get("is_blocked", False),
        "muted_until": doc.get("muted_until"),
        "emoji": doc.get("emoji", "👤"),
        "total_data_shared": doc.get("total_data_shared", 0),
        "google_drive_connected": doc.get("google_drive_connected", False),
        "created_date": doc.get("created_date"),
    }
    if isinstance(out["created_date"], datetime):
        out["created_date"] = out["created_date"].isoformat()
    if isinstance(out["muted_until"], datetime):
        out["muted_until"] = out["muted_until"].isoformat()
    return out


def _serialize_file_doc(doc: dict) -> dict:
    upload_date = doc.get("upload_date")
    if isinstance(upload_date, datetime):
        upload_date = upload_date.isoformat()
    return {
        "id": doc.get("id"),
        "original_filename": doc.get("original_filename"),
        "size": doc.get("size"),
        "content_type": doc.get("content_type"),
        "upload_date": upload_date,
        "owner_id": doc.get("owner_id"),
        "owner_username": doc.get("owner_username"),
        "owner_type": doc.get("owner_type"),
        "is_public": doc.get("is_public", True),
        "source": doc.get("source", "upload"),
    }


@api_router.get("/admin/users")
async def admin_list_users(admin: User = Depends(get_admin_user)):
    docs = []
    online_ids = set(manager.user_info.keys())
    async for u in db.users.find({}, {"_id": 0, "password_hash": 0}):
        user_data = _serialize_user_doc(u)
        user_data["online"] = u.get("id") in online_ids
        docs.append(user_data)
    return docs


@api_router.get("/admin/files")
async def admin_list_files(admin: User = Depends(get_admin_user)):
    docs = []
    async for f in db.files.find({}, {"_id": 0}):
        docs.append(_serialize_file_doc(f))
    return docs


@api_router.delete("/admin/files/{file_id}")
async def admin_delete_file(file_id: str, admin: User = Depends(get_admin_user)):
    file_doc = await db.files.find_one({"id": file_id}, {"_id": 0})
    if not file_doc:
        raise HTTPException(status_code=404, detail="File not found")

    if file_doc.get("source") == "upload":
        try:
            p = UPLOAD_DIR / file_doc["filename"]
            if p.exists():
                p.unlink()
        except Exception as ex:
            logger.warning(f"admin delete: disk unlink failed for {file_id}: {ex}")

    await db.files.delete_one({"id": file_id})
    await update_user_data_shared(file_doc["owner_id"], -file_doc.get("size", 0))
    await log_history(admin.id, "admin_delete", file_doc.get("original_filename", file_id), file_id)
    return {"success": True}


@api_router.delete("/admin/files/bulk-delete")
async def admin_bulk_delete_files(file_ids: List[str] = Query(..., description="Comma-separated file IDs to delete"), admin: User = Depends(get_admin_user)):
    """Bulk delete files by IDs. Returns counts of deleted and not-found."""
    deleted_count = 0
    not_found = []
    failed = []

    for file_id in file_ids:
        file_doc = await db.files.find_one({"id": file_id}, {"_id": 0})
        if not file_doc:
            not_found.append(file_id)
            continue

        if file_doc.get("source") == "upload":
            try:
                p = UPLOAD_DIR / file_doc["filename"]
                if p.exists():
                    p.unlink()
            except Exception as ex:
                logger.warning(f"admin bulk delete: disk unlink failed for {file_id}: {ex}")
                failed.append(file_id)
                continue

        await db.files.delete_one({"id": file_id})
        await update_user_data_shared(file_doc["owner_id"], -file_doc.get("size", 0))
        deleted_count += 1

    return {
        "success": True,
        "deleted_count": deleted_count,
        "not_found_count": len(not_found),
        "failed_count": len(failed)
    }


@api_router.post("/admin/users/{user_id}/block")
async def admin_block_user(user_id: str, admin: User = Depends(get_admin_user)):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot block your own admin account")
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.get("is_admin"):
        raise HTTPException(status_code=400, detail="Cannot block another admin")
    await db.users.update_one({"id": user_id}, {"$set": {"is_blocked": True}})
    return {"success": True, "is_blocked": True}


@api_router.post("/admin/users/{user_id}/unblock")
async def admin_unblock_user(user_id: str, admin: User = Depends(get_admin_user)):
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    await db.users.update_one({"id": user_id}, {"$set": {"is_blocked": False}})
    return {"success": True, "is_blocked": False}


@api_router.delete("/admin/users/{user_id}")
async def admin_delete_user(user_id: str, admin: User = Depends(get_admin_user)):
    """Hard-delete a user plus all their files (disk + DB) and history."""
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own admin account")
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.get("is_admin"):
        raise HTTPException(status_code=400, detail="Cannot delete another admin")

    async for f in db.files.find({"owner_id": user_id, "source": "upload"}, {"_id": 0, "filename": 1}):
        try:
            p = UPLOAD_DIR / f["filename"]
            if p.exists():
                p.unlink()
        except Exception as ex:
            logger.warning(f"admin user-delete: disk unlink failed: {ex}")

    files_res = await db.files.delete_many({"owner_id": user_id})
    history_res = await db.history.delete_many({"user_id": user_id})
    user_res = await db.users.delete_one({"id": user_id})
    return {
        "success": True,
        "files_deleted": files_res.deleted_count,
        "history_deleted": history_res.deleted_count,
        "user_deleted": user_res.deleted_count,
    }


@api_router.post("/admin/users/{user_id}/mute")
async def admin_mute_user(user_id: str, minutes: int = 10, admin: User = Depends(get_admin_user)):
    """Mute a user from chat for `minutes` minutes."""
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot mute yourself")
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.get("is_admin"):
        raise HTTPException(status_code=400, detail="Cannot mute another admin")
    until = datetime.now(timezone.utc) + timedelta(minutes=max(1, minutes))
    await db.users.update_one({"id": user_id}, {"$set": {"muted_until": until.isoformat()}})
    await manager.broadcast_all({
        "type": "chat_mute",
        "user_id": user_id,
        "muted_until": until.isoformat(),
    })
    return {"success": True, "muted_until": until.isoformat()}


@api_router.post("/admin/users/{user_id}/unmute")
async def admin_unmute_user(user_id: str, admin: User = Depends(get_admin_user)):
    await db.users.update_one({"id": user_id}, {"$set": {"muted_until": None}})
    await manager.broadcast_all({
        "type": "chat_mute",
        "user_id": user_id,
        "muted_until": None,
    })
    return {"success": True}


@api_router.patch("/admin/users/{user_id}/rename")
async def admin_rename_user(user_id: str, payload: dict, admin: User = Depends(get_admin_user)):
    new_name = (payload.get("username") or "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Username is required")
    if len(new_name) < 2 or len(new_name) > 32:
        raise HTTPException(status_code=400, detail="Username must be 2-32 characters")
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="Cannot rename yourself here")

    new_name = await ensure_username_available(new_name, exclude_user_id=user_id)

    db_user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if db_user:
        await db.users.update_one({"id": user_id}, {"$set": {"username": new_name}})
        # Reflect in past chat messages so history shows updated handle
        await db.chat_messages.update_many({"user_id": user_id}, {"$set": {"username": new_name}})

    # Update live connection info for guest or registered user
    if user_id in manager.user_info:
        manager.user_info[user_id]["username"] = new_name
        await manager.broadcast_online_users()

    return {"success": True, "user_id": user_id, "username": new_name}


@api_router.get("/users/directory")
async def users_directory(current_user: User = Depends(get_current_user)):
    """List registered users + online status from the ConnectionManager.
    Guest users are excluded (ephemeral). Includes the caller too."""
    online_ids = set(manager.active_connections.keys())
    docs = []
    async for u in db.users.find(
        {"is_guest": {"$ne": True}},
        {"_id": 0, "id": 1, "username": 1, "emoji": 1, "avatar_url": 1, "is_admin": 1,
         "is_blocked": 1, "muted_until": 1, "last_seen": 1},
    ):
        info = manager.user_info.get(u["id"]) or {}
        docs.append({
            "id": u["id"],
            "username": u["username"],
            "emoji": info.get("emoji") or u.get("emoji") or "👤",
            "avatar_url": u.get("avatar_url"),
            "is_admin": u.get("is_admin", False),
            "is_blocked": u.get("is_blocked", False),
            "muted_until": u.get("muted_until"),
            "last_seen": u.get("last_seen"),
            "online": u["id"] in online_ids,
        })
    # Guests currently online are surfaced too so the chat sidebar sees them
    for uid, info in manager.user_info.items():
        if not any(d["id"] == uid for d in docs):
            docs.append({
                "id": uid,
                "username": info.get("username") or "Guest",
                "emoji": info.get("emoji") or "👤",
                "is_admin": False,
                "is_blocked": False,
                "muted_until": None,
                "last_seen": info.get("connected_at"),
                "online": True,
                "is_guest": True,
            })
    docs.sort(key=lambda d: (not d.get("online", False), d["username"].lower()))
    return docs


# ============================================================================
# Chat Endpoints
# ============================================================================

CHAT_REACTION_LIMIT = 8
CHAT_MESSAGE_MAX_LEN = 2000

def _serialize_chat(doc: dict) -> dict:
    out = dict(doc)
    out.pop("_id", None)
    for k in ("created_at", "edited_at"):
        v = out.get(k)
        if isinstance(v, datetime):
            out[k] = v.isoformat()
    # Strip content for deleted messages; keep `deleted` and `deleted_by` so UI can render placeholder.
    if out.get("deleted"):
        out["content"] = ""
        out["reactions"] = {}
        out["pinned"] = False
    return out


def _is_currently_muted(user_doc: dict) -> Optional[str]:
    raw = user_doc.get("muted_until") if user_doc else None
    if not raw:
        return None
    if isinstance(raw, datetime):
        until = raw
    else:
        try:
            until = datetime.fromisoformat(raw)
        except Exception:
            return None
    if until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    if until > datetime.now(timezone.utc):
        return until.isoformat()
    return None


@api_router.get("/chat/messages")
async def chat_list(limit: int = 50, before: Optional[str] = None,
                    current_user: User = Depends(get_current_user)):
    limit = max(1, min(limit, 200))
    # Include deleted msgs so UI can show "Message deleted" placeholder; content is stripped in _serialize_chat.
    query: dict = {}
    if before:
        try:
            query["created_at"] = {"$lt": datetime.fromisoformat(before)}
        except Exception:
            pass
    cursor = db.chat_messages.find(query, {"_id": 0}).sort("created_at", -1).limit(limit)
    docs = [_serialize_chat(d) async for d in cursor]
    docs.reverse()
    return docs


@api_router.post("/chat/messages")
async def chat_send(payload: ChatMessageCreate, current_user: User = Depends(get_current_user)):
    if current_user.is_blocked:
        raise HTTPException(status_code=403, detail="Account is blocked")

    fresh_user = await db.users.find_one({"id": current_user.id}, {"_id": 0})
    muted_until = _is_currently_muted(fresh_user)
    if muted_until:
        raise HTTPException(status_code=403, detail=f"You are muted until {muted_until}")

    content = (payload.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message is empty")
    if len(content) > CHAT_MESSAGE_MAX_LEN:
        raise HTTPException(status_code=400, detail=f"Message exceeds {CHAT_MESSAGE_MAX_LEN} chars")

    msg = ChatMessage(
        user_id=current_user.id,
        username=current_user.username,
        emoji=current_user.emoji,
        avatar_url=current_user.avatar_url,
        is_admin=current_user.is_admin,
        content=content,
        reply_to=payload.reply_to,
    )
    doc = msg.model_dump()
    doc["created_at"] = doc["created_at"].isoformat()
    if doc.get("edited_at"):
        doc["edited_at"] = doc["edited_at"].isoformat()
    await db.chat_messages.insert_one(doc)
    payload_out = _serialize_chat(doc)
    await manager.broadcast_all({"type": "chat_new", "message": payload_out})
    return payload_out


@api_router.patch("/chat/messages/{message_id}")
async def chat_edit(message_id: str, payload: ChatMessageEdit,
                    current_user: User = Depends(get_current_user)):
    msg = await db.chat_messages.find_one({"id": message_id}, {"_id": 0})
    if not msg or msg.get("deleted"):
        raise HTTPException(status_code=404, detail="Message not found")
    if msg["user_id"] != current_user.id and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not your message")

    content = (payload.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message is empty")
    if len(content) > CHAT_MESSAGE_MAX_LEN:
        raise HTTPException(status_code=400, detail=f"Message exceeds {CHAT_MESSAGE_MAX_LEN} chars")

    edited_at = datetime.now(timezone.utc).isoformat()
    await db.chat_messages.update_one(
        {"id": message_id},
        {"$set": {"content": content, "edited_at": edited_at}},
    )
    updated = await db.chat_messages.find_one({"id": message_id}, {"_id": 0})
    payload_out = _serialize_chat(updated)
    await manager.broadcast_all({"type": "chat_edit", "message": payload_out})
    return payload_out


@api_router.delete("/chat/messages/{message_id}")
async def chat_delete_message(message_id: str, current_user: User = Depends(get_current_user)):
    msg = await db.chat_messages.find_one({"id": message_id}, {"_id": 0})
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    if msg["user_id"] != current_user.id and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not your message")
    deleted_by = "admin" if current_user.is_admin and msg["user_id"] != current_user.id else "self"
    await db.chat_messages.update_one(
        {"id": message_id},
        {"$set": {"deleted": True, "deleted_by": deleted_by}},
    )
    await manager.broadcast_all({
        "type": "chat_delete",
        "message_id": message_id,
        "deleted_by": deleted_by,
    })
    return {"success": True}


@api_router.post("/chat/messages/{message_id}/react")
async def chat_react(message_id: str, emoji: str, current_user: User = Depends(get_current_user)):
    emoji = (emoji or "").strip()
    if not emoji or len(emoji) > 8:
        raise HTTPException(status_code=400, detail="Invalid reaction")
    msg = await db.chat_messages.find_one({"id": message_id}, {"_id": 0})
    if not msg or msg.get("deleted"):
        raise HTTPException(status_code=404, detail="Message not found")

    reactions = msg.get("reactions") or {}
    users = reactions.get(emoji, [])
    if current_user.id in users:
        users = [u for u in users if u != current_user.id]
    else:
        if len(users) >= 500:
            raise HTTPException(status_code=400, detail="Reaction limit reached")
        users.append(current_user.id)
    if users:
        reactions[emoji] = users
    else:
        reactions.pop(emoji, None)
    if len(reactions) > CHAT_REACTION_LIMIT:
        # Drop the least-populated reaction to bound the dict
        smallest = min(reactions.keys(), key=lambda k: len(reactions[k]))
        reactions.pop(smallest, None)

    await db.chat_messages.update_one({"id": message_id}, {"$set": {"reactions": reactions}})
    await manager.broadcast_all({
        "type": "chat_react",
        "message_id": message_id,
        "reactions": reactions,
    })
    return {"reactions": reactions}


@api_router.delete("/chat/messages")
async def chat_clear_own(current_user: User = Depends(get_current_user)):
    """Soft-delete all messages sent by the current user."""
    result = await db.chat_messages.update_many(
        {"user_id": current_user.id, "deleted": {"$ne": True}},
        {"$set": {"deleted": True, "deleted_by": "self"}},
    )
    await manager.broadcast_all({
        "type": "chat_clear",
        "scope": "user",
        "user_id": current_user.id,
        "deleted_by": "self",
    })
    return {"deleted": result.modified_count}


@api_router.delete("/admin/chat/messages")
async def chat_clear_all(admin: User = Depends(get_admin_user)):
    """Admin: hard-delete every chat message."""
    result = await db.chat_messages.delete_many({})
    await manager.broadcast_all({
        "type": "chat_clear",
        "scope": "all",
        "deleted_by": "admin",
    })
    return {"deleted": result.deleted_count}


@api_router.post("/chat/messages/{message_id}/pin")
async def chat_pin(message_id: str, admin: User = Depends(get_admin_user)):
    """Admin: toggle pinned state for a message."""
    msg = await db.chat_messages.find_one({"id": message_id}, {"_id": 0})
    if not msg or msg.get("deleted"):
        raise HTTPException(status_code=404, detail="Message not found")
    new_pinned = not msg.get("pinned", False)
    await db.chat_messages.update_one({"id": message_id}, {"$set": {"pinned": new_pinned}})
    await manager.broadcast_all({
        "type": "chat_pin",
        "message_id": message_id,
        "pinned": new_pinned,
    })
    return {"pinned": new_pinned}


@api_router.get("/auth/google")
async def google_auth():
    """Initiate Google OAuth flow for login/signup"""
    try:
        client_id = os.getenv("GOOGLE_CLIENT_ID")
        client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
        backend_url = os.getenv('BACKEND_URL', 'http://localhost:8001')
        redirect_uri = f"{backend_url}/api/auth/google/callback"
        
        if not client_id or not client_secret:
            raise HTTPException(
                status_code=500,
                detail="Google OAuth not configured"
            )
        
        flow = Flow.from_client_config(
            {
                "web": {
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "redirect_uris": [redirect_uri]
                }
            },
            scopes=[
                'openid',
                'https://www.googleapis.com/auth/userinfo.email',
                'https://www.googleapis.com/auth/userinfo.profile'
            ],
            redirect_uri=redirect_uri
        )
        
        authorization_url, state = flow.authorization_url(
            access_type='offline',
            include_granted_scopes='true',
            prompt='consent'
        )
        
        logger.info("Google OAuth initiated")
        return {"authorization_url": authorization_url, "state": state}
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to initiate Google OAuth: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to initiate Google OAuth: {str(e)}")

@api_router.get("/auth/google/callback")
async def google_auth_callback(code: str = Query(...), state: str = Query(None)):
    """Handle Google OAuth callback for login/signup"""
    try:
        client_id = os.getenv("GOOGLE_CLIENT_ID")
        client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
        backend_url = os.getenv('BACKEND_URL', 'http://localhost:8001')
        redirect_uri = f"{backend_url}/api/auth/google/callback"
        frontend_url = os.getenv('FRONTEND_URL', 'http://localhost:3000')
        
        flow = Flow.from_client_config(
            {
                "web": {
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "redirect_uris": [redirect_uri]
                }
            },
            scopes=None,
            redirect_uri=redirect_uri
        )
        
        flow.fetch_token(code=code)
        credentials = flow.credentials
        
        # Get user info from Google
        import requests
        userinfo_response = requests.get(
            'https://www.googleapis.com/oauth2/v2/userinfo',
            headers={'Authorization': f'Bearer {credentials.token}'}
        )
        userinfo = userinfo_response.json()
        
        google_id = userinfo.get('id')
        email = userinfo.get('email')
        name = userinfo.get('name', email.split('@')[0])
        
        # Check if user exists
        user_doc = await db.users.find_one({"email": email}, {"_id": 0})
        
        if user_doc:
            # Existing user - login
            user = User(**user_doc)
        else:
            # New user - register
            user = User(
                username=name,
                email=email,
                is_guest=False,
                emoji="👤",
                google_id=google_id
            )
            
            doc = user.model_dump()
            doc['created_date'] = doc['created_date'].isoformat()
            # Store Google Access Token (In production, encrypt this!)
            doc['google_access_token'] = credentials.token
            await db.users.insert_one(doc)
            
        if user_doc:
             # Update token for existing user
             await db.users.update_one(
                 {"email": email},
                 {"$set": {"google_access_token": credentials.token, "google_drive_connected": True}}
             )
        
        # Create access token
        access_token = create_access_token(data={"sub": user.id})
        
        # Redirect to frontend with token
        return RedirectResponse(url=f"{frontend_url}?google_auth=success&token={access_token}&user_id={user.id}&google_drive_prompt=true")
    
    except Exception as e:
        logger.error(f"Google OAuth callback failed: {e}")
        frontend_url = os.getenv('FRONTEND_URL', os.getenv('REACT_APP_BACKEND_URL', ''))
        return RedirectResponse(url=f"{frontend_url}?google_auth=error&error={str(e)}")



@api_router.get("/history", response_model=List[HistoryResponse])
async def get_history(current_user: User = Depends(get_current_user)):
    """Get user activity history"""
    try:
        history = await db.history.find({"user_id": current_user.id}).sort("timestamp", -1).to_list(100)
        return [
            HistoryResponse(
                id=h['id'],
                action=h['action'],
                file_name=h['file_name'],
                timestamp=h['timestamp'],
                details=h.get('details')
            ) for h in history
        ]
    except Exception as e:
        logger.error(f"Failed to fetch history: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ============================================================================
# File Management Routes
# ============================================================================

@api_router.post("/upload", response_model=FileResponse)
@limiter.limit("30/minute")
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    is_public: bool = Form(True),
    shared_with: str = Form(""), # Comma separated emails
    folder_path: str = Form(""), # Relative path within uploaded folder
    current_user: User = Depends(get_current_user)
):
    """Upload a file - Rate limited to 30 uploads per minute"""
    try:
        # Check data limit
        file_size = 0
        content = await file.read()
        file_size = len(content)

        # Hard cloud-upload cap (use P2P for anything larger)
        CLOUD_UPLOAD_MAX = 100 * 1024 * 1024
        if file_size > CLOUD_UPLOAD_MAX:
            raise HTTPException(
                status_code=413,
                detail="File exceeds the 100 MB cloud upload limit. Send it directly to a peer instead."
            )

        if not await check_data_limit(current_user, file_size):
            raise HTTPException(
                status_code=403,
                detail="Guest data limit exceeded (2GB). Please create an account to continue sharing."
            )
        
        # Generate unique file ID
        file_id = str(uuid.uuid4())
        file_extension = Path(file.filename).suffix
        stored_filename = f"{file_id}{file_extension}"
        file_path = UPLOAD_DIR / stored_filename
        
        # Encrypt content
        encrypted_content, encrypted_key = encrypt_file_content(content)
        
        # Save encrypted file to disk
        with open(file_path, "wb") as buffer:
            buffer.write(encrypted_content)
            
        # Parse shared_with
        shared_users = [email.strip() for email in shared_with.split(',') if email.strip()]
        
        # Create metadata
        file_metadata = FileMetadata(
            id=file_id,
            filename=stored_filename,
            original_filename=file.filename,
            size=file_size,
            content_type=file.content_type,
            owner_id=current_user.id,
            owner_username=current_user.username,
            owner_type="guest" if current_user.is_guest else "user",
            is_public=is_public,
            shared_with_users=shared_users,
            source="upload",
            encrypted_key=encrypted_key.decode('utf-8'),
            folder_path=folder_path if folder_path else None
        )
        
        # Save metadata to MongoDB
        doc = file_metadata.model_dump()
        doc['upload_date'] = doc['upload_date'].isoformat()
        await db.files.insert_one(doc)

        # Update user's total data shared
        await update_user_data_shared(current_user.id, file_size)

        # Broadcast file update to all connected clients
        await manager.broadcast_all({
            "type": "file_uploaded",
            "file_id": file_id,
            "owner_id": current_user.id,
            "owner_username": current_user.username
        })

        # Log history
        await log_history(current_user.id, "upload", file.filename, file_id, f"Size: {file_size} bytes")
        
        # Return response
        return FileResponse(
            id=file_id,
            filename=stored_filename,
            original_filename=file.filename,
            size=file_size,
            content_type=file.content_type,
            upload_date=doc['upload_date'],
            download_url=f"/api/files/{file_id}/download",
            share_url=f"/api/files/{file_id}/download",
            owner_id=current_user.id,
            owner_username=current_user.username,
            owner_type="guest" if current_user.is_guest else "user",
            is_public=is_public,
            source="upload",
            shared_with_users=shared_users,
            folder_path=folder_path if folder_path else None
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"File upload failed: {e}")
        raise HTTPException(status_code=500, detail=f"File upload failed: {str(e)}")

@api_router.get("/files", response_model=List[FileResponse])
async def get_files(current_user: Optional[User] = Depends(get_optional_user)):
    """Get files based on user permissions"""
    try:
        query = {}
        
        # If user is authenticated, show their files
        if current_user:
            # Show files owned by user OR public files OR files shared with user
            query = {
                "$or": [
                    {"owner_id": current_user.id},
                    {"is_public": True},
                    {"shared_with_users": current_user.email}
                ]
            }
        else:
            # If no user, return empty list
            return []
        
        files = await db.files.find(query, {"_id": 0}).sort("upload_date", -1).to_list(1000)
        
        file_responses = []
        for file_doc in files:
            file_responses.append(FileResponse(
                id=file_doc['id'],
                filename=file_doc['filename'],
                original_filename=file_doc['original_filename'],
                size=file_doc['size'],
                content_type=file_doc.get('content_type'),
                upload_date=file_doc['upload_date'],
                download_url=f"/api/files/{file_doc['id']}/download",
                share_url=f"/api/files/{file_doc['id']}/download",
                owner_id=file_doc.get('owner_id', ''),
                owner_username=file_doc.get('owner_username', 'Unknown'),
                owner_type=file_doc.get('owner_type', 'guest'),
                is_public=file_doc.get('is_public', True),
                source=file_doc.get('source', 'upload'),
                drive_file_id=file_doc.get('drive_file_id'),
                shared_with_users=file_doc.get('shared_with_users', []),
                reaction_count=len(file_doc.get('reactions') or []),
                reacted=(current_user is not None and current_user.id in (file_doc.get('reactions') or [])),
                folder_path=file_doc.get('folder_path')
            ))
        
        return file_responses
    
    except Exception as e:
        logger.error(f"Failed to fetch files: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch files: {str(e)}")

@api_router.get("/files/{file_id}/download")
async def download_file(file_id: str, current_user: Optional[User] = Depends(get_optional_user)):
    """Download a file"""
    try:
        # Get file metadata from MongoDB
        file_doc = await db.files.find_one({"id": file_id}, {"_id": 0})
        
        if not file_doc:
            raise HTTPException(status_code=404, detail="File not found")
        
        # If it's a Google Drive file, redirect to Drive download
        if file_doc.get('source') == 'google_drive':
            drive_file_id = file_doc.get('drive_file_id')
            if drive_file_id:
                # Return a direct download link
                return {"download_url": f"https://drive.google.com/uc?export=download&id={drive_file_id}"}
        
        file_path = UPLOAD_DIR / file_doc['filename']
        
        # Check permissions
        if not file_doc.get('is_public', True):
            if not current_user:
                raise HTTPException(status_code=403, detail="Authentication required for this file")
            if file_doc['owner_id'] != current_user.id and current_user.email not in file_doc.get('shared_with_users', []):
                raise HTTPException(status_code=403, detail="Access denied")
        
        # Decrypt if needed
        if file_doc.get('encrypted_key'):
            with open(file_path, "rb") as f:
                encrypted_content = f.read()
            
            decrypted_content = decrypt_file_content(encrypted_content, file_doc['encrypted_key'].encode('utf-8'))
            
            # Log history
            # Note: We can't easily log history in a streaming response without background tasks, 
            # but for now we'll log it here before returning.
            # Ideally use BackgroundTasks
            if current_user:
                 await log_history(current_user.id, "download", file_doc['original_filename'], file_id)

            return Response(
                content=decrypted_content,
                media_type=file_doc.get('content_type', 'application/octet-stream'),
                headers={"Content-Disposition": f"attachment; filename={file_doc['original_filename']}"}
            )

        return FastAPIFileResponse(
            path=file_path,
            filename=file_doc['original_filename'],
            media_type=file_doc.get('content_type', 'application/octet-stream')
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Download failed: {e}")
        raise HTTPException(status_code=500, detail=f"Download failed: {str(e)}")

@api_router.get("/files/download-folder")
async def download_folder(
    folder_path: str = Query(..., description="Folder name to download"),
    current_user: Optional[User] = Depends(get_optional_user)
):
    """Download all files in a folder as a zip archive"""
    try:
        if not current_user:
            raise HTTPException(status_code=401, detail="Authentication required")
        
        # Find all files whose folder_path starts with folder_path + "/"
        # This matches files in the folder and its subfolders
        regex_pattern = f"^{re.escape(folder_path)}/"
        
        query = {
            "owner_id": current_user.id,
            "folder_path": {"$regex": regex_pattern}
        }
        files = await db.files.find(query, {"_id": 0}).to_list(1000)
        
        if not files:
            raise HTTPException(status_code=404, detail="Folder not found or empty")
        
        # Create temp zip file
        zip_filename = f"{folder_path}_{uuid.uuid4().hex[:8]}.zip"
        zip_path = UPLOAD_DIR / zip_filename
        
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for file_doc in files:
                stored_path = UPLOAD_DIR / file_doc['filename']
                if not stored_path.exists():
                    continue
                
                # Use the stored folder_path as the arcname to preserve structure
                arcname = file_doc.get('folder_path') or file_doc['original_filename']
                
                # Decrypt file
                if file_doc.get('encrypted_key'):
                    with open(stored_path, "rb") as f:
                        encrypted = f.read()
                    decrypted = decrypt_file_content(
                        encrypted, 
                        file_doc['encrypted_key'].encode('utf-8')
                    )
                    zf.writestr(arcname, decrypted)
                else:
                    zf.write(stored_path, arcname)
        
        # Return the zip file
        response = FastAPIFileResponse(
            path=zip_path,
            filename=f"{folder_path}.zip",
            media_type="application/zip"
        )
        
        return response
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Folder download failed: {e}")
        raise HTTPException(status_code=500, detail=f"Folder download failed: {str(e)}")


@api_router.delete("/files/{file_id}")
async def delete_file(file_id: str, current_user: User = Depends(get_current_user)):
    """Delete a file"""
    try:
        # Get file metadata from MongoDB
        file_doc = await db.files.find_one({"id": file_id}, {"_id": 0})
        
        if not file_doc:
            raise HTTPException(status_code=404, detail="File not found")
        
        # Check ownership
        if file_doc['owner_id'] != current_user.id:
            raise HTTPException(status_code=403, detail="You don't have permission to delete this file")
        
        # Delete file from disk (if it's an uploaded file)
        if file_doc.get('source') == 'upload':
            file_path = UPLOAD_DIR / file_doc['filename']
            if file_path.exists():
                file_path.unlink()
        
        # Delete metadata from MongoDB
        await db.files.delete_one({"id": file_id})

        # Update user's total data shared
        await update_user_data_shared(current_user.id, -file_doc['size'])

        # Broadcast file deletion to all connected clients
        await manager.broadcast_all({
            "type": "file_deleted",
            "file_id": file_id,
            "owner_id": current_user.id
        })

        return {"message": "File deleted successfully", "file_id": file_id}
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Delete failed: {e}")
        raise HTTPException(status_code=500, detail=f"Delete failed: {str(e)}")

@api_router.post("/files/{file_id}/react")
async def react_to_file(file_id: str, current_user: User = Depends(get_current_user)):
    """Toggle the current user's reaction (heart) on a file."""
    file_doc = await db.files.find_one({"id": file_id}, {"_id": 0})
    if not file_doc:
        raise HTTPException(status_code=404, detail="File not found")
    reactions = file_doc.get("reactions") or []
    if current_user.id in reactions:
        reactions = [u for u in reactions if u != current_user.id]
        reacted = False
    else:
        reactions.append(current_user.id)
        reacted = True
    await db.files.update_one({"id": file_id}, {"$set": {"reactions": reactions}})
    return {"reaction_count": len(reactions), "reacted": reacted}


@api_router.get("/files/{file_id}/preview")
async def preview_file(file_id: str, current_user: Optional[User] = Depends(get_optional_user)):
    """Preview a file in browser (for images, PDFs, videos, text)"""
    try:
        file_doc = await db.files.find_one({"id": file_id}, {"_id": 0})
        if not file_doc:
            raise HTTPException(status_code=404, detail="File not found")
        
        # Check permissions
        if not file_doc.get('is_public', True):
            if not current_user:
                raise HTTPException(status_code=403, detail="Authentication required for this file")
            if file_doc['owner_id'] != current_user.id and current_user.email not in file_doc.get('shared_with_users', []):
                raise HTTPException(status_code=403, detail="Access denied")
        
        # Handle Drive files - redirect to Drive preview
        if file_doc.get('source') == 'google_drive':
            drive_file_id = file_doc.get('drive_file_id')
            if drive_file_id:
                # Return redirect to Drive web view
                from fastapi.responses import RedirectResponse
                return RedirectResponse(url=f"https://drive.google.com/file/d/{drive_file_id}/preview")
            raise HTTPException(status_code=400, detail="Drive file ID not found")
        
        # Handle local files
        file_path = UPLOAD_DIR / file_doc['filename']
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="File not found on server")
        
        # Decrypt if needed
        if file_doc.get('encrypted_key'):
            with open(file_path, "rb") as f:
                encrypted_content = f.read()
            content = decrypt_file_content(encrypted_content, file_doc['encrypted_key'].encode('utf-8'))
        else:
            with open(file_path, "rb") as f:
                content = f.read()
        
        # Return file for inline viewing
        return Response(
            content=content,
            media_type=file_doc.get('content_type', 'application/octet-stream'),
            headers={
                "Content-Disposition": f"inline; filename={file_doc['original_filename']}",
                "Cache-Control": "public, max-age=3600"
            }
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Preview failed: {e}")
        raise HTTPException(status_code=500, detail=f"Preview failed: {str(e)}")

# ============================================================================
# WebSocket for WebRTC Signaling
# ============================================================================

@app.websocket("/api/ws/{user_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: str,
    username: str = Query(None),
    emoji: str = Query(None)
):
    """WebSocket endpoint for WebRTC signaling"""
    await manager.connect(user_id, websocket, username, emoji)
    # User came back online — cancel any pending guest message cleanup.
    cancel_guest_msg_cleanup(user_id)
    # User came back online — cancel any pending guest message cleanup.
    cancel_guest_msg_cleanup(user_id)

    try:
        while True:
            data = await websocket.receive_json()
            message_type = data.get("type")
            
            if message_type == "offer":
                # Forward offer to target peer
                target_id = data.get("target")
                await manager.send_message(target_id, {
                    "type": "offer",
                    "offer": data.get("offer"),
                    "sender": user_id
                })
            
            elif message_type == "answer":
                # Forward answer to target peer
                target_id = data.get("target")
                await manager.send_message(target_id, {
                    "type": "answer",
                    "answer": data.get("answer"),
                    "sender": user_id
                })
            
            elif message_type == "ice-candidate":
                # Forward ICE candidate to target peer
                target_id = data.get("target")
                await manager.send_message(target_id, {
                    "type": "ice-candidate",
                    "candidate": data.get("candidate"),
                    "sender": user_id
                })
            
            elif message_type == "update_info":
                # Update user info
                username = data.get("username")
                emoji = data.get("emoji")
                if user_id in manager.user_info:
                    if username:
                        manager.user_info[user_id]["username"] = username
                    if emoji:
                        manager.user_info[user_id]["emoji"] = emoji
                    await manager.broadcast_online_users()
            
            elif message_type == "update_info":
                # Update user info
                username = data.get("username")
                emoji = data.get("emoji")
                if user_id in manager.user_info:
                    if username:
                        manager.user_info[user_id]["username"] = username
                    if emoji:
                        manager.user_info[user_id]["emoji"] = emoji
                    await manager.broadcast_online_users()
    
    except WebSocketDisconnect:
        manager.disconnect(user_id)
        await manager.broadcast_online_users()
        await _maybe_schedule_guest_cleanup_on_disconnect(user_id)
    except Exception as e:
        msg = str(e).lower()
        if "not connected" in msg or "accept" in msg or "closed" in msg:
            logger.info(f"WebSocket closed for user {user_id}: {e}")
        else:
            logger.error(f"WebSocket error for user {user_id}: {e}")
        manager.disconnect(user_id)
        await manager.broadcast_online_users()
        await _maybe_schedule_guest_cleanup_on_disconnect(user_id)


async def _maybe_schedule_guest_cleanup_on_disconnect(user_id: str):
    """If the disconnecting user is a guest, schedule a 5-min message cleanup."""
    try:
        u = await db.users.find_one({"id": user_id}, {"_id": 0, "is_guest": 1})
        if u and u.get("is_guest"):
            schedule_guest_msg_cleanup(user_id)
    except Exception as e:
        logger.error(f"Failed to evaluate guest cleanup for {user_id}: {e}")

@api_router.get("/online-users")
async def get_online_users():
    """Get list of online users"""
    return {"users": manager.get_online_users()}

# ============================================================================
# Google Drive Integration
# ============================================================================

@api_router.get("/drive/connect")
async def connect_drive(current_user: User = Depends(get_current_user)):
    """Initiate Google Drive OAuth flow"""
    try:
        client_id = os.getenv("GOOGLE_CLIENT_ID")
        client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
        redirect_uri = os.getenv("GOOGLE_DRIVE_REDIRECT_URI")
        
        if not client_id or not client_secret:
            raise HTTPException(
                status_code=500,
                detail="Google Drive not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env"
            )
        
        flow = Flow.from_client_config(
            {
                "web": {
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "redirect_uris": [redirect_uri]
                }
            },
            scopes=[
                'https://www.googleapis.com/auth/drive.file',
                'https://www.googleapis.com/auth/drive.readonly'
            ],
            redirect_uri=redirect_uri
        )
        
        authorization_url, state = flow.authorization_url(
            access_type='offline',
            include_granted_scopes='true',
            prompt='consent',
            state=current_user.id
        )
        
        logger.info(f"Drive OAuth initiated for user {current_user.id}")
        return {"authorization_url": authorization_url}
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to initiate OAuth: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to initiate OAuth: {str(e)}")

@api_router.get("/drive/callback")
async def drive_callback(code: str = Query(...), state: str = Query(...)):
    """Handle Google Drive OAuth callback"""
    try:
        client_id = os.getenv("GOOGLE_CLIENT_ID")
        client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
        redirect_uri = os.getenv("GOOGLE_DRIVE_REDIRECT_URI")
        frontend_url = os.getenv("FRONTEND_URL", os.getenv("REACT_APP_BACKEND_URL", ""))
        
        flow = Flow.from_client_config(
            {
                "web": {
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "redirect_uris": [redirect_uri]
                }
            },
            scopes=None,
            redirect_uri=redirect_uri
        )
        
        flow.fetch_token(code=code)
        credentials = flow.credentials
        
        logger.info(f"Drive credentials obtained for user {state}")
        
        # Store credentials in database
        await db.drive_credentials.update_one(
            {"user_id": state},
            {"$set": {
                "user_id": state,
                "access_token": credentials.token,
                "refresh_token": credentials.refresh_token,
                "token_uri": credentials.token_uri,
                "client_id": credentials.client_id,
                "client_secret": credentials.client_secret,
                "scopes": credentials.scopes,
                "expiry": credentials.expiry.isoformat() if credentials.expiry else None,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }},
            upsert=True
        )
        
        # Update user's google_drive_connected status
        await db.users.update_one(
            {"id": state},
            {"$set": {"google_drive_connected": True}}
        )
        
        logger.info(f"Drive credentials stored for user {state}")
        
        # Redirect to frontend
        return RedirectResponse(url=f"{frontend_url}?drive_connected=true")
    
    except Exception as e:
        logger.error(f"OAuth callback failed: {e}")
        frontend_url = os.getenv("FRONTEND_URL", os.getenv("REACT_APP_BACKEND_URL", ""))
        return RedirectResponse(url=f"{frontend_url}?drive_error=true")

async def get_drive_service(current_user: User):
    """Get Google Drive service with auto-refresh credentials"""
    creds_doc = await db.drive_credentials.find_one({"user_id": current_user.id})
    if not creds_doc:
        raise HTTPException(
            status_code=400,
            detail="Google Drive not connected. Please connect your Drive first."
        )
    
    # Create credentials object
    creds = Credentials(
        token=creds_doc["access_token"],
        refresh_token=creds_doc.get("refresh_token"),
        token_uri=creds_doc["token_uri"],
        client_id=creds_doc["client_id"],
        client_secret=creds_doc["client_secret"],
        scopes=creds_doc["scopes"]
    )
    
    # Auto-refresh if expired
    if creds.expired and creds.refresh_token:
        logger.info(f"Refreshing expired token for user {current_user.id}")
        creds.refresh(GoogleRequest())
        
        # Update in database
        await db.drive_credentials.update_one(
            {"user_id": current_user.id},
            {"$set": {
                "access_token": creds.token,
                "expiry": creds.expiry.isoformat() if creds.expiry else None,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }}
        )
    return build('drive', 'v3', credentials=creds)

@api_router.get("/drive/files", response_model=List[DriveFileInfo])
async def list_drive_files(current_user: User = Depends(get_current_user)):
    """List user's Google Drive files"""
    try:
        service = await get_drive_service(current_user)
        
        # List files
        results = service.files().list(
            pageSize=100,
            fields="files(id, name, mimeType, size, webViewLink, iconLink)",
            q="trashed=false"
        ).execute()
        
        files = results.get('files', [])
        
        return [DriveFileInfo(**file) for file in files]
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to list Drive files: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to list Drive files: {str(e)}")

@api_router.post("/drive/share/{drive_file_id}", response_model=FileResponse)
async def share_drive_file(
    drive_file_id: str,
    is_public: bool = True,
    shared_with: str = "",  # Comma separated emails
    current_user: User = Depends(get_current_user)
):
    """Share a Google Drive file through UniShare"""
    try:
        service = await get_drive_service(current_user)
        
        # Get file metadata
        file_metadata = service.files().get(
            fileId=drive_file_id,
            fields="id, name, mimeType, size"
        ).execute()
        
        file_size = int(file_metadata.get('size', 0))
        
        # Check data limit
        if not await check_data_limit(current_user, file_size):
            raise HTTPException(
                status_code=403,
                detail="Guest data limit exceeded (2GB). Please create an account to continue sharing."
            )
        
        # Parse shared_with
        shared_users = [email.strip() for email in shared_with.split(',') if email.strip()]
        
        # Create metadata in our database
        file_id = str(uuid.uuid4())
        file_doc = FileMetadata(
            id=file_id,
            filename=file_metadata['name'],
            original_filename=file_metadata['name'],
            size=file_size,
            content_type=file_metadata.get('mimeType'),
            owner_id=current_user.id,
            owner_username=current_user.username,
            owner_type="guest" if current_user.is_guest else "user",
            is_public=is_public,
            shared_with_users=shared_users,
            source="google_drive",
            drive_file_id=drive_file_id
        )
        
        doc = file_doc.model_dump()
        doc['upload_date'] = doc['upload_date'].isoformat()
        await db.files.insert_one(doc)
        
        # Update user's total data shared
        await update_user_data_shared(current_user.id, file_size)
        
        # Log history
        visibility = "public" if is_public else ("shared" if shared_users else "private")
        await log_history(
            current_user.id,
            "import_drive",
            file_metadata['name'],
            file_id,
            f"Imported from Google Drive ({visibility}, {file_size} bytes)"
        )
        
        return FileResponse(
            id=file_id,
            filename=file_metadata['name'],
            original_filename=file_metadata['name'],
            size=file_size,
            content_type=file_metadata.get('mimeType'),
            upload_date=doc['upload_date'],
            download_url=f"/api/files/{file_id}/download",
            share_url=f"/api/files/{file_id}/download",
            owner_id=current_user.id,
            owner_username=current_user.username,
            owner_type="guest" if current_user.is_guest else "user",
            is_public=is_public,
            source="google_drive",
            drive_file_id=drive_file_id,
            shared_with_users=shared_users
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to share Drive file: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to share Drive file: {str(e)}")

@api_router.post("/drive/save/{file_id}")
async def save_to_drive(file_id: str, current_user: User = Depends(get_current_user)):
    """Save a UniShare file to Google Drive"""
    try:
        service = await get_drive_service(current_user)
        
        # Get file from our database
        file_doc = await db.files.find_one({"id": file_id}, {"_id": 0})
        if not file_doc:
            raise HTTPException(status_code=404, detail="File not found")
        
        # If it's already a Drive file, just return the link
        if file_doc.get('source') == 'google_drive':
            drive_file_id = file_doc.get('drive_file_id')
            return {
                "success": True,
                "message": "File is already on Google Drive",
                "drive_link": f"https://drive.google.com/file/d/{drive_file_id}/view"
            }
        
        # Read the local file
        file_path = UPLOAD_DIR / file_doc['filename']
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="File not found on server")
        
        # Upload to Google Drive
        from googleapiclient.http import MediaFileUpload
        
        file_metadata = {
            'name': file_doc['original_filename']
        }
        
        media = MediaFileUpload(
            str(file_path),
            mimetype=file_doc.get('content_type', 'application/octet-stream'),
            resumable=True
        )
        
        drive_file = service.files().create(
            body=file_metadata,
            media_body=media,
            fields='id, webViewLink'
        ).execute()
        
        logger.info(f"File {file_id} saved to Drive as {drive_file.get('id')}")
        
        return {
            "success": True,
            "drive_file_id": drive_file.get('id'),
            "drive_link": drive_file.get('webViewLink'),
            "message": "File saved to Google Drive successfully"
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to save to Drive: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save to Drive: {str(e)}")

# ============================================================================
# Main App Configuration
# ============================================================================

# Include API router
app.include_router(api_router)

# ============================================================================
# Middleware Configuration
# ============================================================================

# Security Headers Middleware
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    start_time = time.time()
    response = await call_next(request)
    
    # Security headers
    response.headers["X-Content-Type-Options"] = "nosniff"
    # Preview endpoint must be iframable for inline PDF/text/Office viewer.
    # Frontend (:3001) and backend (:8001) are different origins, so SAMEORIGIN
    # would still block — omit the header entirely for /preview.
    if "/preview" not in request.url.path:
        response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    
    # Add processing time header
    process_time = time.time() - start_time
    response.headers["X-Process-Time"] = str(process_time)
    
    # Cache control for API responses (no caching)
    if request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    
    return response

# GZip compression for responses larger than 1KB
app.add_middleware(GZipMiddleware, minimum_size=1000)

# CORS middleware - Configure based on deployment
# For production, set explicit frontend origins (comma-separated).
raw_origins = os.getenv("ALLOWED_ORIGINS", os.getenv("CORS_ORIGINS", "*")).strip()

def _clean_origin(v: str) -> str:
    return v.strip().strip('"').strip("'")

ALLOWED_ORIGINS = [_clean_origin(o) for o in raw_origins.split(",") if _clean_origin(o)] if raw_origins else ["*"]
use_wildcard_cors = ALLOWED_ORIGINS == ["*"]
origin_regex = _clean_origin(os.getenv("CORS_ORIGIN_REGEX", "")) or None
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if use_wildcard_cors else ALLOWED_ORIGINS,
    allow_origin_regex=origin_regex,
    # Browsers reject wildcard origin when credentials are enabled.
    allow_credentials=not use_wildcard_cors,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["X-Process-Time"],
    max_age=3600,
)

# ============================================================================
# Health Check and Root Endpoints
# ============================================================================

@app.get("/")
async def root():
    return {
        "message": "UniShare API - File Sharing Made Simple",
        "version": "2.0.0",
        "status": "operational",
        "features": [
            "File Upload/Download",
            "WebRTC P2P Sharing",
            "Google Drive Integration",
            "User Authentication",
            "Rate Limiting",
            "Windows Compatible"
        ]
    }

@app.get("/health")
@limiter.limit("100/minute")
async def health_check(request: Request):
    """Health check endpoint for monitoring"""
    start = time.time()
    try:
        # Check MongoDB connection
        await db.command("ping")
        db_latency = (time.time() - start) * 1000
        uptime = time.time() - SERVER_START_TIME
        return {
            "status": "healthy",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "database": "connected",
            "database_latency_ms": round(db_latency, 2),
            "uptime_seconds": round(uptime, 2),
            "version": "2.0.0"
        }
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        raise HTTPException(status_code=503, detail="Service unavailable")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
