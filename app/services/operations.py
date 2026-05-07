from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import current_app

from app.services.database import open_database


EXPENSE_CATEGORIES = [
    "Salary",
    "Dividend",
    "Electricity",
    "Stationery",
    "Cash Transfer",
    "Office Maintenance",
    "Rent",
    "Equipment Servicing",
    "Internet",
    "Miscellaneous",
]

MOBILE_COMMISSION_SOURCES = ["Vodacom", "Yas", "Halotel", "Airtel"]
BANK_COMMISSION_SOURCES = ["NMB", "NBC", "CRDB", "TCB", "MUCCOBA"]
ASSET_STATUSES = ["active", "servicing", "retired", "lost"]
LOAN_STATUSES = ["active", "paid"]


def iso_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def get_operations_db_path(config=None):
    runtime_config = config or current_app.config
    configured_path = str(runtime_config.get("OPERATIONS_DATABASE_PATH") or "").strip()
    if configured_path:
        return Path(configured_path)
    return Path(current_app.instance_path) / "operations.db"


def get_operations_connection(config=None):
    runtime_config = config or current_app.config
    return open_database(
        database_url=runtime_config.get("OPERATIONS_DATABASE_URL", ""),
        sqlite_path=get_operations_db_path(runtime_config),
    )


def init_operations_storage(app):
    if not str(app.config.get("OPERATIONS_DATABASE_PATH") or "").strip():
        app.config["OPERATIONS_DATABASE_PATH"] = str(Path(app.instance_path) / "operations.db")
    with get_operations_connection(app.config) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category TEXT NOT NULL,
                amount REAL NOT NULL DEFAULT 0,
                paid_to TEXT NOT NULL DEFAULT '',
                payment_date TEXT NOT NULL,
                reference TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                created_by INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS commissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_type TEXT NOT NULL,
                source_name TEXT NOT NULL,
                amount REAL NOT NULL DEFAULT 0,
                commission_date TEXT NOT NULL,
                reference TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                created_by INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS office_assets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset_name TEXT NOT NULL,
                asset_tag TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT '',
                purchase_date TEXT NOT NULL DEFAULT '',
                purchase_value REAL NOT NULL DEFAULT 0,
                assigned_to TEXT NOT NULL DEFAULT '',
                location TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active',
                note TEXT NOT NULL DEFAULT '',
                created_by INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS loans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                borrower_name TEXT NOT NULL,
                amount REAL NOT NULL DEFAULT 0,
                issued_date TEXT NOT NULL,
                due_date TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active',
                paid_at TEXT,
                reference TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                created_by INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.commit()


def parse_amount(value):
    try:
        parsed = float(str(value or "0").replace(",", "").strip())
    except (TypeError, ValueError):
        parsed = 0.0
    return max(0.0, parsed)


def clean_choice(value, allowed, fallback):
    text = str(value or "").strip()
    allowed_lookup = {item.casefold(): item for item in allowed}
    return allowed_lookup.get(text.casefold(), fallback)


def date_plus_days(date_text, days):
    try:
        base_date = datetime.fromisoformat(str(date_text or "").strip()).date()
    except ValueError:
        base_date = datetime.now(timezone.utc).date()
    return (base_date + timedelta(days=days)).isoformat()


def row_to_dict(row):
    return dict(row) if row is not None else None


def clean_filters(args=None):
    args = args or {}
    return {
        "q": str(args.get("q", "") or "").strip(),
        "date_from": str(args.get("date_from", "") or "").strip(),
        "date_to": str(args.get("date_to", "") or "").strip(),
        "expense_category": str(args.get("expense_category", "") or "").strip(),
        "commission_type": str(args.get("commission_type", "") or "").strip(),
        "commission_source": str(args.get("commission_source", "") or "").strip(),
        "asset_status": str(args.get("asset_status", "") or "").strip(),
        "loan_status": str(args.get("loan_status", "") or "").strip(),
    }


def in_date_range(value, filters):
    text = str(value or "").strip()[:10]
    if not text:
        return True
    if filters.get("date_from") and text < filters["date_from"]:
        return False
    if filters.get("date_to") and text > filters["date_to"]:
        return False
    return True


def row_matches_search(row, query):
    if not query:
        return True
    haystack = " ".join(str(value or "") for value in row.values()).casefold()
    return query.casefold() in haystack


def apply_operations_filters(expenses, commissions, assets, loans, filters=None):
    active_filters = clean_filters(filters)
    query = active_filters["q"]

    filtered_expenses = [
        row for row in expenses
        if row_matches_search(row, query)
        and in_date_range(row.get("payment_date"), active_filters)
        and (not active_filters["expense_category"] or row.get("category") == active_filters["expense_category"])
    ]
    filtered_commissions = [
        row for row in commissions
        if row_matches_search(row, query)
        and in_date_range(row.get("commission_date"), active_filters)
        and (not active_filters["commission_type"] or row.get("source_type") == active_filters["commission_type"])
        and (not active_filters["commission_source"] or row.get("source_name") == active_filters["commission_source"])
    ]
    filtered_assets = [
        row for row in assets
        if row_matches_search(row, query)
        and in_date_range(row.get("purchase_date"), active_filters)
        and (not active_filters["asset_status"] or row.get("status") == active_filters["asset_status"])
    ]
    filtered_loans = [
        row for row in loans
        if row_matches_search(row, query)
        and in_date_range(row.get("issued_date"), active_filters)
        and (not active_filters["loan_status"] or row.get("status") == active_filters["loan_status"])
    ]
    return filtered_expenses, filtered_commissions, filtered_assets, filtered_loans


