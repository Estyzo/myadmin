import time

from app.clients.api_client import ApiClientError, api_client
from app.extensions import cache
from app.services.shared import (
    format_cache_timestamp,
    normalize_message_text,
    paginate_items,
    parse_date_filter,
    parse_flexible_timestamp,
    pick_first_available,
)


MESSAGES_CACHE_KEY = "messages:list"
MESSAGES_META_KEY = "messages:list:meta"


def normalize_message_record(item):
    if not isinstance(item, dict):
        return None

    sender = pick_first_available(item, ("sender", "sender_name", "from", "source", "name"), fallback="Unknown")
    message_body = pick_first_available(item, ("message", "body", "text", "sms", "content", "payload"), fallback="-")
    phone_model = pick_first_available(
        item,
        ("phonename", "phone_info", "phone_model", "device_name", "device_model", "model", "device"),
        fallback="-",
    )
    device_id = pick_first_available(item, ("android_id", "device_id", "identifier", "imei"), fallback="-")
    created_raw = pick_first_available(
        item,
        ("created_at", "created_date", "received_at", "date", "timestamp", "time"),
        fallback="",
    )
    created_dt = parse_flexible_timestamp(created_raw)

    if created_dt is not None:
        date_label = f"{created_dt.strftime('%b')} {created_dt.day}, {created_dt.year}"
        time_label = created_dt.strftime("%H:%M:%S")
        date_key = created_dt.date().isoformat()
        date_value = created_dt.date()
        sort_value = created_dt.timestamp()
    else:
        date_label = created_raw if created_raw else "-"
        time_label = ""
        date_key = ""
        date_value = None
        sort_value = 0.0

    search_text = " ".join(
        [sender, phone_model, device_id, normalize_message_text(message_body), date_label, time_label]
    ).lower()

    return {
        "sender": sender,
        "sender_key": sender.strip().lower(),
        "message": normalize_message_text(message_body),
        "phone_info": phone_model,
        "device_id": device_id,
        "date_label": date_label,
        "time_label": time_label,
        "created_date": date_key,
        "created_date_value": date_value,
        "created_sort": sort_value,
        "search_text": search_text,
    }


