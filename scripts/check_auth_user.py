#!/usr/bin/env python3
import argparse
import os
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def main():
    parser = argparse.ArgumentParser(description="Inspect a TransferFlow auth user without printing password hashes.")
    parser.add_argument("--auth-url", required=True, help="Auth database URL, for example mysql://user:password@host:3306/db")
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", help="Optional password check. The password is not printed.")
    args = parser.parse_args()

    os.environ["AUTH_DATABASE_URL"] = args.auth_url

    from app import app
    from app.services.auth import authenticate_user, get_auth_connection, get_user_by_email

    config = app.config
    user = get_user_by_email(args.email, config=config)
    if not user:
        print("user: not found")
        return 1

    with get_auth_connection(config) as connection:
        columns = [row["name"] for row in connection.execute("PRAGMA table_info(users)").fetchall()]

    print(f"user: found id={user.get('id')} email={user.get('email')}")
    print(f"status: {user.get('status')}")
    print(f"role: {user.get('role')}")
    print(f"has_password_hash: {bool(str(user.get('password_hash') or '').strip())}")
    print(f"has_legacy_password: {bool(str(user.get('password') or '').strip())}")
    print(f"users_columns: {', '.join(columns)}")

    if args.password is not None:
        authenticated = authenticate_user(args.email, args.password, config=config)
        print(f"password_check: {'pass' if authenticated else 'fail'}")
        return 0 if authenticated else 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
