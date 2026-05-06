import time

from app.clients.api_client import ApiClientError, api_client
from app.services.shared import format_cache_timestamp, parse_flexible_timestamp, pick_first_available


def extract_request_records(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for key in ("data", "requests", "items", "results"):
        records = payload.get(key)
        if isinstance(records, list):
            return records
    return []


def normalize_request_record(item):
    if not isinstance(item, dict):
        return None

    request_id = pick_first_available(item, ("id", "request_id", "requestId", "rid", "_id"), fallback="-")
    status = pick_first_available(item, ("status", "state", "approval_status", "decision"), fallback="Pending")
    approval_status = pick_first_available(
        item,
        ("approvalStatus", "approval_status", "approvalstatus", "approvalState", "approval_state", "decision"),
        fallback="-",
    )
    action = pick_first_available(item, ("action", "type", "operation"), fallback="-")
    sender = pick_first_available(item, ("sender", "sender_number", "phoneNumber", "phone_number", "msisdn"), fallback="-")
    receiver = pick_first_available(item, ("receiver", "receiverNumber", "receiver_number", "receivernumber"), fallback="-")
    amount = pick_first_available(item, ("amount", "value", "transaction_amount"), fallback="-")
    client = pick_first_available(item, ("client", "client_code", "clientCode"), fallback="-")
    operator = pick_first_available(item, ("mobileCarrier", "mobile_operator", "operator", "carrier"), fallback="-")
    message = pick_first_available(item, ("message", "prompt", "mmessage", "reply", "description", "mrequest"), fallback="-")
    created_raw = pick_first_available(item, ("created_at", "createdAt", "date", "timestamp", "time"), fallback="")
    created_dt = parse_flexible_timestamp(created_raw)

    if created_dt is not None:
        date_label = created_dt.strftime("%b %-d, %Y")
        time_label = created_dt.strftime("%H:%M:%S")
        date_key = created_dt.date().isoformat()
        sort_value = created_dt.timestamp()
    else:
        date_label = created_raw or "-"
        time_label = ""
        date_key = ""
        sort_value = 0.0

    search_text = " ".join([request_id, status, approval_status, action, sender, receiver, str(amount), client, operator, message]).lower()

    return {
        "id": request_id,
        "status": status,
        "approvalStatus": approval_status,
        "action": action,
        "sender": sender,
        "receiver": receiver,
        "amount": str(amount),
        "client": client,
        "operator": operator,
        "message": message,
        "date_label": date_label,
        "time_label": time_label,
        "created_date": date_key,
        "created_sort": sort_value,
        "search_text": search_text,
        "raw": item,
    }


def fetch_requests(config):
    try:
        payload, status_code = api_client.get_requests(config=config)
    except ApiClientError as exc:
        return {
            "ok": False,
            "error": exc.message or "Unable to load requests.",
            "data": [],
            "meta": {
                "source": "error",
                "upstream_status": exc.status_code,
                "last_updated": format_cache_timestamp(0),
            },
        }, 502

    normalized = []
    for raw_item in extract_request_records(payload):
        record = normalize_request_record(raw_item)
        if record is not None:
            normalized.append(record)
    normalized.sort(key=lambda item: item.get("created_sort", 0.0), reverse=True)
    fetched_at = time.time()
    return {
        "ok": True,
        "data": normalized,
        "meta": {
            "source": "live",
            "upstream_status": status_code,
            "last_updated": format_cache_timestamp(fetched_at),
            "count": len(normalized),
        },
    }, 200
