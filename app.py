import os
import sqlite3
import json
import csv
import io
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from urllib.error import HTTPError, URLError
from urllib.request import urlopen
from zoneinfo import ZoneInfo

from flask import Flask, Response, g, redirect, render_template, request, url_for

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    def load_dotenv(path=".env"):
        if not os.path.exists(path):
            return False
        with open(path, "r", encoding="utf-8") as env_file:
            for raw_line in env_file:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
        return True


load_dotenv()

app = Flask(__name__)
api_base_url = os.getenv("API_BASE_URL", "https://southerntechnologies.tech/api").strip()
if api_base_url.startswith("http://southerntechnologies.tech"):
    api_base_url = "https://" + api_base_url[len("http://") :]
app.config["API_BASE_URL"] = api_base_url
app.config["APP_TIMEZONE"] = os.getenv("APP_TIMEZONE", "Africa/Dar_es_Salaam")
app.config["DATABASE"] = os.path.join(app.instance_path, "transferflow.db")
app.secret_key = os.getenv("FLASK_SECRET_KEY", "transferflow-dev-key")

TRANSACTION_CACHE_TTL_SECONDS = 20
TRANSACTION_CACHE = {"fetched_at": 0.0, "items": [], "last_error": "", "source": "none"}


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_error):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(app.config["DATABASE"])
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS sender_configurations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_number TEXT NOT NULL UNIQUE,
            client_code TEXT NOT NULL,
            til_number TEXT NOT NULL,
            til_name TEXT,
            path TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    existing_rows = db.execute("SELECT COUNT(*) FROM sender_configurations").fetchone()[0]
    if existing_rows == 0:
        db.executemany(
            """
            INSERT INTO sender_configurations
            (sender_number, client_code, til_number, til_name, path, is_active)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                ("0716904482", "client2", "314470", "-", "*150*01#,3,receivernumber,amount,PIN", 1),
                ("0753901881", "client2", "8011022", "-", "*150*00#,1,receivernumber,amount,HUS,PIN", 1),
                ("0760763383", "client1", "787625", "-", "*150*00#,1,receivernumber,amount,VAN,PIN", 1),
                ("0695235537", "client1", "1154214", "-", "*150*60#,1,1,receivernumber,amount,PIN", 1),
            ],
        )
    db.commit()
    db.close()


def fetch_sender_configurations(active_only=False):
    db = get_db()
    sql = """
        SELECT id, sender_number, client_code, til_number, til_name, path, is_active
        FROM sender_configurations
    """
    params = []
    if active_only:
        sql += " WHERE is_active = ?"
        params.append(1)
    sql += " ORDER BY id DESC"
    rows = db.execute(sql, params).fetchall()
    return rows


def format_amount(value):
    try:
        amount = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError, AttributeError):
        return "-"
    return f"{amount:,.2f}"


def parse_amount_value(value):
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError, AttributeError):
        return None


def format_currency_amount(amount, currency="TZS"):
    try:
        numeric = float(amount)
    except (TypeError, ValueError):
        numeric = 0.0
    return f"{currency} {numeric:,.2f}"


def get_app_timezone():
    tz_name = app.config.get("APP_TIMEZONE", "UTC")
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return timezone.utc


def parse_timestamp(value):
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def format_timestamp(value):
    if not value:
        return "-"
    text = str(value).strip()
    if not text:
        return "-"

    parsed = parse_timestamp(text)
    if parsed is None:
        return text

    return parsed.astimezone(get_app_timezone()).strftime("%d %b %Y, %I:%M %p")


def paginate_transactions(items, page, per_page):
    total = len(items)
    if total == 0:
        return [], {
            "page": 1,
            "per_page": per_page,
            "total": 0,
            "total_pages": 0,
            "has_prev": False,
            "has_next": False,
            "prev_page": 1,
            "next_page": 1,
            "start_row": 0,
            "end_row": 0,
        }

    total_pages = (total + per_page - 1) // per_page
    current_page = max(1, min(page, total_pages))
    start_index = (current_page - 1) * per_page
    end_index = start_index + per_page
    page_items = items[start_index:end_index]
    start_row = start_index + 1
    end_row = start_index + len(page_items)

    return page_items, {
        "page": current_page,
        "per_page": per_page,
        "total": total,
        "total_pages": total_pages,
        "has_prev": current_page > 1,
        "has_next": current_page < total_pages,
        "prev_page": current_page - 1,
        "next_page": current_page + 1,
        "start_row": start_row,
        "end_row": end_row,
    }


def apply_transaction_filters(transactions, search_query="", operator_filter="", operation_filter=""):
    search_term = (search_query or "").strip().lower()
    operator_term = (operator_filter or "").strip().lower()
    operation_term = (operation_filter or "").strip().lower()

    filtered = []
    for transaction in transactions:
        operator_value = str(transaction.get("operator", "")).strip()
        operation_value = str(transaction.get("operation", "")).strip()

        if operator_term and operator_value.lower() != operator_term:
            continue
        if operation_term and operation_value.lower() != operation_term:
            continue

        if search_term:
            searchable_parts = [
                transaction.get("sender_number", ""),
                transaction.get("receiver_number", ""),
                transaction.get("operator", ""),
                transaction.get("operation", ""),
                transaction.get("amount", ""),
                transaction.get("created_by", ""),
                transaction.get("created_at", ""),
            ]
            haystack = " ".join(str(part) for part in searchable_parts).lower()
            if search_term not in haystack:
                continue

        filtered.append(transaction)

    return filtered


def normalize_period(value):
    normalized = (value or "today").strip().lower()
    return normalized if normalized in {"today", "all"} else "today"


def normalize_per_page(value):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 15
    return parsed if parsed in {15, 30, 50} else 15


def normalize_sort(sort_by, sort_dir):
    normalized_by = (sort_by or "date").strip().lower()
    if normalized_by not in {"date", "amount", "operator"}:
        normalized_by = "date"

    normalized_dir = (sort_dir or "").strip().lower()
    if normalized_dir not in {"asc", "desc"}:
        normalized_dir = "desc" if normalized_by in {"date", "amount"} else "asc"

    return normalized_by, normalized_dir


def sort_transactions(transactions, sort_by, sort_dir):
    normalized_by, normalized_dir = normalize_sort(sort_by, sort_dir)
    reverse = normalized_dir == "desc"

    if normalized_by == "amount":
        key_fn = lambda tx: tx.get("amount_value") if tx.get("amount_value") is not None else -1.0
    elif normalized_by == "operator":
        key_fn = lambda tx: str(tx.get("operator", "")).strip().lower()
    else:
        key_fn = lambda tx: tx.get("created_at_sort", 0.0)

    return sorted(transactions, key=key_fn, reverse=reverse), normalized_by, normalized_dir


def format_cache_timestamp(timestamp_value):
    if not timestamp_value:
        return "-"
    try:
        parsed = datetime.fromtimestamp(float(timestamp_value), tz=get_app_timezone())
    except (TypeError, ValueError, OSError):
        return "-"
    return parsed.strftime("%d %b %Y, %I:%M:%S %p")


def build_trend_window(transactions, days):
    tz = get_app_timezone()
    today = datetime.now(tz).date()
    start_date = today - timedelta(days=days - 1)
    day_keys = [(start_date + timedelta(days=offset)).isoformat() for offset in range(days)]
    sent_operations = {"transfer", "sent"}
    received_operations = {"received", "receive"}

    buckets = {
        key: {
            "date": datetime.fromisoformat(key).date(),
            "sent": 0.0,
            "received": 0.0,
        }
        for key in day_keys
    }

    for tx in transactions:
        day_key = tx.get("created_at_date")
        if day_key not in buckets:
            continue
        amount = tx.get("amount_value") or 0.0
        operation_value = str(tx.get("operation", "")).strip().lower()
        if operation_value in sent_operations:
            buckets[day_key]["sent"] += amount
        elif operation_value in received_operations:
            buckets[day_key]["received"] += amount

    max_value = 1.0
    for bucket in buckets.values():
        max_value = max(max_value, bucket["sent"], bucket["received"])

    points = []
    sent_total = 0.0
    received_total = 0.0
    for key in day_keys:
        bucket = buckets[key]
        sent_value = bucket["sent"]
        received_value = bucket["received"]
        sent_total += sent_value
        received_total += received_value
        points.append(
            {
                "label": bucket["date"].strftime("%d %b"),
                "sent": sent_value,
                "received": received_value,
                "sent_label": format_currency_amount(sent_value),
                "received_label": format_currency_amount(received_value),
                "sent_pct": round((sent_value / max_value) * 100, 2),
                "received_pct": round((received_value / max_value) * 100, 2),
            }
        )

    return {
        "points": points,
        "sent_total": format_currency_amount(sent_total),
        "received_total": format_currency_amount(received_total),
    }


def fetch_transactions(page=1, page_size=15):
    query = urlencode({"page": page, "pageSize": page_size})
    endpoint = f"{app.config['API_BASE_URL'].rstrip('/')}/transactions?{query}"
    try:
        with urlopen(endpoint, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
        return [], {
            "page": page,
            "per_page": page_size,
            "total": 0,
            "total_pages": 0,
            "has_prev": False,
            "has_next": False,
            "prev_page": 1,
            "next_page": 1,
            "start_row": 0,
            "end_row": 0,
        }

    if isinstance(payload, dict):
        records = payload.get("data", [])
        try:
            total = int(payload.get("total", len(records)))
        except (TypeError, ValueError):
            total = len(records)
        try:
            current_page = int(payload.get("page", page))
        except (TypeError, ValueError):
            current_page = page
        try:
            response_page_size = int(payload.get("pageSize", page_size))
        except (TypeError, ValueError):
            response_page_size = page_size
        try:
            total_pages = int(payload.get("totalPages", 0))
        except (TypeError, ValueError):
            total_pages = 0
    else:
        records = payload if isinstance(payload, list) else []
        total = len(records)
        current_page = page
        response_page_size = page_size
        total_pages = 1 if total > 0 else 0

    if not isinstance(records, list):
        records = []
        total = 0
        total_pages = 0

    transactions = []
    for item in records:
        if not isinstance(item, dict):
            continue
        amount_value = parse_amount_value(item.get("amount"))
        currency = (item.get("currency") or "TZS").strip()
        amount_label = "-" if amount_value is None else format_currency_amount(amount_value, currency)
        created_value = item.get("created_date") or item.get("created_at")
        created_dt = parse_timestamp(created_value)

        transactions.append(
            {
                "id": item.get("id", "-"),
                "sender_number": item.get("normalizedPhone") or "-",
                "receiver_number": item.get("receiverPhone") or "-",
                "operator": item.get("operator") or "-",
                "operation": item.get("operation") or "-",
                "amount": amount_label,
                "amount_value": amount_value,
                "status": (item.get("status") or "UNKNOWN").upper(),
                "created_by": item.get("created_by") or "-",
                "created_at": format_timestamp(created_value),
                "created_at_date": created_dt.astimezone(get_app_timezone()).date().isoformat() if created_dt else "",
                "created_at_sort": created_dt.timestamp() if created_dt else 0.0,
            }
        )

    if total_pages == 0 and total > 0 and response_page_size > 0:
        total_pages = (total + response_page_size - 1) // response_page_size

    if total > 0 and response_page_size > 0:
        start_row = (current_page - 1) * response_page_size + 1
        end_row = start_row + len(transactions) - 1
    else:
        start_row = 0
        end_row = 0

    return transactions, {
        "page": current_page,
        "per_page": response_page_size,
        "total": total,
        "total_pages": total_pages,
        "has_prev": current_page > 1,
        "has_next": total_pages > 0 and current_page < total_pages,
        "prev_page": current_page - 1,
        "next_page": current_page + 1,
        "start_row": start_row,
        "end_row": end_row,
    }


def fetch_all_transactions(page_size=100, max_pages=200, force_refresh=False):
    now = time.time()
    cache_is_fresh = (
        bool(TRANSACTION_CACHE["items"])
        and (now - TRANSACTION_CACHE["fetched_at"]) < TRANSACTION_CACHE_TTL_SECONDS
    )
    if cache_is_fresh and not force_refresh:
        return list(TRANSACTION_CACHE["items"]), {
            "source": "cache",
            "used_stale": False,
            "last_updated": TRANSACTION_CACHE["fetched_at"],
            "error": "",
        }

    page = 1
    all_transactions = []
    fetch_error = ""
    fetch_completed = False

    while page <= max_pages:
        page_transactions, pagination = fetch_transactions(page=page, page_size=page_size)
        if not page_transactions and page == 1 and pagination.get("total", 0) == 0:
            fetch_error = "Unable to load live transaction data right now."
            break
        if not page_transactions and page > 1:
            fetch_error = "Transaction API returned an incomplete response."
            break

        all_transactions.extend(page_transactions)
        total_pages = pagination.get("total_pages", 0)
        if total_pages == 0:
            fetch_completed = True
            break
        if page >= total_pages:
            fetch_completed = True
            break

        page += 1

    if all_transactions and fetch_completed and not fetch_error:
        TRANSACTION_CACHE["items"] = list(all_transactions)
        TRANSACTION_CACHE["fetched_at"] = time.time()
        TRANSACTION_CACHE["last_error"] = ""
        TRANSACTION_CACHE["source"] = "live"
        return all_transactions, {
            "source": "live",
            "used_stale": False,
            "last_updated": TRANSACTION_CACHE["fetched_at"],
            "error": "",
        }

    if TRANSACTION_CACHE["items"]:
        if fetch_error:
            TRANSACTION_CACHE["last_error"] = fetch_error
        TRANSACTION_CACHE["source"] = "stale_cache"
        return list(TRANSACTION_CACHE["items"]), {
            "source": "cache",
            "used_stale": True,
            "last_updated": TRANSACTION_CACHE["fetched_at"],
            "error": fetch_error or TRANSACTION_CACHE.get("last_error", ""),
        }

    return all_transactions, {
        "source": "error",
        "used_stale": False,
        "last_updated": 0.0,
        "error": fetch_error or "No transaction data is currently available.",
    }


def build_dashboard_data(
    period,
    search_query="",
    operator_filter="",
    operation_filter="",
    sort_by="date",
    sort_dir="desc",
    page=1,
    per_page=15,
    force_refresh=False,
):
    normalized_period = normalize_period(period)
    rows_per_page = normalize_per_page(per_page)
    current_page = page if isinstance(page, int) and page > 0 else 1

    all_transactions, fetch_meta = fetch_all_transactions(page_size=100, force_refresh=force_refresh)
    today_str = datetime.now(get_app_timezone()).date().isoformat()

    if normalized_period == "all":
        scoped_transactions = all_transactions
    else:
        scoped_transactions = [tx for tx in all_transactions if tx.get("created_at_date") == today_str]

    sent_operations = {"transfer", "sent"}
    received_operations = {"received", "receive"}
    sent_transactions = [
        tx for tx in scoped_transactions if str(tx.get("operation", "")).strip().lower() in sent_operations
    ]
    received_transactions = [
        tx for tx in scoped_transactions if str(tx.get("operation", "")).strip().lower() in received_operations
    ]

    total_volume = sum(tx.get("amount_value") or 0.0 for tx in scoped_transactions)
    sent_volume = sum(tx.get("amount_value") or 0.0 for tx in sent_transactions)
    received_volume = sum(tx.get("amount_value") or 0.0 for tx in received_transactions)
    period_suffix = "ALL TIME" if normalized_period == "all" else "TODAY"

    operator_options = sorted(
        {tx.get("operator", "").strip() for tx in scoped_transactions if tx.get("operator") and tx.get("operator") != "-"},
        key=str.casefold,
    )
    operation_options = sorted(
        {tx.get("operation", "").strip() for tx in scoped_transactions if tx.get("operation") and tx.get("operation") != "-"},
        key=str.casefold,
    )

    cleaned_search = (search_query or "").strip()
    cleaned_operator = (operator_filter or "").strip()
    cleaned_operation = (operation_filter or "").strip()

    if cleaned_operator and cleaned_operator not in operator_options:
        cleaned_operator = ""
    if cleaned_operation and cleaned_operation not in operation_options:
        cleaned_operation = ""

    filtered_transactions = apply_transaction_filters(
        scoped_transactions,
        search_query=cleaned_search,
        operator_filter=cleaned_operator,
        operation_filter=cleaned_operation,
    )
    sorted_transactions, normalized_sort_by, normalized_sort_dir = sort_transactions(
        filtered_transactions,
        sort_by=sort_by,
        sort_dir=sort_dir,
    )
    paged_transactions, pagination = paginate_transactions(
        sorted_transactions,
        page=current_page,
        per_page=rows_per_page,
    )

    if fetch_meta["source"] == "live":
        status_level = "success"
        status_title = "Data Synced"
        status_message = "Live transaction data is up to date."
    elif fetch_meta["source"] == "cache" and fetch_meta["used_stale"]:
        status_level = "warning"
        status_title = "Using Cached Data"
        status_message = fetch_meta["error"] or "Live API temporarily unavailable. Showing latest cached data."
    elif fetch_meta["source"] == "cache":
        status_level = "info"
        status_title = "Using Cached Snapshot"
        status_message = "Showing a recently cached transaction snapshot."
    else:
        status_level = "error"
        status_title = "Data Unavailable"
        status_message = fetch_meta["error"] or "Unable to load transactions."

    trend_7 = build_trend_window(all_transactions, 7)
    trend_30 = build_trend_window(all_transactions, 30)

    return {
        "period": normalized_period,
        "per_page": rows_per_page,
        "per_page_options": [15, 30, 50],
        "filters": {
            "q": cleaned_search,
            "operator": cleaned_operator,
            "operation": cleaned_operation,
        },
        "operator_options": operator_options,
        "operation_options": operation_options,
        "transactions": paged_transactions,
        "filtered_transactions": sorted_transactions,
        "pagination": pagination,
        "sort": {"by": normalized_sort_by, "dir": normalized_sort_dir},
        "trend": {"7": trend_7, "30": trend_30},
        "data_status": {
            "level": status_level,
            "title": status_title,
            "message": status_message,
            "last_updated": format_cache_timestamp(fetch_meta.get("last_updated")),
            "can_retry": True,
        },
        "stats": {
            "total_label": f"TOTAL VOLUME {period_suffix}",
            "sent_label": f"SENT {period_suffix}",
            "received_label": f"RECEIVED {period_suffix}",
            "total_volume": format_currency_amount(total_volume),
            "total_transactions": len(scoped_transactions),
            "sent_amount": format_currency_amount(sent_volume),
            "received_amount": format_currency_amount(received_volume),
            "outgoing_transfers": len(sent_transactions),
            "incoming_transfers": len(received_transactions),
        },
    }


def escape_pdf_text(value):
    return str(value).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build_simple_pdf(lines):
    normalized_lines = []
    max_chars = 110
    for raw_line in lines:
        text = str(raw_line)
        if not text:
            normalized_lines.append("")
            continue
        while len(text) > max_chars:
            normalized_lines.append(text[:max_chars])
            text = text[max_chars:]
        normalized_lines.append(text)

    if not normalized_lines:
        normalized_lines = ["No transactions found."]

    lines_per_page = 52
    pages = [normalized_lines[i : i + lines_per_page] for i in range(0, len(normalized_lines), lines_per_page)]

    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }

    kids = []
    next_obj_number = 4
    for page_lines in pages:
        page_object = next_obj_number
        content_object = next_obj_number + 1
        next_obj_number += 2
        kids.append(f"{page_object} 0 R")

        stream_lines = ["BT", "/F1 10 Tf", "14 TL", "40 800 Td"]
        for index, line in enumerate(page_lines):
            escaped = escape_pdf_text(line)
            if index == 0:
                stream_lines.append(f"({escaped}) Tj")
            else:
                stream_lines.append("T*")
                stream_lines.append(f"({escaped}) Tj")
        stream_lines.append("ET")

        stream = "\n".join(stream_lines).encode("latin-1", "replace")
        objects[page_object] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_object} 0 R >>"
        ).encode("ascii")
        objects[content_object] = b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"

    objects[2] = f"<< /Type /Pages /Count {len(kids)} /Kids [{' '.join(kids)}] >>".encode("ascii")

    max_object_number = max(objects)
    pdf = io.BytesIO()
    pdf.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")

    offsets = [0] * (max_object_number + 1)
    for object_number in range(1, max_object_number + 1):
        offsets[object_number] = pdf.tell()
        pdf.write(f"{object_number} 0 obj\n".encode("ascii"))
        pdf.write(objects[object_number])
        pdf.write(b"\nendobj\n")

    xref_position = pdf.tell()
    pdf.write(f"xref\n0 {max_object_number + 1}\n".encode("ascii"))
    pdf.write(b"0000000000 65535 f \n")
    for object_number in range(1, max_object_number + 1):
        pdf.write(f"{offsets[object_number]:010d} 00000 n \n".encode("ascii"))

    pdf.write(
        (
            f"trailer\n<< /Size {max_object_number + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_position}\n%%EOF"
        ).encode("ascii")
    )
    return pdf.getvalue()


def build_export_filename(period, extension):
    timestamp = datetime.now(get_app_timezone()).strftime("%Y%m%d-%H%M%S")
    return f"transactions-{period}-{timestamp}.{extension}"


def export_transactions_as_csv(transactions, period):
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["Sender", "Receiver", "Operator", "Operation", "Amount", "Created By", "Date"])
    for tx in transactions:
        writer.writerow(
            [
                tx.get("sender_number", "-"),
                tx.get("receiver_number", "-"),
                tx.get("operator", "-"),
                tx.get("operation", "-"),
                tx.get("amount", "-"),
                tx.get("created_by", "-"),
                tx.get("created_at", "-"),
            ]
        )

    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{build_export_filename(period, "csv")}"'},
    )


def export_transactions_as_pdf(transactions, period):
    title = f"Transactions Export ({period.title()})"
    generated_at = datetime.now(get_app_timezone()).strftime("%d %b %Y %I:%M %p")
    lines = [title, f"Generated: {generated_at}", ""]
    lines.append("Sender | Receiver | Operator | Operation | Amount | Created By | Date")
    lines.append("-" * 108)

    if not transactions:
        lines.append("No transactions found for current filters.")
    else:
        for tx in transactions:
            sender = str(tx.get("sender_number", "-"))[:12]
            receiver = str(tx.get("receiver_number", "-"))[:30]
            operator = str(tx.get("operator", "-"))[:10]
            operation = str(tx.get("operation", "-"))[:10]
            amount = str(tx.get("amount", "-"))[:14]
            created_by = str(tx.get("created_by", "-"))[:12]
            created_at = str(tx.get("created_at", "-"))[:22]
            lines.append(
                f"{sender:<12} | {receiver:<30} | {operator:<10} | {operation:<10} | "
                f"{amount:<14} | {created_by:<12} | {created_at:<22}"
            )

    return Response(
        build_simple_pdf(lines),
        mimetype="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{build_export_filename(period, "pdf")}"'},
    )


def bootstrap():
    os.makedirs(app.instance_path, exist_ok=True)
    init_db()


bootstrap()


@app.context_processor
def inject_api_base_url():
    return {"api_base_url": app.config["API_BASE_URL"]}


@app.route("/")
@app.route("/dashboard")
def dashboard():
    period = normalize_period(request.args.get("period", "today"))
    search_query = request.args.get("q", "")
    operator_filter = request.args.get("operator", "")
    operation_filter = request.args.get("operation", "")
    sort_by = request.args.get("sort_by", "date")
    sort_dir = request.args.get("sort_dir", "desc")
    force_refresh = request.args.get("refresh", "0") == "1"
    per_page = normalize_per_page(request.args.get("per_page", 15))

    try:
        page = int(request.args.get("page", "1"))
    except (TypeError, ValueError):
        page = 1

    dashboard_data = build_dashboard_data(
        period=period,
        search_query=search_query,
        operator_filter=operator_filter,
        operation_filter=operation_filter,
        sort_by=sort_by,
        sort_dir=sort_dir,
        page=page,
        per_page=per_page,
        force_refresh=force_refresh,
    )

    return render_template(
        "dashboard.html",
        stats=dashboard_data["stats"],
        transactions=dashboard_data["transactions"],
        pagination=dashboard_data["pagination"],
        period=dashboard_data["period"],
        per_page=dashboard_data["per_page"],
        per_page_options=dashboard_data["per_page_options"],
        filters=dashboard_data["filters"],
        sort=dashboard_data["sort"],
        trend=dashboard_data["trend"],
        data_status=dashboard_data["data_status"],
        operator_options=dashboard_data["operator_options"],
        operation_options=dashboard_data["operation_options"],
    )


@app.route("/dashboard/export/<string:file_format>")
def export_transactions(file_format):
    period = normalize_period(request.args.get("period", "today"))
    search_query = request.args.get("q", "")
    operator_filter = request.args.get("operator", "")
    operation_filter = request.args.get("operation", "")
    sort_by = request.args.get("sort_by", "date")
    sort_dir = request.args.get("sort_dir", "desc")
    per_page = normalize_per_page(request.args.get("per_page", 15))

    dashboard_data = build_dashboard_data(
        period=period,
        search_query=search_query,
        operator_filter=operator_filter,
        operation_filter=operation_filter,
        sort_by=sort_by,
        sort_dir=sort_dir,
        page=1,
        per_page=per_page,
    )

    normalized_format = (file_format or "").strip().lower()
    if normalized_format == "csv":
        return export_transactions_as_csv(dashboard_data["filtered_transactions"], period)
    if normalized_format == "pdf":
        return export_transactions_as_pdf(dashboard_data["filtered_transactions"], period)

    return redirect(
        url_for(
            "dashboard",
            period=period,
            q=dashboard_data["filters"]["q"],
            operator=dashboard_data["filters"]["operator"],
            operation=dashboard_data["filters"]["operation"],
            sort_by=dashboard_data["sort"]["by"],
            sort_dir=dashboard_data["sort"]["dir"],
            per_page=dashboard_data["per_page"],
        )
    )


@app.route("/send-money")
def send_money():
    sender_rows = fetch_sender_configurations(active_only=True)
    return render_template(
        "send_money.html",
        sender_numbers=[row["sender_number"] for row in sender_rows],
    )


@app.route("/settings")
def settings():
    sender_configs = fetch_sender_configurations()
    return render_template(
        "settings.html",
        sender_configs=sender_configs,
        sender_config_count=len(sender_configs),
    )


@app.route("/settings/sender-config", methods=["POST"])
def add_sender_configuration():
    sender_number = request.form.get("sender_mobile_number", "").strip()
    client_code = request.form.get("client_code", "").strip()
    til_number = request.form.get("til_number", "").strip()
    til_name = request.form.get("til_name", "").strip() or "-"
    path = request.form.get("path", "").strip()

    if not sender_number or not client_code or not til_number or not path:
        return redirect(url_for("settings"))

    db = get_db()
    db.execute(
        """
        INSERT INTO sender_configurations
        (sender_number, client_code, til_number, til_name, path, is_active)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(sender_number) DO UPDATE SET
            client_code = excluded.client_code,
            til_number = excluded.til_number,
            til_name = excluded.til_name,
            path = excluded.path,
            is_active = excluded.is_active
        """,
        (sender_number, client_code, til_number, til_name, path, 1),
    )
    db.commit()
    return redirect(url_for("settings"))


@app.route("/settings/sender-config/<int:config_id>/toggle", methods=["POST"])
def toggle_sender_configuration(config_id):
    is_active = request.form.get("is_active", "0")
    next_status = 1 if is_active == "1" else 0
    db = get_db()
    db.execute("UPDATE sender_configurations SET is_active = ? WHERE id = ?", (next_status, config_id))
    db.commit()
    return redirect(url_for("settings"))


if __name__ == "__main__":
    app.run(debug=True)
