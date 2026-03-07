from flask import current_app, jsonify, redirect, render_template, request, url_for

from app.services.dashboard import (
    build_dashboard_api_payload,
    export_transactions_as_csv,
    export_transactions_as_pdf,
    parse_dashboard_request_params,
)
from app.services.shared import is_fragment_request


def api_dashboard_data():
    params = parse_dashboard_request_params(request.args)
    payload = build_dashboard_api_payload(current_app.config, **params)
    http_status = 200 if payload.get("ok", True) else 502
    return jsonify(payload), http_status


def dashboard():
    params = parse_dashboard_request_params(request.args)
    dashboard_payload = build_dashboard_api_payload(current_app.config, **params)
    dashboard_data = dashboard_payload["data"]
    template_name = "partials/dashboard_content.html" if is_fragment_request() else "dashboard.html"
    return render_template(
        template_name,
        stats=dashboard_data["stats"],
        transactions=dashboard_data["transactions"],
        pagination=dashboard_data["pagination"],
        period=dashboard_data["period"],
        per_page=dashboard_data["per_page"],
        per_page_options=dashboard_data["per_page_options"],
        filters=dashboard_data["filters"],
        sort=dashboard_data["sort"],
        data_status=dashboard_data["data_status"],
        operator_options=dashboard_data["operator_options"],
        operation_options=dashboard_data["operation_options"],
    )


def export_transactions(file_format):
    params = parse_dashboard_request_params(request.args)
    params["page"] = 1
    params["include_filtered_transactions"] = True
    dashboard_payload = build_dashboard_api_payload(current_app.config, **params)
    dashboard_data = dashboard_payload["data"]
    period = dashboard_data["period"]
    normalized_format = (file_format or "").strip().lower()

    if normalized_format == "csv":
        return export_transactions_as_csv(dashboard_data["filtered_transactions"], period)
    if normalized_format == "pdf":
        return export_transactions_as_pdf(dashboard_data["filtered_transactions"], period)

    return redirect(
        url_for(
            "dashboard",
            period=period,
            q=dashboard_data["filters"]["q"],
            operator=dashboard_data["filters"]["operator"],
            operation=dashboard_data["filters"]["operation"],
            sort_by=dashboard_data["sort"]["by"],
            sort_dir=dashboard_data["sort"]["dir"],
            per_page=dashboard_data["per_page"],
        )
    )


def healthz():
    return jsonify({"ok": True, "service": "transferflow-admin"}), 200


def register_dashboard_routes(app):
    app.add_url_rule("/healthz", view_func=healthz, endpoint="healthz")
    app.add_url_rule("/api/dashboard-data", view_func=api_dashboard_data, endpoint="api_dashboard_data")
    app.add_url_rule("/", view_func=dashboard, endpoint="root")
    app.add_url_rule("/dashboard", view_func=dashboard, endpoint="dashboard")
    app.add_url_rule("/dashboard/export/<string:file_format>", view_func=export_transactions, endpoint="export_transactions")
