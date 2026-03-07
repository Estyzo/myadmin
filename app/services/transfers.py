from datetime import datetime

from app.clients.api_client import ApiClientError, api_client
from app.services.settings import fetch_sender_configurations
from app.services.shared import format_currency_amount, get_app_timezone


def normalize_tz_phone_number(value):
    digits = "".join(ch for ch in str(value or "").strip() if ch.isdigit())
    if digits.startswith("255") and len(digits) == 12:
        return f"+{digits}"
    if digits.startswith("0") and len(digits) == 10:
        return f"+255{digits[1:]}"
    if len(digits) == 9:
        return f"+255{digits}"
    return ""


def extract_transfer_reference(payload, depth=0):
    if depth > 3:
        return ""

    if isinstance(payload, dict):
        for key in (
            "reference",
            "transaction_reference",
            "transactionRef",
            "transaction_id",
            "transactionId",
            "request_id",
            "requestId",
            "id",
        ):
            value = payload.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if text:
                return text
        for value in payload.values():
            nested = extract_transfer_reference(value, depth + 1)
            if nested:
                return nested

    if isinstance(payload, list):
        for item in payload:
            nested = extract_transfer_reference(item, depth + 1)
            if nested:
                return nested

    return ""


def submit_send_money_request(config, payload):
    sender_raw = payload.get("sender_mobile_number")
    receiver_raw = payload.get("receiver_phone_number")
    amount_raw = payload.get("amount")

    sender_number = normalize_tz_phone_number(sender_raw)
    receiver_number = normalize_tz_phone_number(receiver_raw)

    validation_errors = {}
    if not sender_number:
        validation_errors["sender_mobile_number"] = "Sender number is invalid."
    if not receiver_number:
        validation_errors["receiver_phone_number"] = "Receiver number is invalid."
    try:
        amount_value = float(str(amount_raw).strip())
        if amount_value <= 0:
            raise ValueError
    except (TypeError, ValueError):
        amount_value = 0.0
        validation_errors["amount"] = "Amount must be greater than zero."

    if validation_errors:
        return {
            "ok": False,
            "error": "Validation failed.",
            "errors": validation_errors,
        }, 400

    upstream_payload = {
        "sender_mobile_number": sender_number,
        "receiver_phone_number": receiver_number,
        "amount": round(amount_value, 2),
    }

    try:
        upstream_data, upstream_status = api_client.post_send_money(upstream_payload, config=config)
    except ApiClientError as exc:
        status_code = exc.status_code or 502
        return {
            "ok": False,
            "error": exc.message or "Unable to reach transfer API.",
            "upstream_status": status_code,
        }, 502

    return {
        "ok": True,
        "message": "Transfer request submitted successfully.",
        "upstream_status": upstream_status,
        "data": upstream_data,
        "receipt": {
            "sender_mobile_number": sender_number,
            "receiver_phone_number": receiver_number,
            "amount": format_currency_amount(round(amount_value, 2)),
            "amount_value": round(amount_value, 2),
            "submitted_at": datetime.now(get_app_timezone()).isoformat(),
            "reference": extract_transfer_reference(upstream_data) or "-",
            "status": f"HTTP {upstream_status}",
        },
    }, 200


def get_active_sender_numbers(config):
    sender_rows, _fetch_meta = fetch_sender_configurations(config=config, active_only=True)
    return sorted(
        {row.get("sender_number", "").strip() for row in sender_rows if row.get("sender_number")},
        key=str.casefold,
    )
