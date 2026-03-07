import csv
import io
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from flask import Response, current_app

from app.clients.api_client import ApiClientError, api_client
from app.extensions import cache
from app.services.shared import (
    build_daily_metric_window,
    build_export_filename,
    build_simple_pdf,
    build_stat_trend_payload,
    format_cache_timestamp,
    format_currency_amount,
    format_timestamp,
    get_app_timezone,
    is_truthy_flag,
    normalize_per_page,
    normalize_period,
    normalize_sort,
    paginate_items,
    parse_amount_value,
    parse_timestamp,
)


TRANSACTION_CACHE_KEY = "dashboard:transactions:all"
TRANSACTION_META_KEY = "dashboard:transactions:all:meta"
TRANSACTION_REFRESH_LOCK_KEY = "dashboard:transactions:refreshing"
TRANSACTION_REFRESH_STATE = {"running": False, "started_at": 0.0}
TRANSACTION_REFRESH_LOCK = threading.Lock()


def parse_dashboard_request_params(args):
    try:
        page = int(args.get("page", "1"))
    except (TypeError, ValueError):
        page = 1

    return {
        "period": normalize_period(args.get("period", "today")),
        "search_query": args.get("q", ""),
        "operator_filter": args.get("operator", ""),
        "operation_filter": args.get("operation", ""),
        "sort_by": args.get("sort_by", "date"),
        "sort_dir": args.get("sort_dir", "desc"),
        "page": page if page > 0 else 1,
        "per_page": normalize_per_page(args.get("per_page", 15)),
        "force_refresh": is_truthy_flag(args.get("refresh", "0")),
        "include_filtered_transactions": is_truthy_flag(args.get("include_filtered", "0")),
    }


def apply_transaction_filters(transactions, search_query="", operator_filter="", operation_filter=""):
    search_term = (search_query or "").strip().lower()
    operator_term = (operator_filter or "").strip().lower()
    operation_term = (operation_filter or "").strip().lower()
    filtered = []

    for transaction in transactions:
        if operator_term and transaction.get("operator_key", "") != operator_term:
            continue
        if operation_term and transaction.get("operation_key", "") != operation_term:
            continue
        if search_term and search_term not in transaction.get("search_text", ""):
            continue
        filtered.append(transaction)

    return filtered


def sort_transactions(transactions, sort_by, sort_dir):
    normalized_by, normalized_dir = normalize_sort(sort_by, sort_dir)
    reverse = normalized_dir == "desc"

    if normalized_by == "amount":
        key_fn = lambda tx: tx.get("amount_value") if tx.get("amount_value") is not None else -1.0
    elif normalized_by == "operator":
        key_fn = lambda tx: tx.get("operator_key", "")
    else:
        key_fn = lambda tx: tx.get("created_at_sort", 0.0)

    return sorted(transactions, key=key_fn, reverse=reverse), normalized_by, normalized_dir


def _cache_timeout(config):
    return config.get("DASHBOARD_CACHE_TTL", config.get("TRANSACTION_CACHE_TTL_SECONDS", 180))


def _refresh_lock_timeout(config):
    return config.get("DASHBOARD_REFRESH_LOCK_TTL", 120)


def _read_cached_transactions():
    items = cache.get(TRANSACTION_CACHE_KEY) or []
    meta = cache.get(TRANSACTION_META_KEY) or {"fetched_at": 0.0, "last_error": "", "source": "none"}
    return list(items), dict(meta)


def _write_cached_transactions(items, meta, config):
    timeout = _cache_timeout(config)
    cache.set(TRANSACTION_CACHE_KEY, list(items), timeout=timeout)
    cache.set(TRANSACTION_META_KEY, dict(meta), timeout=timeout)


def _is_refresh_locked():
    return bool(cache.get(TRANSACTION_REFRESH_LOCK_KEY))


def _mark_refresh_locked(config):
    if _is_refresh_locked():
        return False
    cache.set(TRANSACTION_REFRESH_LOCK_KEY, True, timeout=_refresh_lock_timeout(config))
    return True


def _clear_refresh_locked():
    cache.delete(TRANSACTION_REFRESH_LOCK_KEY)


