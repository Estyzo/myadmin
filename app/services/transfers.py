from datetime import datetime, timedelta
from uuid import uuid4

from app.clients.api_client import ApiClientError, api_client
from app.services.request_feed import extract_request_records
from app.services.settings import fetch_sender_configurations, infer_mobile_operator_name
from app.services.shared import format_currency_amount, get_app_timezone, parse_flexible_timestamp, pick_first_available


TRUSTED_RECEIVER_MIN_APPROVALS = 2
TRUSTED_RECEIVER_AMOUNT_LIMIT = 50000
TRUSTED_RECEIVER_LOOKBACK_DAYS = 60
TRUSTED_RECEIVER_DAILY_AMOUNT_LIMIT = 150000
TRUSTED_RECEIVER_DAILY_COUNT_LIMIT = 5
TRUSTED_RECEIVER_AUTO_APPROVAL_NOTE = "Auto-approved: trusted receiver under 50,000 TZS"


def normalize_tz_phone_number(value):
    digits = "".join(ch for ch in str(value or "").strip() if ch.isdigit())
    if digits.startswith("255") and len(digits) == 12:
        return f"+{digits}"
    if digits.startswith("0") and len(digits) == 10:
        return f"+255{digits[1:]}"
    if len(digits) == 9:
        return f"+255{digits}"
    return ""


def normalize_tz_receiver_number(value):
    digits = "".join(ch for ch in str(value or "").strip() if ch.isdigit())
    if digits.startswith("255") and len(digits) == 12:
        digits = f"0{digits[3:]}"
    elif len(digits) == 9:
        digits = f"0{digits}"
    return digits if digits.startswith("0") and len(digits) == 10 else ""


def normalize_tz_local_number(value):
    return normalize_tz_receiver_number(value)


def normalize_operator_key(value):
    normalized = str(value or "").strip().casefold()
    if normalized in {"yas", "tigo", "mixx by yas"}:
        return "yas"
    if normalized in {"vodacom", "voda", "m-pesa", "mpesa"}:
        return "vodacom"
    return normalized


def parse_request_amount(value):
    try:
        return float(str(value or "").replace(",", "").strip())
    except (TypeError, ValueError):
        return 0.0


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
            "insertId",
            "insert_id",
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


def extract_transfer_request_id(payload):
    reference = extract_transfer_reference(payload)
    try:
        return int(str(reference).strip())
    except (TypeError, ValueError):
        return 0


def extract_nested_value(payload, keys, depth=0):
    if depth > 3:
        return ""

    if isinstance(payload, dict):
        for key in keys:
            value = payload.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if text:
                return text
        for value in payload.values():
            nested = extract_nested_value(value, keys, depth + 1)
            if nested:
                return nested

    if isinstance(payload, list):
        for item in payload:
            nested = extract_nested_value(item, keys, depth + 1)
            if nested:
                return nested

    return ""


def build_approval_focus_payload(payload):
    return {
        "ownerToken": payload.get("owner_token") or payload.get("ownerToken"),
        "initiatedBy": payload.get("initiated_by") or payload.get("initiatedBy") or "transferflow-admin",
        "clientRequestId": payload.get("client_request_id") or payload.get("clientRequestId"),
    }


def build_transfer_request_path(path_template, receiver_number, amount_value):
    amount_text = str(int(amount_value)) if float(amount_value).is_integer() else f"{amount_value:.2f}".rstrip("0").rstrip(".")
    return (
        str(path_template or "")
        .replace("receivernumber", receiver_number)
        .replace("receiverNumber", receiver_number)
        .replace("RECEIVERNUMBER", receiver_number)
        .replace("amount", amount_text)
        .replace("AMOUNT", amount_text)
    )


