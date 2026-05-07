#!/usr/bin/env python3
import argparse
import os
import sqlite3
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse


TABLES = [
    "users",
    "invitations",
    "audit_logs",
    "expenses",
    "commissions",
    "office_assets",
    "loans",
]


def parse_mysql_url(database_url):
    parsed = urlparse(str(database_url or "").strip())
    if not parsed.hostname or not parsed.path.strip("/"):
        raise ValueError("MySQL URL must look like mysql://user:password@host:3306/database")
    return {
        "host": parsed.hostname,
        "port": parsed.port or 3306,
        "user": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
        "database": unquote(parsed.path.strip("/")),
        "charset": "utf8mb4",
        "autocommit": False,
    }


def sqlite_rows(path, table):
    if not path.exists():
        return []
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        exists = connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", (table,)).fetchone()
        if not exists:
            return []
        rows = connection.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
        return [dict(row) for row in rows]


def mysql_columns(connection, table):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
            ORDER BY ORDINAL_POSITION
            """,
            (table,),
        )
        return [row["COLUMN_NAME"] for row in cursor.fetchall()]


def insert_rows(connection, table, rows):
    if not rows:
        return 0
    target_columns = mysql_columns(connection, table)
    columns = [column for column in target_columns if column in rows[0]]
    if not columns:
        return 0
    placeholders = ", ".join(["%s"] * len(columns))
    column_sql = ", ".join(f"`{column}`" for column in columns)
    update_sql = ", ".join(f"`{column}` = VALUES(`{column}`)" for column in columns if column != "id")
    sql = f"INSERT INTO `{table}` ({column_sql}) VALUES ({placeholders})"
    if update_sql:
        sql += f" ON DUPLICATE KEY UPDATE {update_sql}"
    values = [tuple(row.get(column) for column in columns) for row in rows]
    with connection.cursor() as cursor:
        cursor.executemany(sql, values)
    return len(values)


def source_for_table(table, auth_path, operations_path):
    return auth_path if table in {"users", "invitations", "audit_logs"} else operations_path


def main():
    parser = argparse.ArgumentParser(description="Safely copy TransferFlow SQLite auth/operations data into MySQL.")
    parser.add_argument("--mysql-url", required=True, help="Example: mysql://user:password@127.0.0.1:3306/transferflow")
    parser.add_argument("--auth-sqlite", default="instance/auth.db")
    parser.add_argument("--operations-sqlite", default="instance/operations.db")
    parser.add_argument("--apply", action="store_true", help="Actually write rows. Without this flag, only a dry-run summary is printed.")
    args = parser.parse_args()

    mysql_url = args.mysql_url
    auth_path = Path(args.auth_sqlite)
    operations_path = Path(args.operations_sqlite)

    print("TransferFlow SQLite -> MySQL migration")
    print(f"Auth SQLite: {auth_path}")
    print(f"Operations SQLite: {operations_path}")
    print(f"Mode: {'APPLY' if args.apply else 'DRY RUN'}")

    if not args.apply:
        for table in TABLES:
            rows = sqlite_rows(source_for_table(table, auth_path, operations_path), table)
            print(f"{table}: {len(rows)} rows ready")
        print("Dry run complete. Re-run with --apply to initialize MySQL schema and copy rows.")
        return 0

    try:
        import pymysql
        from pymysql.cursors import DictCursor
    except ModuleNotFoundError:
        print("PyMySQL is not installed. Run: ./.venv/bin/pip install -r requirements.txt", file=sys.stderr)
        return 2

    os.environ["AUTH_DATABASE_URL"] = mysql_url
    os.environ["OPERATIONS_DATABASE_URL"] = mysql_url
    from app import app
    from app.services.auth import init_auth_storage
    from app.services.operations import init_operations_storage

    init_auth_storage(app)
    init_operations_storage(app)

    connection = pymysql.connect(cursorclass=DictCursor, **parse_mysql_url(mysql_url))
    try:
        for table in TABLES:
            rows = sqlite_rows(source_for_table(table, auth_path, operations_path), table)
            copied = insert_rows(connection, table, rows)
            print(f"{table}: copied {copied} rows")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

    print("Migration complete. Set AUTH_DATABASE_URL and OPERATIONS_DATABASE_URL in production, then restart the app.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
