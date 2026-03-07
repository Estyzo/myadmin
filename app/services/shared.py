import csv
import io
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from flask import current_app, request


_APP_CONFIG = {}


def init_service_config(app):
    _APP_CONFIG.clear()
    _APP_CONFIG.update(app.config)


def get_runtime_config():
    try:
        return current_app.config
    except RuntimeError:
        return _APP_CONFIG


def get_app_timezone():
    tz_name = get_runtime_config().get("APP_TIMEZONE", "UTC")
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return timezone.utc


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


def parse_flexible_timestamp(value):
    parsed = parse_timestamp(value)
    if parsed is not None:
        return parsed.astimezone(get_app_timezone())

    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None

    try:
        numeric_value = float(text)
        if numeric_value > 10**12:
            numeric_value /= 1000.0
        return datetime.fromtimestamp(numeric_value, tz=get_app_timezone())
    except (TypeError, ValueError, OSError):
        pass

    common_formats = (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%m/%d/%Y %H:%M:%S",
        "%m/%d/%Y %H:%M",
        "%Y-%m-%d",
    )
    for pattern in common_formats:
        try:
            parsed_dt = datetime.strptime(text, pattern)
            return parsed_dt.replace(tzinfo=get_app_timezone())
        except ValueError:
            continue
    return None


def parse_date_filter(value):
    text = (value or "").strip()
    if not text:
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        return None


def normalize_message_text(value, fallback="-"):
    if value is None:
        return fallback
    text = str(value).strip()
    return text if text else fallback


def pick_first_available(item, keys, fallback="-"):
    if not isinstance(item, dict):
        return fallback
    for key in keys:
        value = item.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return fallback


def paginate_items(items, page, per_page):
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


def normalize_period(value):
    normalized = (value or "today").strip().lower()
    return normalized if normalized in {"today", "all"} else "today"


def normalize_per_page(value):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 15
    return parsed if parsed in {15, 30, 50} else 15


def is_truthy_flag(value):
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def normalize_sort(sort_by, sort_dir):
    normalized_by = (sort_by or "date").strip().lower()
    if normalized_by not in {"date", "amount", "operator"}:
        normalized_by = "date"

    normalized_dir = (sort_dir or "").strip().lower()
    if normalized_dir not in {"asc", "desc"}:
        normalized_dir = "desc" if normalized_by in {"date", "amount"} else "asc"

    return normalized_by, normalized_dir


def format_cache_timestamp(timestamp_value):
    if not timestamp_value:
        return "-"
    try:
        parsed = datetime.fromtimestamp(float(timestamp_value), tz=get_app_timezone())
    except (TypeError, ValueError, OSError):
        return "-"
    return parsed.strftime("%d %b %Y, %I:%M:%S %p")


def build_daily_metric_window(transactions, days=7):
    tz = get_app_timezone()
    today = datetime.now(tz).date()
    start_date = today - timedelta(days=days - 1)
    day_keys = [(start_date + timedelta(days=offset)).isoformat() for offset in range(days)]

    buckets = {key: {"total": 0.0, "sent": 0.0, "received": 0.0} for key in day_keys}

    for tx in transactions:
        day_key = tx.get("created_at_date")
        if day_key not in buckets:
            continue
        amount = tx.get("amount_value") or 0.0
        buckets[day_key]["total"] += amount
        if tx.get("is_sent"):
            buckets[day_key]["sent"] += amount
        elif tx.get("is_received"):
            buckets[day_key]["received"] += amount

    series = {"total": [], "sent": [], "received": []}
    for key in day_keys:
        for metric_name in series:
            series[metric_name].append(buckets[key][metric_name])

    return {
        "series": series,
        "today": {metric_name: values[-1] if values else 0.0 for metric_name, values in series.items()},
        "yesterday": {metric_name: values[-2] if len(values) > 1 else 0.0 for metric_name, values in series.items()},
    }


def build_sparkline_points(values, width=96.0, height=24.0):
    numeric_values = [float(value or 0.0) for value in values]
    if not numeric_values:
        return f"0,{height / 2:.2f} {width:.2f},{height / 2:.2f}"
    if len(numeric_values) == 1:
        y_pos = height / 2
        return f"0,{y_pos:.2f} {width:.2f},{y_pos:.2f}"

    min_value = min(numeric_values)
    max_value = max(numeric_values)
    value_span = max_value - min_value
    step_x = width / (len(numeric_values) - 1)
    points = []

    for index, value in enumerate(numeric_values):
        x_pos = step_x * index
        y_pos = height / 2 if value_span <= 0 else height - (((value - min_value) / value_span) * height)
        points.append(f"{x_pos:.2f},{y_pos:.2f}")
    return " ".join(points)


def build_delta_context(current_value, previous_value, comparison_suffix):
    current = float(current_value or 0.0)
    previous = float(previous_value or 0.0)

    if previous <= 0:
        delta_percent = 100.0 if current > 0 else 0.0
    else:
        delta_percent = ((current - previous) / previous) * 100.0

    if abs(delta_percent) < 0.05:
        delta_percent = 0.0

    if delta_percent > 0:
        direction = "up"
    elif delta_percent < 0:
        direction = "down"
    else:
        direction = "flat"

    return {"direction": direction, "text": f"{delta_percent:+.1f}% {comparison_suffix}"}


def build_stat_trend_payload(current_value, previous_value, sparkline_values, comparison_suffix):
    delta = build_delta_context(current_value, previous_value, comparison_suffix)
    return {
        "delta_direction": delta["direction"],
        "delta_text": delta["text"],
        "sparkline_points": build_sparkline_points(sparkline_values),
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
    pages = [normalized_lines[index : index + lines_per_page] for index in range(0, len(normalized_lines), lines_per_page)]

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
                stream_lines.extend(["T*", f"({escaped}) Tj"])
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


def export_rows_as_csv(rows, header, row_builder, filename):
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(header)
    for row in rows:
        writer.writerow(row_builder(row))
    return output.getvalue(), filename


def is_fragment_request():
    return request.headers.get("X-Requested-With") == "XMLHttpRequest"
