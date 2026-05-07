import time
import re
from datetime import datetime, timedelta

from app.clients.api_client import ApiClientError, api_client
from app.services.auth import current_user, filter_by_client_scope, user_can_access_client
from app.services.shared import (
    format_cache_timestamp,
    format_currency_amount,
    get_app_timezone,
    parse_flexible_timestamp,
    pick_first_available,
)


def extract_balance_records(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for key in ("data", "balances", "items", "results", "records"):
        records = payload.get(key)
        if isinstance(records, list):
            return records
    return []


def extract_log_records(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for key in ("data", "logs", "items", "results", "records"):
        records = payload.get(key)
        if isinstance(records, list):
            return records
    return []


def normalize_operator_name(value):
    text = str(value or "").strip()
    if not text or text == "-":
        return "-"
    normalized = text.lower()
    if normalized in {"yas", "tigo"}:
        return "YAS" if normalized == "yas" else "Tigo"
    if normalized in {"vodacom", "voda", "m-pesa", "mpesa"}:
        return "Vodacom"
    if normalized == "airtel":
        return "Airtel"
    if normalized == "halotel":
        return "Halotel"
    return text


def parse_balance_amount(value):
    numeric = re.sub(r"[^0-9.-]+", "", str(value or ""))
    try:
        return float(numeric)
    except (TypeError, ValueError):
        return None


def normalize_client_code(value):
    return str(value or "").strip()


def normalize_client_key(value):
    return normalize_client_code(value).casefold()


def parse_log_timestamp(item):
    received_at = pick_first_available(
        item,
        ("received_at", "receivedAt", "created_at", "createdAt", "updated_at", "updatedAt"),
        fallback="",
    )
    parsed = parse_flexible_timestamp(received_at)
    if parsed is not None:
        return parsed

    ts = pick_first_available(item, ("ts", "timestamp", "time"), fallback="")
    return parse_flexible_timestamp(ts)


def build_client_status_index(logs, now=None):
    now_dt = now or datetime.now(get_app_timezone())
    online_threshold = now_dt - timedelta(minutes=10)
    latest_by_client = {}

    for item in logs:
        if not isinstance(item, dict):
            continue
        client_code = normalize_client_code(
            pick_first_available(item, ("client_id", "clientId", "client_code", "clientCode", "client"), fallback="")
        )
        if not client_code:
            continue
        seen_at = parse_log_timestamp(item)
        if seen_at is None:
            continue
        client_key = normalize_client_key(client_code)
        existing = latest_by_client.get(client_key)
        if existing is None or seen_at.timestamp() >= existing["last_seen_sort"]:
            latest_by_client[client_key] = {
                "client_code": client_code,
                "is_online": seen_at >= online_threshold,
                "status": "online" if seen_at >= online_threshold else "offline",
                "label": "Online" if seen_at >= online_threshold else "Offline",
                "last_seen": seen_at.strftime("%d %b %Y, %I:%M %p"),
                "last_seen_sort": seen_at.timestamp(),
            }

    return latest_by_client


def build_client_status_payload(config):
    fetched_at = time.time()
    try:
        payload, status_code = api_client.get_logs(config=config)
    except ApiClientError as exc:
        return {
            "ok": False,
            "clients": {},
            "meta": {
                "error": exc.message or "Unable to load client logs.",
                "source": "error",
                "upstream_status": exc.status_code,
                "last_updated": format_cache_timestamp(fetched_at),
                "online_window_minutes": 10,
            },
        }

    status_index = build_client_status_index(extract_log_records(payload))
    active_user = current_user()
    if active_user:
        status_index = {
            key: value
            for key, value in status_index.items()
            if user_can_access_client(value.get("client_code"), user=active_user)
        }
    return {
        "ok": True,
        "clients": status_index,
        "meta": {
            "source": "live",
            "upstream_status": status_code,
            "last_updated": format_cache_timestamp(fetched_at),
            "online_window_minutes": 10,
        },
    }


def normalize_balance_record(item):
    if not isinstance(item, dict):
        return None

    operator = normalize_operator_name(
        pick_first_available(
            item,
            ("operator", "mobile_operator", "mobileOperator", "mobileCarrier", "carrier", "network", "provider"),
            fallback="-",
        )
    )
    raw_balance = pick_first_available(
        item,
        ("balance", "amount", "value", "available_balance", "availableBalance", "current_balance", "currentBalance"),
        fallback="",
    )
    client_code = pick_first_available(item, ("client_code", "clientCode", "clientId", "client", "created_by", "createdBy"), fallback="-")
    currency = pick_first_available(item, ("currency", "currency_code", "currencyCode"), fallback="TZS")
    created_raw = pick_first_available(
        item,
        ("created_at", "createdAt", "updated_at", "updatedAt", "date", "timestamp", "time", "balance_time", "balanceTime"),
        fallback="",
    )
    created_dt = parse_flexible_timestamp(created_raw)
    balance_value = parse_balance_amount(raw_balance)

    if operator == "-" or balance_value is None:
        return None

    if created_dt is not None:
        sort_value = created_dt.timestamp()
        last_updated = created_dt.strftime("%d %b %Y, %I:%M %p")
    else:
        sort_value = 0.0
        last_updated = created_raw or "-"

    return {
        "operator": operator,
        "operator_key": operator.strip().lower(),
        "client_code": client_code,
        "balance": format_currency_amount(balance_value, currency),
        "balance_value": balance_value,
        "currency": currency,
        "last_updated": last_updated,
        "created_sort": sort_value,
        "raw": item,
    }


def attach_client_status(records, status_index):
    updated_records = []
    for record in records:
        updated = dict(record)
        status = status_index.get(normalize_client_key(updated.get("client_code"))) or {}
        updated["client_status"] = status.get("status", "offline")
        updated["client_status_label"] = status.get("label", "Offline")
        updated["client_online"] = bool(status.get("is_online"))
        updated["client_last_seen"] = status.get("last_seen", "No logs in the last 10 minutes")
        updated_records.append(updated)
    return updated_records


def latest_balance_by_client_operator(records):
    latest = {}
    for item in records:
        record = normalize_balance_record(item)
        if record is None:
            continue
        client_key = normalize_client_key(record.get("client_code")) or "-"
        record_key = (client_key, record["operator_key"])
        existing = latest.get(record_key)
        if existing is None or record["created_sort"] >= existing["created_sort"]:
            latest[record_key] = record
    return sorted(latest.values(), key=lambda item: (str(item.get("client_code") or "").lower(), item["operator"]))


def build_balance_payload(config):
    fetched_at = time.time()
    try:
        payload, status_code = api_client.get_balance(config=config)
    except ApiClientError as exc:
        return {
            "ok": False,
            "data": [],
            "meta": {
                "error": exc.message or "Unable to load balances.",
                "source": "error",
                "upstream_status": exc.status_code,
                "last_updated": format_cache_timestamp(fetched_at),
                "count": 0,
            },
        }

    status_payload = build_client_status_payload(config)
    records = filter_by_client_scope(attach_client_status(
        latest_balance_by_client_operator(extract_balance_records(payload)),
        status_payload.get("clients", {}),
    ), key="client_code")
    return {
        "ok": True,
        "data": records,
        "meta": {
            "source": "live",
            "upstream_status": status_code,
            "last_updated": format_cache_timestamp(fetched_at),
            "count": len(records),
            "client_status": status_payload["meta"],
        },
    }