def list_rows(table, config=None, limit=100):
    with get_operations_connection(config) as connection:
        rows = connection.execute(f"SELECT * FROM {table} ORDER BY created_at DESC LIMIT ?", (int(limit),)).fetchall()
        return [row_to_dict(row) for row in rows]


def create_expense(data, user_id=None, config=None):
    now = iso_now()
    with get_operations_connection(config) as connection:
        connection.execute(
            """
            INSERT INTO expenses (category, amount, paid_to, payment_date, reference, note, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                clean_choice(data.get("category"), EXPENSE_CATEGORIES, "Miscellaneous"),
                parse_amount(data.get("amount")),
                str(data.get("paid_to") or "").strip(),
                str(data.get("payment_date") or now[:10]).strip(),
                str(data.get("reference") or "").strip(),
                str(data.get("note") or "").strip(),
                user_id,
                now,
                now,
            ),
        )
        connection.commit()


def create_commission(data, user_id=None, config=None):
    now = iso_now()
    source_type = "bank" if str(data.get("source_type") or "").strip().lower() == "bank" else "mobile"
    allowed_sources = BANK_COMMISSION_SOURCES if source_type == "bank" else MOBILE_COMMISSION_SOURCES
    with get_operations_connection(config) as connection:
        connection.execute(
            """
            INSERT INTO commissions (source_type, source_name, amount, commission_date, reference, note, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source_type,
                clean_choice(data.get("source_name"), allowed_sources, allowed_sources[0]),
                parse_amount(data.get("amount")),
                str(data.get("commission_date") or now[:10]).strip(),
                str(data.get("reference") or "").strip(),
                str(data.get("note") or "").strip(),
                user_id,
                now,
                now,
            ),
        )
        connection.commit()


def create_asset(data, user_id=None, config=None):
    now = iso_now()
    with get_operations_connection(config) as connection:
        connection.execute(
            """
            INSERT INTO office_assets (
                asset_name, asset_tag, category, purchase_date, purchase_value, assigned_to,
                location, status, note, created_by, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(data.get("asset_name") or "").strip(),
                str(data.get("asset_tag") or "").strip(),
                str(data.get("category") or "").strip(),
                str(data.get("purchase_date") or now[:10]).strip(),
                parse_amount(data.get("purchase_value")),
                str(data.get("assigned_to") or "").strip(),
                str(data.get("location") or "").strip(),
                clean_choice(data.get("status"), ASSET_STATUSES, "active"),
                str(data.get("note") or "").strip(),
                user_id,
                now,
                now,
            ),
        )
        connection.commit()


def update_asset_status(asset_id, status, config=None):
    now = iso_now()
    with get_operations_connection(config) as connection:
        connection.execute(
            "UPDATE office_assets SET status = ?, updated_at = ? WHERE id = ?",
            (clean_choice(status, ASSET_STATUSES, "active"), now, int(asset_id)),
        )
        connection.commit()


def create_loan(data, user_id=None, config=None):
    now = iso_now()
    issued_date = str(data.get("issued_date") or now[:10]).strip()
    due_date = str(data.get("due_date") or date_plus_days(issued_date, 7)).strip()
    with get_operations_connection(config) as connection:
        connection.execute(
            """
            INSERT INTO loans (borrower_name, amount, issued_date, due_date, status, reference, note, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
            """,
            (
                str(data.get("borrower_name") or "").strip(),
                parse_amount(data.get("amount")),
                issued_date,
                due_date,
                str(data.get("reference") or "").strip(),
                str(data.get("note") or "").strip(),
                user_id,
                now,
                now,
            ),
        )
        connection.commit()


def mark_loan_paid(loan_id, config=None):
    now = iso_now()
    with get_operations_connection(config) as connection:
        connection.execute(
            "UPDATE loans SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?",
            (now, now, int(loan_id)),
        )
        connection.commit()


def sum_amount(rows):
    return sum(float(row.get("amount") or row.get("purchase_value") or 0) for row in rows or [])


def build_operations_view_model(config=None, filters=None):
    expenses = list_rows("expenses", config=config)
    commissions = list_rows("commissions", config=config)
    assets = list_rows("office_assets", config=config)
    loans = list_rows("loans", config=config)
    active_filters = clean_filters(filters)
    expenses, commissions, assets, loans = apply_operations_filters(expenses, commissions, assets, loans, active_filters)
    active_loans = [loan for loan in loans if loan.get("status") == "active"]
    active_assets = [asset for asset in assets if asset.get("status") == "active"]
    return {
        "expenses": expenses,
        "commissions": commissions,
        "assets": assets,
        "loans": loans,
        "summary": {
            "expenses_total": sum_amount(expenses),
            "commissions_total": sum_amount(commissions),
            "assets_total": sum_amount(active_assets),
            "active_loans_total": sum_amount(active_loans),
            "active_loans_count": len(active_loans),
            "assets_count": len(assets),
        },
        "expense_categories": EXPENSE_CATEGORIES,
        "mobile_sources": MOBILE_COMMISSION_SOURCES,
        "bank_sources": BANK_COMMISSION_SOURCES,
        "asset_statuses": ASSET_STATUSES,
        "loan_statuses": LOAN_STATUSES,
        "filters": active_filters,
    }