def get_trusted_receiver_policy(record, now=None):
    if record["amount_value"] >= TRUSTED_RECEIVER_AMOUNT_LIMIT:
        return {
            "eligible": False,
            "reason": "amount_limit",
            "message": "Manual approval required for transfers of 50,000 TZS or more.",
            "approved_count": 0,
            "daily_auto_count": 0,
            "daily_auto_amount": 0.0,
        }

    try:
        payload, _status_code = api_client.get_requests(config=record["config"])
    except ApiClientError as exc:
        return {
            "eligible": False,
            "reason": "history_unavailable",
            "message": exc.message or "Unable to verify trusted receiver history.",
            "approved_count": 0,
            "daily_auto_count": 0,
            "daily_auto_amount": 0.0,
        }

    now_dt = now or datetime.now(get_app_timezone())
    lookback_start = now_dt - timedelta(days=TRUSTED_RECEIVER_LOOKBACK_DAYS)
    day_start = now_dt.replace(hour=0, minute=0, second=0, microsecond=0)
    approved_count = 0
    daily_auto_count = 0
    daily_auto_amount = 0.0
    target_receiver = normalize_tz_receiver_number(record["receiver_number"])
    target_client = str(record["client_code"] or "").strip().casefold()
    target_operator = normalize_operator_key(record["mobile_operator"])

    for item in extract_request_records(payload):
        if not isinstance(item, dict):
            continue
        item_receiver = normalize_tz_receiver_number(
            pick_first_available(item, ("receiverNumber", "receiver_number", "receivernumber", "receiver"), fallback="")
        )
        item_client = str(pick_first_available(item, ("client", "client_code", "clientCode"), fallback="")).strip().casefold()
        item_operator = normalize_operator_key(
            pick_first_available(item, ("mobileCarrier", "mobile_operator", "operator", "carrier"), fallback="")
        )
        if item_receiver != target_receiver or item_client != target_client or item_operator != target_operator:
            continue

        created_dt = parse_flexible_timestamp(
            pick_first_available(item, ("createdAt", "created_at", "date", "timestamp", "time"), fallback="")
        )
        approval_status = str(
            pick_first_available(item, ("approvalStatus", "approval_status", "approvalState", "decision"), fallback="")
        ).strip().upper()
        if approval_status != "APPROVED":
            continue

        if created_dt is not None and created_dt >= lookback_start:
            approved_count += 1

        approval_note = str(pick_first_available(item, ("approvalNote", "approval_note", "note"), fallback="")).strip()
        if created_dt is not None and created_dt >= day_start and TRUSTED_RECEIVER_AUTO_APPROVAL_NOTE.casefold() in approval_note.casefold():
            daily_auto_count += 1
            daily_auto_amount += parse_request_amount(
                pick_first_available(item, ("amount", "value", "transaction_amount"), fallback="")
            )

    if approved_count < TRUSTED_RECEIVER_MIN_APPROVALS:
        return {
            "eligible": False,
            "reason": "approval_history",
            "message": f"Manual approval required until this receiver has {TRUSTED_RECEIVER_MIN_APPROVALS} approved transfers for this client/operator.",
            "approved_count": approved_count,
            "daily_auto_count": daily_auto_count,
            "daily_auto_amount": daily_auto_amount,
        }

    if daily_auto_count >= TRUSTED_RECEIVER_DAILY_COUNT_LIMIT:
        return {
            "eligible": False,
            "reason": "daily_count_limit",
            "message": "Manual approval required because the trusted receiver daily auto-approval count limit was reached.",
            "approved_count": approved_count,
            "daily_auto_count": daily_auto_count,
            "daily_auto_amount": daily_auto_amount,
        }

    if daily_auto_amount + record["amount_value"] > TRUSTED_RECEIVER_DAILY_AMOUNT_LIMIT:
        return {
            "eligible": False,
            "reason": "daily_amount_limit",
            "message": "Manual approval required because the trusted receiver daily auto-approval amount limit would be exceeded.",
            "approved_count": approved_count,
            "daily_auto_count": daily_auto_count,
            "daily_auto_amount": daily_auto_amount,
        }

    return {
        "eligible": True,
        "reason": "trusted_receiver",
        "message": "Trusted receiver matched. Transfer auto-approved.",
        "approved_count": approved_count,
        "daily_auto_count": daily_auto_count,
        "daily_auto_amount": daily_auto_amount,
    }


def maybe_auto_approve_trusted_receiver(config, approval_context, transfer_record):
    if not approval_context.get("request_id") or not approval_context.get("owner_token"):
        return {
            "applied": False,
            "reason": "missing_approval_context",
            "message": "Approval tracking details were missing.",
        }

    policy = get_trusted_receiver_policy({**transfer_record, "config": config})
    if not policy["eligible"]:
        return {
            "applied": False,
            **policy,
        }

    decision_payload = {
        "request_id": approval_context["request_id"],
        "owner_token": approval_context["owner_token"],
        "initiated_by": approval_context.get("initiated_by"),
        "client_request_id": approval_context.get("client_request_id"),
        "decision": "APPROVED",
        "note": TRUSTED_RECEIVER_AUTO_APPROVAL_NOTE,
    }
    decision_response, decision_status = submit_transfer_approval_decision(config, decision_payload)
    if decision_status >= 400 or not decision_response.get("ok"):
        return {
            "applied": False,
            "decision": decision_response,
            **policy,
            "reason": "decision_failed",
            "message": decision_response.get("error") or "Trusted receiver matched, but auto-approval failed.",
        }

    return {
        "applied": True,
        "reason": "trusted_receiver",
        "message": decision_response.get("message") or "Trusted receiver matched. Transfer auto-approved.",
        "decision": decision_response,
        **policy,
    }