def extract_message_records(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for key in ("data", "messages", "items", "results"):
        records = payload.get(key)
        if isinstance(records, list):
            return records
    return []


def _cache_timeout(config):
    return config.get("MESSAGES_CACHE_TTL_SECONDS", config.get("CACHE_DEFAULT_TIMEOUT", 120))


def _read_cached_messages():
    items = cache.get(MESSAGES_CACHE_KEY) or []
    meta = cache.get(MESSAGES_META_KEY) or {"fetched_at": 0.0, "last_error": "", "source": "none"}
    return list(items), dict(meta)


def _write_cached_messages(items, meta, config):
    timeout = _cache_timeout(config)
    cache.set(MESSAGES_CACHE_KEY, list(items), timeout=timeout)
    cache.set(MESSAGES_META_KEY, dict(meta), timeout=timeout)


def fetch_messages(config, force_refresh=False):
    now = time.time()
    cached_items, cached_meta = _read_cached_messages()
    ttl = _cache_timeout(config)
    cache_is_fresh = bool(cached_items) and (now - float(cached_meta.get("fetched_at", 0.0))) < ttl

    if cache_is_fresh and not force_refresh:
        return cached_items, {
            "source": "cache",
            "used_stale": False,
            "last_updated": cached_meta.get("fetched_at", 0.0),
            "error": "",
        }

    fetch_error = ""
    payload = None
    try:
        payload, _status_code = api_client.get_messages(config=config)
    except ApiClientError as exc:
        fetch_error = exc.message or "Unable to load messages from API."

    if payload is not None:
        normalized = []
        for raw_item in extract_message_records(payload):
            record = normalize_message_record(raw_item)
            if record is not None:
                normalized.append(record)
        normalized.sort(key=lambda item: item.get("created_sort", 0.0), reverse=True)
        fetched_at = time.time()
        _write_cached_messages(normalized, {"fetched_at": fetched_at, "last_error": "", "source": "live"}, config)
        return normalized, {
            "source": "live",
            "used_stale": False,
            "last_updated": fetched_at,
            "error": "",
        }

    if cached_items:
        stale_meta = {
            "fetched_at": cached_meta.get("fetched_at", 0.0),
            "last_error": fetch_error or cached_meta.get("last_error", ""),
            "source": "stale_cache",
        }
        _write_cached_messages(cached_items, stale_meta, config)
        return cached_items, {
            "source": "cache",
            "used_stale": True,
            "last_updated": stale_meta["fetched_at"],
            "error": stale_meta["last_error"],
        }

    return [], {
        "source": "error",
        "used_stale": False,
        "last_updated": 0.0,
        "error": fetch_error or "No messages are currently available.",
    }


def apply_message_filters(messages, search_query="", from_date=None, to_date=None, sender_filter=""):
    search_term = (search_query or "").strip().lower()
    sender_term = (sender_filter or "").strip().lower()
    filtered = []

    for message in messages:
        if sender_term and message.get("sender_key", "") != sender_term:
            continue
        if from_date or to_date:
            message_date = message.get("created_date_value")
            if not message_date:
                continue
            if from_date and message_date < from_date:
                continue
            if to_date and message_date > to_date:
                continue
        if search_term and search_term not in message.get("search_text", ""):
            continue
        filtered.append(message)

    return filtered


def build_messages_view_model(config, args):
    search_query = args.get("q", "")
    from_date_raw = args.get("from_date", "")
    to_date_raw = args.get("to_date", "")
    sender_filter = args.get("sender", "")
    force_refresh = str(args.get("refresh", "0")).strip().lower() in {"1", "true", "yes", "on"}

    try:
        page = int(args.get("page", "1"))
    except (TypeError, ValueError):
        page = 1
    per_page = 20

    all_messages, fetch_meta = fetch_messages(config=config, force_refresh=force_refresh)
    from_date = parse_date_filter(from_date_raw)
    to_date = parse_date_filter(to_date_raw)
    if from_date and to_date and from_date > to_date:
        from_date, to_date = to_date, from_date

    sender_options = sorted(
        {item.get("sender", "").strip() for item in all_messages if item.get("sender") and item.get("sender") != "-"},
        key=str.casefold,
    )
    cleaned_sender = (sender_filter or "").strip()
    if cleaned_sender and cleaned_sender not in sender_options:
        cleaned_sender = ""

    filtered_messages = apply_message_filters(
        all_messages,
        search_query=search_query,
        from_date=from_date,
        to_date=to_date,
        sender_filter=cleaned_sender,
    )
    paged_messages, pagination = paginate_items(filtered_messages, page=page, per_page=per_page)

    if fetch_meta["source"] == "live":
        status_level = "success"
        status_title = "Messages Synced"
        status_message = "Showing latest messages from live API."
    elif fetch_meta["source"] == "cache" and fetch_meta["used_stale"]:
        status_level = "warning"
        status_title = "Using Cached Messages"
        status_message = fetch_meta["error"] or "Live API unavailable. Showing latest cached messages."
    elif fetch_meta["source"] == "cache":
        status_level = "info"
        status_title = "Using Cached Snapshot"
        status_message = "Showing a recently cached message snapshot."
    else:
        status_level = "error"
        status_title = "Messages Unavailable"
        status_message = fetch_meta["error"] or "Unable to load messages."

    return {
        "messages": paged_messages,
        "pagination": pagination,
        "sender_options": sender_options,
        "filters": {
            "q": (search_query or "").strip(),
            "from_date": from_date.isoformat() if from_date else "",
            "to_date": to_date.isoformat() if to_date else "",
            "sender": cleaned_sender,
        },
        "data_status": {
            "level": status_level,
            "title": status_title,
            "message": status_message,
            "last_updated": format_cache_timestamp(fetch_meta.get("last_updated")),
        },
    }
