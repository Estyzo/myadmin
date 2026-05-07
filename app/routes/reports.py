import csv
import io

from flask import Response, current_app, render_template, request

from app.services.reports import build_reports_view_model


def reports_page():
    return render_template("reports.html", **build_reports_view_model(current_app.config, filters=request.args))


def csv_response(filename, headers, rows):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(headers)
    for row in rows:
        writer.writerow([row.get(header, "") for header in headers])
    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


def export_reports():
    section = str(request.args.get("section", "all") or "all").strip().lower()
    view_model = build_reports_view_model(current_app.config, filters=request.args)
    if section == "transactions":
        headers = ["id", "created_at", "operator", "operation", "sender_number", "receiver_number", "amount", "created_by", "note"]
        return csv_response("reports-transactions.csv", headers, view_model["transactions"])
    if section == "commissions":
        headers = ["id", "source_type", "source_name", "amount", "commission_date", "reference", "note", "created_at"]
        return csv_response("reports-commissions.csv", headers, view_model["commissions"])
    if section == "assets":
        headers = ["id", "asset_name", "asset_tag", "category", "purchase_date", "purchase_value", "assigned_to", "location", "status", "note", "created_at"]
        return csv_response("reports-assets.csv", headers, view_model["assets"])
    if section == "loans":
        headers = ["id", "borrower_name", "amount", "issued_date", "due_date", "status", "paid_at", "reference", "note", "created_at"]
        return csv_response("reports-loans.csv", headers, view_model["loans"])

    rows = []
    for row in view_model["transactions"]:
        rows.append({"type": "transaction", "name": row.get("operation"), "source": row.get("operator"), "date": row.get("created_at"), "amount": row.get("amount_value"), "status": row.get("created_by"), "reference": row.get("id")})
    for row in view_model["commissions"]:
        rows.append({"type": "commission", "name": row.get("source_name"), "source": row.get("source_type"), "date": row.get("commission_date"), "amount": row.get("amount"), "status": "", "reference": row.get("reference")})
    for row in view_model["assets"]:
        rows.append({"type": "asset", "name": row.get("asset_name"), "source": row.get("asset_tag"), "date": row.get("purchase_date"), "amount": row.get("purchase_value"), "status": row.get("status"), "reference": row.get("location")})
    for row in view_model["loans"]:
        rows.append({"type": "loan", "name": row.get("borrower_name"), "source": row.get("reference"), "date": row.get("issued_date"), "amount": row.get("amount"), "status": row.get("status"), "reference": row.get("due_date")})
    return csv_response("reports-combined.csv", ["type", "name", "source", "date", "amount", "status", "reference"], rows)


def register_reports_routes(app):
    app.add_url_rule("/reports", view_func=reports_page, endpoint="reports")
    app.add_url_rule("/reports/export", view_func=export_reports, endpoint="export_reports")
