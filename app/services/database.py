import re
import sqlite3
from pathlib import Path
from urllib.parse import unquote, urlparse


class DatabaseConfigurationError(RuntimeError):
    pass


def is_mysql_url(value):
    return str(value or "").strip().lower().startswith(("mysql://", "mysql+pymysql://"))


def import_pymysql():
    try:
        import pymysql
        from pymysql.cursors import DictCursor
    except ModuleNotFoundError as exc:
        raise DatabaseConfigurationError("PyMySQL is required for MySQL. Install requirements.txt first.") from exc
    return pymysql, DictCursor


def parse_mysql_url(database_url):
    parsed = urlparse(str(database_url or "").strip())
    if not parsed.hostname or not parsed.path.strip("/"):
        raise DatabaseConfigurationError("MySQL URL must include host and database name.")
    return {
        "host": parsed.hostname,
        "port": parsed.port or 3306,
        "user": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
        "database": unquote(parsed.path.strip("/")),
        "charset": "utf8mb4",
        "autocommit": False,
    }


def translate_mysql_sql(sql):
    translated = str(sql)
    translated = translated.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "INT AUTO_INCREMENT PRIMARY KEY")
    translated = translated.replace("COLLATE NOCASE", "")
    translated = re.sub(
        r"\b(details)\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'[^']*'",
        r"\1 LONGTEXT NOT NULL",
        translated,
        flags=re.IGNORECASE,
    )
    translated = re.sub(
        r"\b(note|user_agent)\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+''",
        r"\1 TEXT NOT NULL",
        translated,
        flags=re.IGNORECASE,
    )
    translated = re.sub(
        r"\b([A-Za-z_][A-Za-z0-9_]*)\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'([^']*)'",
        r"\1 VARCHAR(500) NOT NULL DEFAULT '\2'",
        translated,
        flags=re.IGNORECASE,
    )
    translated = re.sub(
        r"\b(email|token_hash)\s+TEXT\s+NOT\s+NULL",
        r"\1 VARCHAR(255) NOT NULL",
        translated,
        flags=re.IGNORECASE,
    )
    translated = re.sub(
        r"\b(password_hash)\s+TEXT\s+NOT\s+NULL",
        r"\1 VARCHAR(255) NOT NULL",
        translated,
        flags=re.IGNORECASE,
    )
    translated = re.sub(
        r"\b(role|status|action|target_type|target_id|target_label|ip_address|source_type|source_name|category|asset_name|asset_tag|assigned_to|location|borrower_name|reference|payment_date|commission_date|purchase_date|issued_date|due_date|created_at|updated_at|last_login_at|expires_at|accepted_at|revoked_at|sent_at|paid_at)\s+TEXT",
        r"\1 VARCHAR(500)",
        translated,
        flags=re.IGNORECASE,
    )
    translated = translated.replace(" REAL ", " DOUBLE ")
    translated = translated.replace(" REAL\n", " DOUBLE\n")
    translated = translated.replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX")
    translated = translated.replace("?", "%s")
    return translated


class ManagedConnection:
    def __init__(self, connection, backend):
        self.connection = connection
        self.backend = backend

    def __enter__(self):
        return self

    def __exit__(self, exc_type, _exc, _tb):
        if exc_type:
            self.connection.rollback()
        self.connection.close()
        return False

    def execute(self, sql, params=()):
        if self.backend == "mysql":
            return self._execute_mysql(sql, params)
        return self.connection.execute(sql, params)

    def executemany(self, sql, params=()):
        if self.backend == "mysql":
            with self.connection.cursor() as cursor:
                cursor.executemany(translate_mysql_sql(sql), params)
                return cursor
        return self.connection.executemany(sql, params)

    def commit(self):
        self.connection.commit()

    def rollback(self):
        self.connection.rollback()

    def _execute_mysql(self, sql, params=()):
        text = str(sql).strip()
        pragma_match = re.match(r"PRAGMA\s+table_info\(([^)]+)\)", text, flags=re.IGNORECASE)
        if pragma_match:
            table_name = pragma_match.group(1).strip("`\"'")
            with self.connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT COLUMN_NAME AS name
                    FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
                    ORDER BY ORDINAL_POSITION
                    """,
                    (table_name,),
                )
                return BufferedCursor(cursor.fetchall())

        translated = translate_mysql_sql(text)
        with self.connection.cursor() as cursor:
            try:
                cursor.execute(translated, params)
            except Exception as exc:
                error_code = getattr(exc, "args", [""])[0]
                if "CREATE INDEX IF NOT EXISTS" in text.upper() and (error_code == 1061 or "duplicate" in str(exc).lower() or "already exists" in str(exc).lower()):
                    return BufferedCursor([])
                raise
            return BufferedCursor.from_cursor(cursor)


class BufferedCursor:
    def __init__(self, rows=None, lastrowid=None, rowcount=0):
        self.rows = list(rows or [])
        self.lastrowid = lastrowid
        self.rowcount = rowcount

    @classmethod
    def from_cursor(cls, cursor):
        rows = []
        if cursor.description:
            rows = cursor.fetchall()
        return cls(rows=rows, lastrowid=cursor.lastrowid, rowcount=cursor.rowcount)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


def open_database(database_url="", sqlite_path=""):
    if is_mysql_url(database_url):
        pymysql, dict_cursor = import_pymysql()
        connection = pymysql.connect(cursorclass=dict_cursor, **parse_mysql_url(database_url))
        return ManagedConnection(connection, "mysql")

    db_path = Path(sqlite_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    return ManagedConnection(connection, "sqlite")
