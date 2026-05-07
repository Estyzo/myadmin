import hashlib
import json
import secrets
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import current_app, g, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash


ROLE_PERMISSIONS = {
    "admin": {
        "dashboard",
        "send_money",
        "recent_transfers",
        "requests",
        "balance",
        "messages",
        "settings",
        "users",
        "exports",
        "manage_users",
    },
    "manager": {
        "dashboard",
        "send_money",
        "recent_transfers",
        "requests",
        "balance",
        "messages",
        "settings",
        "users",
        "exports",
        "manage_users",
    },
    "operator": {"send_money", "recent_transfers", "requests", "balance"},
    "viewer": {"dashboard", "requests", "balance", "messages", "exports"},
}

ROLE_HOME = {
    "admin": "dashboard",
    "manager": "dashboard",
    "operator": "send_money",
    "viewer": "dashboard",
}


def get_auth_db_path(config=None):
    runtime_config = config or current_app.config
    configured_path = str(runtime_config.get("AUTH_DATABASE_PATH") or "").strip()
    if configured_path:
        return Path(configured_path)
    return Path(current_app.instance_path) / "auth.db"


def get_auth_connection(config=None):
    db_path = get_auth_db_path(config)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    return connection


def utc_now():
    return datetime.now(timezone.utc)


def iso_now():
    return utc_now().isoformat().replace("+00:00", "Z")


def parse_iso_datetime(value):
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def split_scope(value):
    return [item.strip() for item in str(value or "").split(",") if item.strip()]


def join_scope(values):
    return ",".join(sorted({str(item).strip() for item in values or [] if str(item).strip()}, key=str.casefold))


def normalize_role(role):
    normalized = str(role or "").strip().lower()
    return normalized if normalized in ROLE_PERMISSIONS else "operator"


def token_hash(token):
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def row_to_user(row):
    if row is None:
        return None
    user = dict(row)
    user["client_codes"] = split_scope(user.get("client_codes"))
    user["operator_scope"] = split_scope(user.get("operator_scope"))
    return user


def row_to_invitation(row):
    if row is None:
        return None
    invitation = dict(row)
    invitation["client_codes"] = split_scope(invitation.get("client_codes"))
    invitation["operator_scope"] = split_scope(invitation.get("operator_scope"))
    return invitation


def init_auth_storage(app):
    if not str(app.config.get("AUTH_DATABASE_PATH") or "").strip():
        app.config["AUTH_DATABASE_PATH"] = str(Path(app.instance_path) / "auth.db")
    with get_auth_connection(app.config) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                name TEXT NOT NULL DEFAULT '',
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'operator',
                client_codes TEXT NOT NULL DEFAULT '',
                operator_scope TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_login_at TEXT
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS invitations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL COLLATE NOCASE,
                token_hash TEXT NOT NULL UNIQUE,
                role TEXT NOT NULL,
                client_codes TEXT NOT NULL DEFAULT '',
                operator_scope TEXT NOT NULL DEFAULT '',
                invited_by INTEGER,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                accepted_at TEXT,
                revoked_at TEXT,
                accepted_user_id INTEGER,
                sent_at TEXT,
                send_error TEXT NOT NULL DEFAULT ''
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_user_id INTEGER,
                actor_email TEXT NOT NULL DEFAULT '',
                action TEXT NOT NULL,
                target_type TEXT NOT NULL DEFAULT '',
                target_id TEXT NOT NULL DEFAULT '',
                target_label TEXT NOT NULL DEFAULT '',
                details TEXT NOT NULL DEFAULT '{}',
                ip_address TEXT NOT NULL DEFAULT '',
                user_agent TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs (target_type, target_id)")
        ensure_invitation_delivery_columns(connection)
        connection.commit()
    bootstrap_admin(app)


def ensure_invitation_delivery_columns(connection):
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(invitations)").fetchall()}
    if "sent_at" not in columns:
        connection.execute("ALTER TABLE invitations ADD COLUMN sent_at TEXT")
    if "send_error" not in columns:
        connection.execute("ALTER TABLE invitations ADD COLUMN send_error TEXT NOT NULL DEFAULT ''")


def user_count(config=None):
    with get_auth_connection(config) as connection:
        row = connection.execute("SELECT COUNT(*) AS count FROM users").fetchone()
        return int(row["count"] or 0)


def bootstrap_admin(app):
    if user_count(app.config) > 0:
        return
    email = str(app.config.get("AUTH_BOOTSTRAP_EMAIL") or "admin@transferflow.local").strip().lower()
    password = str(app.config.get("AUTH_BOOTSTRAP_PASSWORD") or "ChangeMe123!").strip()
    create_user(
        email=email,
        password=password,
        name="System Admin",
        role="admin",
        client_codes=[],
        operator_scope=[],
        status="active",
        config=app.config,
    )


