from app.services.dashboard import build_dashboard_data
from app.services.operations import (
    ASSET_STATUSES,
    BANK_COMMISSION_SOURCES,
    MOBILE_COMMISSION_SOURCES,
    clean_filters,
    in_date_range,
    list_rows,
    row_matches_search,
    sum_amount,
)


def transaction_matches_filters(row, filters):
    query = filters.get("q", "")
    if query:
        haystack = " ".join(
            str(row.get(key, "") or "")
            for key in ("operator", "operation", "sender_number", "receiver_number", "amount", "created_by", "note")
        ).casefold()
        if query.casefold() not in haystack:
            return False
    date_value = row.get("created_date_value")
    date_text = date_value.isoformat() if hasattr(date_value, "isoformat") else str(date_value or "")[:10]
    return in_date_range(date_text, filters)


def apply_report_filters(transactions, commissions, assets, filters):
    query = filters.get("q", "")
    filtered_transactions = [row for row in transactions if transaction_matches_filters(row, filters)]
    filtered_commissions = [
        row for row in commissions
        if row_matches_search(row, query)
        and in_date_range(row.get("commission_date"), filters)
        and (not filters.get("commission_type") or row.get("source_type") == filters.get("commission_type"))
        and (not filters.get("commission_source") or row.get("source_name") == filters.get("commission_source"))
    ]
    filtered_assets = [
        row for row in assets
        if row_matches_search(row, query)
        and in_date_range(row.get("purchase_date"), filters)
        and (not filters.get("asset_status") or row.get("status") == filters.get("asset_status"))
    ]
    return filtered_transactions, filtered_commissions, filtered_assets


def build_reports_view_model(config=None, filters=None):
    active_filters = clean_filters(filters)
    dashboard_data = build_dashboard_data(
        config=config,
        period="all",
        sort_by="date",
        sort_dir="desc",
        page=1,
        per_page=50,
        force_refresh=False,
    )
    transactions = dashboard_data.get("filtered_transactions", [])
    commissions = list_rows("commissions", config=config, limit=500)
    assets = list_rows("office_assets", config=config, limit=500)
    transactions, commissions, assets = apply_report_filters(transactions, commissions, assets, active_filters)
    active_assets = [asset for asset in assets if asset.get("status") == "active"]
    transaction_total = sum(float(item.get("amount_value") or 0) for item in transactions)
    commission_total = sum_amount(commissions)
    asset_total = sum_amount(active_assets)

    return {
        "transactions": transactions[:100],
        "commissions": commissions,
        "assets": assets,
        "filters": active_filters,
        "mobile_sources": MOBILE_COMMISSION_SOURCES,
        "bank_sources": BANK_COMMISSION_SOURCES,
        "asset_statuses": ASSET_STATUSES,
        "summary": {
            "transaction_total": transaction_total,
            "transaction_count": len(transactions),
            "commission_total": commission_total,
            "commission_count": len(commissions),
            "asset_total": asset_total,
            "asset_count": len(assets),
            "active_asset_count": len(active_assets),
        },
        "data_status": dashboard_data.get("data_status", {}),
    }
