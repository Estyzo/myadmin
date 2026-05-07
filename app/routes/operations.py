import csv
import io

from flask import Response, current_app, redirect, render_template, request, url_for

from app.services.auth import current_user
from app.services.operations import (
    build_operations_view_model,
    create_asset,
    create_commission,
    create_expense,
    create_loan,
    mark_loan_paid,
    update_asset_status,
)


def operations_page():
    view_model = build_operations_view_model(current_app.config, filters=request.args)
    return render_template("operations.html", **view_model, notice="", error="")


def render_with_message(notice="", error=""):
    view_model = build_operations_view_model(current_app.config, filters=request.args)
    return render_template("operations.html", **view_model, notice=notice, error=error)


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


def export_operations():
    section = str(request.args.get("section", "expenses") or "expenses").strip().lower()
    view_model = build_operations_view_model(current_app.config, filters=request.args)
    export_map = {
        "expenses": (
            "operations-expenses.csv",
            ["id", "category", "amount", "paid_to", "payment_date", "reference", "note", "created_at"],
            view_model["expenses"],
        ),
        "commissions": (
            "operations-commissions.csv",
            ["id", "source_type", "source_name", "amount", "commission_date", "reference", "note", "created_at"],
            view_model["commissions"],
        ),
        "assets": (
            "operations-assets.csv",
            ["id", "asset_name", "asset_tag", "category", "purchase_date", "purchase_value", "assigned_to", "location", "status", "note", "created_at"],
            view_model["assets"],
        ),
        "loans": (
            "operations-loans.csv",
            ["id", "borrower_name", "amount", "issued_date", "due_date", "status", "paid_at", "reference", "note", "created_at"],
            view_model["loans"],
        ),
    }
    filename, headers, rows = export_map.get(section, export_map["expenses"])
    return csv_response(filename, headers, rows)


def create_expense_record():
    if not request.form.get("amount"):
        return render_with_message(error="Enter the expense amount."), 400
    create_expense(request.form, user_id=(current_user() or {}).get("id"), config=current_app.config)
    return render_with_message(notice="Expense recorded.")


def create_commission_record():
    if not request.form.get("amount"):
        return render_with_message(error="Enter the commission amount."), 400
    create_commission(request.form, user_id=(current_user() or {}).get("id"), config=current_app.config)
    return render_with_message(notice="Commission recorded.")


def create_asset_record():
    if not request.form.get("asset_name"):
        return render_with_message(error="Enter the asset name."), 400
    create_asset(request.form, user_id=(current_user() or {}).get("id"), config=current_app.config)
    return render_with_message(notice="Asset registered.")


def update_asset_record_status():
    update_asset_status(request.form.get("asset_id"), request.form.get("status"), config=current_app.config)
    return redirect(url_for("operations", tab="assets"))


def create_loan_record():
    if not request.form.get("borrower_name") or not request.form.get("amount"):
        return render_with_message(error="Enter borrower name and loan amount."), 400
    create_loan(request.form, user_id=(current_user() or {}).get("id"), config=current_app.config)
    return render_with_message(notice="Loan registered.")


def mark_loan_record_paid():
    mark_loan_paid(request.form.get("loan_id"), config=current_app.config)
    return redirect(url_for("operations", tab="loans"))


def register_operations_routes(app):
    app.add_url_rule("/operations", view_func=operations_page, endpoint="operations")
    app.add_url_rule("/operations/export", view_func=export_operations, endpoint="export_operations")
    app.add_url_rule("/operations/expenses", view_func=create_expense_record, endpoint="create_expense_record", methods=["POST"])
    app.add_url_rule("/operations/commissions", view_func=create_commission_record, endpoint="create_commission_record", methods=["POST"])
    app.add_url_rule("/operations/assets", view_func=create_asset_record, endpoint="create_asset_record", methods=["POST"])
    app.add_url_rule("/operations/assets/status", view_func=update_asset_record_status, endpoint="update_asset_record_status", methods=["POST"])
    app.add_url_rule("/operations/loans", view_func=create_loan_record, endpoint="create_loan_record", methods=["POST"])
    app.add_url_rule("/operations/loans/paid", view_func=mark_loan_record_paid, endpoint="mark_loan_record_paid", methods=["POST"])