def fetch_transactions(config, page=1, page_size=15):
    try:
        payload, _status_code = api_client.get_transactions_page(page=page, page_size=page_size, config=config)
    except ApiClientError:
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
        created_value = item.get("created_date") or item.get("created_at")
        created_dt = parse_timestamp(created_value)
        created_date_value = created_dt.astimezone(get_app_timezone()).date() if created_dt else None
        operator_value = item.get("operator") or "-"
        operation_value = item.get("operation") or "-"
        created_by_value = item.get("created_by") or "-"
        sender_number = item.get("normalizedPhone") or "-"
        receiver_number = item.get("receiverPhone") or "-"
        created_label = format_timestamp(created_value)
        operator_key = str(operator_value).strip().lower()
        operation_key = str(operation_value).strip().lower()
        amount_label = "-" if amount_value is None else format_currency_amount(amount_value, currency)

        transactions.append(
            {
                "id": item.get("id", "-"),
                "sender_number": sender_number,
                "receiver_number": receiver_number,
                "operator": operator_value,
                "operator_key": operator_key,
                "operation": operation_value,
                "operation_key": operation_key,
                "amount": amount_label,
                "amount_value": amount_value,
                "status": (item.get("status") or "UNKNOWN").upper(),
                "created_by": created_by_value,
                "created_at": created_label,
                "created_at_date": created_date_value.isoformat() if created_date_value else "",
                "created_date_value": created_date_value,
                "created_at_sort": created_dt.timestamp() if created_dt else 0.0,
                "is_sent": operation_key in {"transfer", "sent"},
                "is_received": operation_key in {"received", "receive"},
                "search_text": " ".join(
                    [
                        str(sender_number),
                        str(receiver_number),
                        str(operator_value),
                        str(operation_value),
                        str(amount_label),
                        str(created_by_value),
                        str(created_label),
                    ]
                ).lower(),
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


def fetch_all_transactions_live(config, page_size=100, max_pages=200):
    all_transactions = []
    fetch_error = ""
    fetch_completed = False

    first_page_transactions, first_page_pagination = fetch_transactions(config=config, page=1, page_size=page_size)
    if not first_page_transactions and first_page_pagination.get("total", 0) == 0:
        return [], {
            "source": "error",
            "used_stale": False,
            "refreshing": False,
            "last_updated": 0.0,
            "error": "Unable to load live transaction data right now.",
        }

    all_transactions.extend(first_page_transactions)
    total_pages = min(first_page_pagination.get("total_pages", 0) or 0, max_pages)

    if total_pages <= 1:
        fetch_completed = True
    else:
        page_results = {1: first_page_transactions}
        worker_count = min(config.get("TRANSACTION_FETCH_WORKERS", 6), max(1, total_pages - 1))

        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            future_to_page = {
                executor.submit(fetch_transactions, config=config, page=page_number, page_size=page_size): page_number
                for page_number in range(2, total_pages + 1)
            }
            for future in as_completed(future_to_page):
                try:
                    page_transactions, pagination = future.result()
                except Exception:
                    fetch_error = "Transaction API returned an incomplete response."
                    break

                if not page_transactions:
                    fetch_error = "Transaction API returned an incomplete response."
                    break

                page_results[future_to_page[future]] = page_transactions
                if pagination.get("page") and pagination["page"] > max_pages:
                    fetch_error = "Transaction API exceeded the allowed page limit."
                    break

        if not fetch_error and len(page_results) == total_pages:
            all_transactions = []
            for page_number in range(1, total_pages + 1):
                all_transactions.extend(page_results.get(page_number, []))
            fetch_completed = True

    if all_transactions and fetch_completed and not fetch_error:
        fetched_at = time.time()
        _write_cached_transactions(
            all_transactions,
            {"fetched_at": fetched_at, "last_error": "", "source": "live"},
            config,
        )
        return all_transactions, {
            "source": "live",
            "used_stale": False,
            "refreshing": False,
            "last_updated": fetched_at,
            "error": "",
        }

    cached_items, cached_meta = _read_cached_transactions()
    if cached_items:
        stale_meta = {
            "fetched_at": cached_meta.get("fetched_at", 0.0),
            "last_error": fetch_error or cached_meta.get("last_error", ""),
            "source": "stale_cache",
        }
        _write_cached_transactions(cached_items, stale_meta, config)
        return cached_items, {
            "source": "cache",
            "used_stale": True,
            "refreshing": False,
            "last_updated": stale_meta["fetched_at"],
            "error": stale_meta["last_error"],
        }

    return all_transactions, {
        "source": "error",
        "used_stale": False,
        "refreshing": False,
        "last_updated": 0.0,
        "error": fetch_error or "No transaction data is currently available.",
    }


def refresh_transaction_cache_async(config, page_size=100, max_pages=200):
    def _refresh():
        try:
            warm_dashboard_cache(config=config, page_size=page_size, max_pages=max_pages)
        finally:
            with TRANSACTION_REFRESH_LOCK:
                TRANSACTION_REFRESH_STATE["running"] = False

    if not _mark_refresh_locked(config):
        return False

    used_celery = False
    if config.get("USE_CELERY_CACHE_WARMING"):
        try:
            celery_app = current_app.extensions.get("celery")
        except RuntimeError:
            celery_app = None

        if celery_app is not None and hasattr(celery_app, "send_task"):
            try:
                celery_app.send_task("transferflow.cache.warm_dashboard")
                used_celery = True
                return True
            except Exception:
                _clear_refresh_locked()

    if not used_celery and not _is_refresh_locked():
        _mark_refresh_locked(config)

    with TRANSACTION_REFRESH_LOCK:
        if TRANSACTION_REFRESH_STATE["running"]:
            return True
        TRANSACTION_REFRESH_STATE["running"] = True
        TRANSACTION_REFRESH_STATE["started_at"] = time.time()

    try:
        thread = threading.Thread(target=_refresh, daemon=True, name="dashboard-cache-refresh")
        thread.start()
        return True
    except Exception:
        with TRANSACTION_REFRESH_LOCK:
            TRANSACTION_REFRESH_STATE["running"] = False
            TRANSACTION_REFRESH_STATE["started_at"] = 0.0
        _clear_refresh_locked()
        return False


def fetch_all_transactions(config, page_size=100, max_pages=200, force_refresh=False):
    now = time.time()
    cached_items, cached_meta = _read_cached_transactions()
    with TRANSACTION_REFRESH_LOCK:
        refresh_running = TRANSACTION_REFRESH_STATE["running"] or _is_refresh_locked()

    cache_is_fresh = bool(cached_items) and (now - float(cached_meta.get("fetched_at", 0.0))) < _cache_timeout(config)
    if cache_is_fresh and not force_refresh:
        return cached_items, {
            "source": "cache",
            "used_stale": False,
            "refreshing": refresh_running,
            "last_updated": cached_meta.get("fetched_at", 0.0),
            "error": "",
        }

    if cached_items and not force_refresh:
        started_refresh = refresh_running or refresh_transaction_cache_async(config=config, page_size=page_size, max_pages=max_pages)
        return cached_items, {
            "source": "cache",
            "used_stale": True,
            "refreshing": started_refresh,
            "last_updated": cached_meta.get("fetched_at", 0.0),
            "error": cached_meta.get("last_error", ""),
        }

    return fetch_all_transactions_live(config=config, page_size=page_size, max_pages=max_pages)


def warm_dashboard_cache(config):
    try:
        return fetch_all_transactions_live(config=config, page_size=100, max_pages=200)
    finally:
        _clear_refresh_locked()


def build_dashboard_data(
    config,
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

    all_transactions, fetch_meta = fetch_all_transactions(config=config, page_size=100, force_refresh=force_refresh)
    today_date = datetime.now(get_app_timezone()).date()
    scoped_transactions = []
    operator_values = set()
    operation_values = set()
    total_volume = 0.0
    sent_volume = 0.0
    received_volume = 0.0
    outgoing_transfers = 0
    incoming_transfers = 0
    latest_transaction_date = None

    for tx in all_transactions:
        tx_date_value = tx.get("created_date_value")
        if tx_date_value and (latest_transaction_date is None or tx_date_value > latest_transaction_date):
            latest_transaction_date = tx_date_value

        if normalized_period != "all" and tx.get("created_date_value") != today_date:
            continue

        scoped_transactions.append(tx)
        amount_value = tx.get("amount_value") or 0.0
        total_volume += amount_value

        if tx.get("is_sent"):
            outgoing_transfers += 1
            sent_volume += amount_value
        elif tx.get("is_received"):
            incoming_transfers += 1
            received_volume += amount_value

        operator_value = str(tx.get("operator", "")).strip()
        operation_value = str(tx.get("operation", "")).strip()
        if operator_value and operator_value != "-":
            operator_values.add(operator_value)
        if operation_value and operation_value != "-":
            operation_values.add(operation_value)

    period_suffix = "ALL TIME" if normalized_period == "all" else "TODAY"
    daily_metrics = build_daily_metric_window(all_transactions, days=7)
    comparison_suffix = "vs yesterday"

    if normalized_period == "today":
        total_delta_current = total_volume
        sent_delta_current = sent_volume
        received_delta_current = received_volume
    else:
        total_delta_current = daily_metrics["today"]["total"]
        sent_delta_current = daily_metrics["today"]["sent"]
        received_delta_current = daily_metrics["today"]["received"]

    total_previous = daily_metrics["yesterday"]["total"]
    sent_previous = daily_metrics["yesterday"]["sent"]
    received_previous = daily_metrics["yesterday"]["received"]

    operator_options = sorted(operator_values, key=str.casefold)
    operation_options = sorted(operation_values, key=str.casefold)

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
    paged_transactions, pagination = paginate_items(sorted_transactions, page=current_page, per_page=rows_per_page)

    if fetch_meta["source"] == "live":
        status_level = "success"
        status_title = "Data Synced"
        status_message = "Live transaction data is up to date."
        if normalized_period == "today" and not scoped_transactions:
            status_level = "info"
            status_title = "No Transactions For Today"
            today_label = today_date.strftime("%d %b %Y")
            if latest_transaction_date and latest_transaction_date < today_date:
                latest_label = latest_transaction_date.strftime("%d %b %Y")
                status_message = (
                    f"Live data loaded successfully, but the latest transaction is from {latest_label}. "
                    f"There are no transactions dated {today_label} yet."
                )
            else:
                status_message = f"Live data loaded successfully, but there are no transactions dated {today_label} yet."
    elif fetch_meta["source"] == "cache" and fetch_meta["used_stale"]:
        if fetch_meta.get("refreshing"):
            status_level = "info"
            status_title = "Refreshing In Background"
            status_message = "Showing cached dashboard data while a live refresh runs in the background."
        else:
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

    return {
        "period": normalized_period,
        "per_page": rows_per_page,
        "per_page_options": [15, 30, 50],
        "fetch_meta": {
            "source": fetch_meta["source"],
            "used_stale": fetch_meta["used_stale"],
            "refreshing": fetch_meta.get("refreshing", False),
            "last_updated": fetch_meta.get("last_updated", 0.0),
            "last_updated_label": format_cache_timestamp(fetch_meta.get("last_updated")),
            "error": fetch_meta.get("error", ""),
        },
        "filters": {"q": cleaned_search, "operator": cleaned_operator, "operation": cleaned_operation},
        "operator_options": operator_options,
        "operation_options": operation_options,
        "transactions": paged_transactions,
        "filtered_transactions": sorted_transactions,
        "pagination": pagination,
        "sort": {"by": normalized_sort_by, "dir": normalized_sort_dir},
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
            "outgoing_transfers": outgoing_transfers,
            "incoming_transfers": incoming_transfers,
            "total_trend": build_stat_trend_payload(total_delta_current, total_previous, daily_metrics["series"]["total"], comparison_suffix),
            "sent_trend": build_stat_trend_payload(sent_delta_current, sent_previous, daily_metrics["series"]["sent"], comparison_suffix),
            "received_trend": build_stat_trend_payload(received_delta_current, received_previous, daily_metrics["series"]["received"], comparison_suffix),
        },
    }


def build_dashboard_api_payload(config, include_filtered_transactions=False, **params):
    dashboard_data = build_dashboard_data(config=config, **params)
    response_data = {
        "period": dashboard_data["period"],
        "per_page": dashboard_data["per_page"],
        "per_page_options": dashboard_data["per_page_options"],
        "filters": dashboard_data["filters"],
        "operator_options": dashboard_data["operator_options"],
        "operation_options": dashboard_data["operation_options"],
        "transactions": dashboard_data["transactions"],
        "pagination": dashboard_data["pagination"],
        "sort": dashboard_data["sort"],
        "data_status": dashboard_data["data_status"],
        "stats": dashboard_data["stats"],
    }
    if include_filtered_transactions:
        response_data["filtered_transactions"] = dashboard_data["filtered_transactions"]

    return {
        "ok": True,
        "data": response_data,
        "meta": {
            "contract_version": "2026-03-06",
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source": dashboard_data["fetch_meta"]["source"],
            "used_stale": dashboard_data["fetch_meta"]["used_stale"],
            "refreshing": dashboard_data["fetch_meta"]["refreshing"],
            "last_updated": dashboard_data["fetch_meta"]["last_updated"],
            "last_updated_label": dashboard_data["fetch_meta"]["last_updated_label"],
            "error": dashboard_data["fetch_meta"]["error"],
        },
    }


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