def create_user(email, password, name, role, client_codes=None, operator_scope=None, status="active", config=None):
    now = iso_now()
    with get_auth_connection(config) as connection:
        cursor = connection.execute(
            """
            INSERT INTO users (email, name, password_hash, role, client_codes, operator_scope, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(email or "").strip().lower(),
                str(name or "").strip(),
                generate_password_hash(password),
                normalize_role(role),
                join_scope(client_codes),
                join_scope(operator_scope),
                str(status or "active").strip().lower(),
                now,
                now,
            ),
        )
        connection.commit()
        return cursor.lastrowid


def get_user_by_id(user_id, config=None):
    try:
        normalized_id = int(user_id)
    except (TypeError, ValueError):
        return None
    with get_auth_connection(config) as connection:
        row = connection.execute("SELECT * FROM users WHERE id = ?", (normalized_id,)).fetchone()
        return row_to_user(row)


def get_user_by_email(email, config=None):
    with get_auth_connection(config) as connection:
        row = connection.execute("SELECT * FROM users WHERE email = ?", (str(email or "").strip().lower(),)).fetchone()
        return row_to_user(row)


def update_user_access(user_id, role, client_codes=None, operator_scope=None, config=None):
    now = iso_now()
    with get_auth_connection(config) as connection:
        connection.execute(
            """
            UPDATE users
            SET role = ?, client_codes = ?, operator_scope = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                normalize_role(role),
                join_scope(client_codes),
                join_scope(operator_scope),
                now,
                int(user_id),
            ),
        )
        connection.commit()
    return get_user_by_id(user_id, config=config)


def set_user_status(user_id, status, config=None):
    normalized_status = "active" if str(status or "").strip().lower() == "active" else "suspended"
    now = iso_now()
    with get_auth_connection(config) as connection:
        connection.execute(
            "UPDATE users SET status = ?, updated_at = ? WHERE id = ?",
            (normalized_status, now, int(user_id)),
        )
        connection.commit()
    return get_user_by_id(user_id, config=config)


def active_admin_count(config=None):
    with get_auth_connection(config) as connection:
        row = connection.execute("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'").fetchone()
        return int(row["count"] or 0)


def serialize_audit_details(details):
    try:
        return json.dumps(details or {}, sort_keys=True, default=str)
    except TypeError:
        return json.dumps({"value": str(details)})


def log_audit_event(action, actor=None, target_type="", target_id="", target_label="", details=None, ip_address="", user_agent="", config=None):
    active_actor = actor or {}
    with get_auth_connection(config) as connection:
        connection.execute(
            """
            INSERT INTO audit_logs (
                actor_user_id, actor_email, action, target_type, target_id, target_label,
                details, ip_address, user_agent, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                active_actor.get("id"),
                str(active_actor.get("email") or ""),
                str(action or "").strip(),
                str(target_type or "").strip(),
                str(target_id or "").strip(),
                str(target_label or "").strip(),
                serialize_audit_details(details),
                str(ip_address or "")[:120],
                str(user_agent or "")[:500],
                iso_now(),
            ),
        )
        connection.commit()


def list_audit_logs(limit=30, config=None):
    try:
        normalized_limit = max(1, min(100, int(limit)))
    except (TypeError, ValueError):
        normalized_limit = 30
    with get_auth_connection(config) as connection:
        rows = connection.execute(
            "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?",
            (normalized_limit,),
        ).fetchall()
    logs = []
    for row in rows:
        item = dict(row)
        try:
            item["details"] = json.loads(item.get("details") or "{}")
        except json.JSONDecodeError:
            item["details"] = {}
        logs.append(item)
    return logs


def authenticate_user(email, password, config=None):
    user = get_user_by_email(email, config=config)
    if not user or user.get("status") != "active":
        return None
    if not check_password_hash(user.get("password_hash", ""), str(password or "")):
        return None
    with get_auth_connection(config) as connection:
        connection.execute("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?", (iso_now(), iso_now(), user["id"]))
        connection.commit()
    return user


def login_user(user):
    session["user_id"] = user["id"]
    session.setdefault("csrf_token", secrets.token_urlsafe(32))


def logout_user():
    session.pop("user_id", None)


def load_current_user():
    if hasattr(g, "current_user"):
        return g.current_user
    g.current_user = get_user_by_id(session.get("user_id"))
    return g.current_user


def current_user():
    return getattr(g, "current_user", None) or load_current_user()


def user_permissions(user=None):
    active_user = user or current_user()
    if not active_user:
        return set()
    return set(ROLE_PERMISSIONS.get(active_user.get("role"), set()))


def has_permission(permission, user=None):
    return permission in user_permissions(user)


def user_can_access_client(client_code, user=None):
    active_user = user or current_user()
    if not active_user:
        return False
    if active_user.get("role") in {"admin", "manager"} and not active_user.get("client_codes"):
        return True
    scopes = {item.casefold() for item in active_user.get("client_codes", [])}
    if not scopes:
        return False
    return str(client_code or "").strip().casefold() in scopes


def filter_by_client_scope(items, key="client_code", user=None):
    active_user = user or current_user()
    if not active_user:
        return []
    if active_user.get("role") in {"admin", "manager"} and not active_user.get("client_codes"):
        return list(items or [])
    scopes = {item.casefold() for item in active_user.get("client_codes", [])}
    if not scopes:
        return []
    return [item for item in items or [] if str(item.get(key, "")).strip().casefold() in scopes]


def create_invitation(email, role, client_codes=None, operator_scope=None, invited_by=None, expires_hours=72, config=None):
    raw_token = secrets.token_urlsafe(32)
    now = utc_now()
    expires_at = now + timedelta(hours=expires_hours)
    with get_auth_connection(config) as connection:
        connection.execute(
            """
            INSERT INTO invitations (email, token_hash, role, client_codes, operator_scope, invited_by, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(email or "").strip().lower(),
                token_hash(raw_token),
                normalize_role(role),
                join_scope(client_codes),
                join_scope(operator_scope),
                invited_by,
                now.isoformat().replace("+00:00", "Z"),
                expires_at.isoformat().replace("+00:00", "Z"),
            ),
        )
        connection.commit()
    return raw_token


