import time

from app.clients.api_client import ApiClientError, api_client
from app.extensions import cache
from app.services.shared import format_cache_timestamp, pick_first_available


SENDER_CONFIG_CACHE_KEY = "settings:sender-configurations"
SENDER_CONFIG_META_KEY = "settings:sender-configurations:meta"


def parse_sender_status(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0

    normalized = str(value or "").strip().lower()
    if normalized in {"1", "true", "yes", "active", "enabled", "on"}:
        return True
    if normalized in {"0", "false", "no", "inactive", "disabled", "off"}:
        return False
    return True


def extract_sender_config_records(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []

    for key in ("data", "items", "results", "sender_configurations", "senderConfigurations", "records"):
        records = payload.get(key)
        if isinstance(records, list):
            return records
    return []


def normalize_sender_config_record(item, fallback_id):
    if not isinstance(item, dict):
        return None

    sender_number = pick_first_available(
        item,
        ("sender_number", "sender_mobile_number", "senderNumber", "sender", "mobile_number", "phone_number"),
        fallback="",
    ).strip()
    if not sender_number:
        return None

    raw_id = pick_first_available(item, ("id", "config_id", "sender_config_id"), fallback="")
    try:
        normalized_id = int(str(raw_id).strip()) if str(raw_id).strip() else fallback_id
    except (TypeError, ValueError):
        normalized_id = fallback_id

    status_value = item.get("is_active", item.get("active", item.get("status", True)))
    return {
        "id": normalized_id,
        "sender_number": sender_number,
        "client_code": pick_first_available(item, ("client_code", "clientCode"), fallback="-"),
        "til_number": pick_first_available(item, ("til_number", "tilNumber"), fallback="-"),
        "til_name": pick_first_available(item, ("til_name", "tilName"), fallback="-"),
        "path": pick_first_available(item, ("path", "ussd_path", "ussdPath"), fallback="-"),
        "is_active": parse_sender_status(status_value),
    }


def _cache_timeout(config):
    return config.get("SENDER_CONFIG_CACHE_TTL_SECONDS", config.get("CACHE_DEFAULT_TIMEOUT", 180))


def _read_cached_sender_configurations():
    items = cache.get(SENDER_CONFIG_CACHE_KEY) or []
    meta = cache.get(SENDER_CONFIG_META_KEY) or {"fetched_at": 0.0, "last_error": "", "source": "none"}
    return list(items), dict(meta)


def _write_cached_sender_configurations(items, meta, config):
    timeout = _cache_timeout(config)
    cache.set(SENDER_CONFIG_CACHE_KEY, list(items), timeout=timeout)
    cache.set(SENDER_CONFIG_META_KEY, dict(meta), timeout=timeout)


def fetch_sender_configurations(config, active_only=False, force_refresh=False):
    def apply_filters(rows):
        return [row for row in rows if row.get("is_active")] if active_only else rows

    now = time.time()
    cached_items, cached_meta = _read_cached_sender_configurations()
    ttl = _cache_timeout(config)
    cache_is_fresh = bool(cached_items) and (now - float(cached_meta.get("fetched_at", 0.0))) < ttl

    if cache_is_fresh and not force_refresh:
        return apply_filters(cached_items), {
            "source": "cache",
            "used_stale": False,
            "last_updated": cached_meta.get("fetched_at", 0.0),
            "error": "",
        }

    fetch_error = ""
    payload = None
    try:
        payload, _status_code = api_client.get_sender_configurations(config=config)
    except ApiClientError as exc:
        fetch_error = exc.message or "Unable to load sender configurations from API."

    if payload is not None:
        raw_records = extract_sender_config_records(payload)
        normalized_rows = []
        for index, raw_item in enumerate(raw_records, start=1):
            normalized = normalize_sender_config_record(raw_item, fallback_id=index)
            if normalized is not None:
                normalized_rows.append(normalized)

        fetched_at = time.time()
        _write_cached_sender_configurations(
            normalized_rows,
            {"fetched_at": fetched_at, "last_error": "", "source": "live"},
            config,
        )
        return apply_filters(normalized_rows), {
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
        _write_cached_sender_configurations(cached_items, stale_meta, config)
        return apply_filters(cached_items), {
            "source": "cache",
            "used_stale": True,
            "last_updated": stale_meta["fetched_at"],
            "error": stale_meta["last_error"],
        }

    return [], {
        "source": "error",
        "used_stale": False,
        "last_updated": 0.0,
        "error": fetch_error or "No sender configurations are currently available.",
    }


def build_settings_view_model(config, force_refresh=False):
    sender_configs, fetch_meta = fetch_sender_configurations(config=config, force_refresh=force_refresh)

    if fetch_meta["source"] == "live":
        status_level = "success"
        status_title = "Sender Config Synced"
        status_message = "Showing latest sender configurations from API."
    elif fetch_meta["source"] == "cache" and fetch_meta["used_stale"]:
        status_level = "warning"
        status_title = "Using Cached Sender Config"
        status_message = fetch_meta["error"] or "Live sender config API unavailable. Showing latest cached data."
    elif fetch_meta["source"] == "cache":
        status_level = "info"
        status_title = "Using Cached Snapshot"
        status_message = "Showing a recently cached sender configuration snapshot."
    else:
        status_level = "error"
        status_title = "Sender Config Unavailable"
        status_message = fetch_meta["error"] or "Unable to load sender configurations."

    return {
        "sender_configs": sender_configs,
        "sender_config_count": len(sender_configs),
        "data_status": {
            "level": status_level,
            "title": status_title,
            "message": status_message,
            "last_updated": format_cache_timestamp(fetch_meta.get("last_updated")),
        },
        "fetch_meta": fetch_meta,
    }
