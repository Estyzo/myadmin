from flask import current_app, jsonify, render_template

from app.services.balance import build_balance_payload
from app.services.shared import is_fragment_request


def api_balance_data():
    payload = build_balance_payload(current_app.config)
    http_status = 200 if payload.get("ok", True) else 502
    return jsonify(payload), http_status


def balance():
    payload = build_balance_payload(current_app.config)
    template_name = "partials/balance_content.html" if is_fragment_request() else "balance.html"
    return render_template(
        template_name,
        balances=payload["data"],
        data_status={
            "level": "success" if payload.get("ok") else "error",
            "title": "Live balances" if payload.get("ok") else "Balance sync failed",
            "message": "Latest balance per operator." if payload.get("ok") else payload["meta"].get("error", "Unable to load balances."),
            "last_updated": payload["meta"].get("last_updated", "-"),
        },
        meta=payload["meta"],
    )


def register_balance_routes(app):
    app.add_url_rule("/api/balance-data", view_func=api_balance_data, endpoint="api_balance_data")
    app.add_url_rule("/balance", view_func=balance, endpoint="balance")
