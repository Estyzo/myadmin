from app.services.dashboard import build_dashboard_data
from app.services.operations import list_rows, sum_amount


def build_reports_view_model(config=None):
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
    active_assets = [asset for asset in assets if asset.get("status") == "active"]
    transaction_total = sum(float(item.get("amount_value") or 0) for item in transactions)
    commission_total = sum_amount(commissions)
    asset_total = sum_amount(active_assets)

    return {
        "transactions": transactions[:100],
        "commissions": commissions,
        "assets": assets,
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