def submit_send_money_request(config, payload):
    sender_raw = payload.get("sender_mobile_number")
    receiver_raw = payload.get("receiver_phone_number")
    amount_raw = payload.get("amount")
    client_code_raw = payload.get("client_code")
    mobile_operator_raw = payload.get("mobile_operator")

    sender_number = normalize_tz_phone_number(sender_raw)
    sender_local_number = normalize_tz_local_number(sender_raw)
    receiver_number = normalize_tz_receiver_number(receiver_raw)
    sender_config = find_sender_configuration(config, sender_number) if sender_number else {}
    client_code = str(client_code_raw or sender_config.get("client_code") or "").strip()
    mobile_operator = str(mobile_operator_raw or sender_config.get("mobile_operator") or "").strip()
    request_path = str(sender_config.get("path") or "").strip()
    receiver_operator = infer_mobile_operator_name(receiver_number) if receiver_number else ""

    validation_errors = {}
    if not sender_number or not sender_local_number:
        validation_errors["sender_mobile_number"] = "Sender number is invalid."
    if not client_code or client_code == "-":
        validation_errors["client_code"] = "Client code is required for the selected sender."
    if not mobile_operator or mobile_operator == "-":
        validation_errors["mobile_operator"] = "Mobile operator name is required for the selected sender."
    if not request_path or request_path == "-":
        validation_errors["sender_mobile_number"] = "Selected sender must include a transfer path."
    if not receiver_number:
        validation_errors["receiver_phone_number"] = "Receiver number is invalid."
    elif not receiver_operator:
        validation_errors["receiver_phone_number"] = "Receiver operator could not be detected from this number."
    elif mobile_operator and mobile_operator != "-" and receiver_operator.casefold() != mobile_operator.casefold():
        validation_errors["receiver_phone_number"] = (
            f"Cross-operator transfer is not allowed. Receiver is {receiver_operator}, "
            f"but sender is {mobile_operator}."
        )
    try:
        amount_value = float(str(amount_raw).strip())
        if amount_value < 1000:
            raise ValueError
    except (TypeError, ValueError):
        amount_value = 0.0
        validation_errors["amount"] = "Amount must be at least 1,000."

    if validation_errors:
        return {
            "ok": False,
            "error": "Validation failed.",
            "errors": validation_errors,
        }, 400

    resolved_request_path = build_transfer_request_path(request_path, receiver_number, round(amount_value, 2))

    upstream_payload = {
        "mobileCarrier": mobile_operator,
        "phoneNumber": sender_local_number,
        "amount": round(amount_value, 2),
        "receiverNumber": receiver_number,
        "mrequest": resolved_request_path,
        "client": client_code,
        "action": "TRANSFER",
        "initiatedBy": "transferflow-admin",
        "clientRequestId": f"transferflow-{uuid4().hex}",
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

    request_id = extract_transfer_request_id(upstream_data)
    owner_token = extract_nested_value(upstream_data, ("ownerToken", "owner_token"))
    client_request_id = (
        extract_nested_value(upstream_data, ("clientRequestId", "client_request_id"))
        or upstream_payload["clientRequestId"]
    )
    approval_context = {
        "request_id": request_id,
        "owner_token": owner_token,
        "initiated_by": upstream_payload["initiatedBy"],
        "client_request_id": client_request_id,
        "mrequest": resolved_request_path,
        "poll_url": "/api/send-money/approval-status",
        "decision_url": "/api/send-money/approval-decision",
    }
    trusted_receiver_auto_approval = maybe_auto_approve_trusted_receiver(
        config,
        approval_context,
        {
            "client_code": client_code,
            "mobile_operator": mobile_operator,
            "receiver_number": receiver_number,
            "amount_value": round(amount_value, 2),
        },
    )
    auto_approval_applied = bool(trusted_receiver_auto_approval.get("applied"))

    return {
        "ok": True,
        "message": "Transfer request auto-approved for trusted receiver." if auto_approval_applied else "Transfer request created. Waiting for approval prompt.",
        "upstream_status": upstream_status,
        "data": upstream_data,
        "approval": approval_context,
        "auto_approval": trusted_receiver_auto_approval,
        "receipt": {
            "sender_mobile_number": sender_number,
            "sender_local_number": sender_local_number,
            "client_code": client_code,
            "mobile_operator": mobile_operator,
            "receiver_phone_number": receiver_number,
            "receiver_mobile_operator": receiver_operator,
            "amount": format_currency_amount(round(amount_value, 2)),
            "amount_value": round(amount_value, 2),
            "submitted_at": datetime.now(get_app_timezone()).isoformat(),
            "reference": str(request_id or extract_transfer_reference(upstream_data) or "-"),
            "status": "Approved" if auto_approval_applied else "Waiting for approval",
        },
    }, 200


def poll_transfer_approval_status(config, payload):
    request_id = payload.get("request_id") or payload.get("requestId")
    try:
        normalized_request_id = int(str(request_id).strip())
    except (TypeError, ValueError):
        return {"ok": False, "error": "Invalid request id."}, 400

    focus_payload = build_approval_focus_payload(payload)
    if not focus_payload["ownerToken"]:
        return {"ok": False, "error": "Approval owner token is required."}, 400

    try:
        upstream_data, upstream_status = api_client.get_request_focus(normalized_request_id, focus_payload, config=config)
    except ApiClientError as exc:
        return {
            "ok": False,
            "error": exc.message or "Unable to poll approval status.",
            "upstream_status": exc.status_code or 502,
        }, 502

    data = upstream_data.get("data", {}) if isinstance(upstream_data, dict) else {}
    approval_status = str(data.get("approvalStatus") or data.get("approval_status") or "NONE").strip().upper()
    prompt_text = str(data.get("approvalPromptText") or data.get("approval_prompt_text") or "").strip()
    device_status = str(data.get("deviceStatus") or data.get("device_status") or "").strip()
    approval_note = str(data.get("approvalNote") or data.get("approval_note") or "").strip()

    return {
        "ok": True,
        "upstream_status": upstream_status,
        "request_id": normalized_request_id,
        "approval_status": approval_status,
        "prompt_text": prompt_text,
        "device_status": device_status,
        "message": approval_note or prompt_text or ("Waiting for approval prompt." if approval_status in {"NONE", "PENDING"} else approval_status.title()),
        "data": data,
    }, 200


def submit_transfer_approval_decision(config, payload):
    request_id = payload.get("request_id") or payload.get("requestId")
    decision = str(payload.get("decision") or "").strip().upper()
    try:
        normalized_request_id = int(str(request_id).strip())
    except (TypeError, ValueError):
        return {"ok": False, "error": "Invalid request id."}, 400
    if decision not in {"APPROVED", "REJECTED"}:
        return {"ok": False, "error": "Decision must be APPROVED or REJECTED."}, 400

    focus_payload = build_approval_focus_payload(payload)
    if not focus_payload["ownerToken"]:
        return {"ok": False, "error": "Approval owner token is required."}, 400

    decision_payload = {
        "decision": decision,
        "note": str(payload.get("note") or "").strip(),
        **focus_payload,
    }

    try:
        upstream_data, upstream_status = api_client.post_request_approval_decision(normalized_request_id, decision_payload, config=config)
    except ApiClientError as exc:
        return {
            "ok": False,
            "error": exc.message or "Unable to submit approval decision.",
            "upstream_status": exc.status_code or 502,
        }, 502

    response = upstream_data.get("response", {}) if isinstance(upstream_data, dict) else {}
    return {
        "ok": True,
        "message": response.get("message") or f"Transfer {decision.lower()}.",
        "upstream_status": upstream_status,
        "decision": decision,
        "response": response,
        "data": upstream_data.get("data", {}) if isinstance(upstream_data, dict) else {},
    }, 200


def find_sender_configuration(config, sender_number):
    normalized_sender = normalize_tz_phone_number(sender_number)
    sender_rows, _fetch_meta = fetch_sender_configurations(config=config, active_only=True)
    for row in sender_rows:
        if normalize_tz_phone_number(row.get("sender_number")) == normalized_sender:
            return row
    return {}


def get_active_sender_options(config):
    sender_rows, _fetch_meta = fetch_sender_configurations(config=config, active_only=True)
    return sorted(
        [
            {
                "sender_number": row.get("sender_number", "").strip(),
                "client_code": str(row.get("client_code") or "-").strip(),
                "mobile_operator": str(row.get("mobile_operator") or "-").strip(),
                "path": str(row.get("path") or "-").strip(),
            }
            for row in sender_rows
            if row.get("sender_number")
        ],
        key=lambda row: row["sender_number"].casefold(),
    )


def get_active_sender_numbers(config):
    return [row["sender_number"] for row in get_active_sender_options(config)]
