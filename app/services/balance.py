import time
import re

from app.clients.api_client import ApiClientError, api_client
from app.services.shared import (
    format_cache_timestamp,
    format_currency_amount,
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


def latest_balance_by_operator(records):
    latest = {}
    for item in records:
        record = normalize_balance_record(item)
        if record is None:
            continue
        existing = latest.get(record["operator_key"])
        if existing is None or record["created_sort"] >= existing["created_sort"]:
            latest[record["operator_key"]] = record
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

    records = latest_balance_by_operator(extract_balance_records(payload))
    return {
        "ok": True,
        "data": records,
        "meta": {
            "source": "live",
            "upstream_status": status_code,
            "last_updated": format_cache_timestamp(fetched_at),
            "count": len(records),
        },
    }