def get_invitation_by_token(token, config=None):
    with get_auth_connection(config) as connection:
        row = connection.execute("SELECT * FROM invitations WHERE token_hash = ?", (token_hash(token),)).fetchone()
        return row_to_invitation(row)


def get_invitation_by_id(invitation_id, config=None):
    try:
        normalized_id = int(invitation_id)
    except (TypeError, ValueError):
        return None
    with get_auth_connection(config) as connection:
        row = connection.execute("SELECT * FROM invitations WHERE id = ?", (normalized_id,)).fetchone()
        return row_to_invitation(row)


def mark_invitation_delivery(token, sent=False, error="", config=None):
    with get_auth_connection(config) as connection:
        connection.execute(
            "UPDATE invitations SET sent_at = ?, send_error = ? WHERE token_hash = ?",
            (iso_now() if sent else None, str(error or "")[:500], token_hash(token)),
        )
        connection.commit()


def revoke_invitation(invitation_id, config=None):
    now = iso_now()
    with get_auth_connection(config) as connection:
        connection.execute(
            "UPDATE invitations SET revoked_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL",
            (now, int(invitation_id)),
        )
        connection.commit()
    return get_invitation_by_id(invitation_id, config=config)


def invitation_is_usable(invitation):
    if not invitation or invitation.get("accepted_at") or invitation.get("revoked_at"):
        return False
    expires_at = parse_iso_datetime(invitation.get("expires_at"))
    return bool(expires_at and expires_at > utc_now())


def accept_invitation(token, name, password, config=None):
    invitation = get_invitation_by_token(token, config=config)
    if not invitation_is_usable(invitation):
        return None, "Invitation is invalid or expired."
    if get_user_by_email(invitation["email"], config=config):
        return None, "A user with this email already exists."
    user_id = create_user(
        email=invitation["email"],
        password=password,
        name=name,
        role=invitation["role"],
        client_codes=invitation["client_codes"],
        operator_scope=invitation["operator_scope"],
        status="active",
        config=config,
    )
    now = iso_now()
    with get_auth_connection(config) as connection:
        connection.execute(
            "UPDATE invitations SET accepted_at = ?, accepted_user_id = ? WHERE id = ?",
            (now, user_id, invitation["id"]),
        )
        connection.commit()
    return get_user_by_id(user_id, config=config), ""


def list_users(config=None):
    with get_auth_connection(config) as connection:
        rows = connection.execute("SELECT * FROM users ORDER BY created_at DESC").fetchall()
        return [row_to_user(row) for row in rows]


def list_invitations(config=None):
    with get_auth_connection(config) as connection:
        rows = connection.execute("SELECT * FROM invitations ORDER BY created_at DESC LIMIT 50").fetchall()
        return [row_to_invitation(row) for row in rows]


def role_home_endpoint(user=None):
    active_user = user or current_user()
    return ROLE_HOME.get(active_user.get("role") if active_user else "", "dashboard")


def build_invite_url(token):
    public_url = str(current_app.config.get("APP_PUBLIC_URL") or "").strip().rstrip("/")
    if public_url:
        return f"{public_url}{url_for('accept_invite', token=token)}"
    return url_for("accept_invite", token=token, _external=True)


def is_public_endpoint(endpoint):
    if not endpoint:
        return False
    return endpoint in {"login", "logout", "accept_invite", "static", "service_worker", "healthz"}


def is_fragment_or_json_request():
    return request.headers.get("X-Requested-With") == "XMLHttpRequest" or request.path.startswith("/api/")
