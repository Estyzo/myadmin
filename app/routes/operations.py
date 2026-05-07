from flask import current_app, redirect, render_template, request, url_for

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
    view_model = build_operations_view_model(current_app.config)
    return render_template("operations.html", **view_model, notice="", error="")


def render_with_message(notice="", error=""):
    view_model = build_operations_view_model(current_app.config)
    return render_template("operations.html", **view_model, notice=notice, error=error)


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
    return redirect(url_for("operations"))


def create_loan_record():
    if not request.form.get("borrower_name") or not request.form.get("amount"):
        return render_with_message(error="Enter borrower name and loan amount."), 400
    create_loan(request.form, user_id=(current_user() or {}).get("id"), config=current_app.config)
    return render_with_message(notice="Loan registered.")


def mark_loan_record_paid():
    mark_loan_paid(request.form.get("loan_id"), config=current_app.config)
    return redirect(url_for("operations"))


def register_operations_routes(app):
    app.add_url_rule("/operations", view_func=operations_page, endpoint="operations")
    app.add_url_rule("/operations/expenses", view_func=create_expense_record, endpoint="create_expense_record", methods=["POST"])
    app.add_url_rule("/operations/commissions", view_func=create_commission_record, endpoint="create_commission_record", methods=["POST"])
    app.add_url_rule("/operations/assets", view_func=create_asset_record, endpoint="create_asset_record", methods=["POST"])
    app.add_url_rule("/operations/assets/status", view_func=update_asset_record_status, endpoint="update_asset_record_status", methods=["POST"])
    app.add_url_rule("/operations/loans", view_func=create_loan_record, endpoint="create_loan_record", methods=["POST"])
    app.add_url_rule("/operations/loans/paid", view_func=mark_loan_record_paid, endpoint="mark_loan_record_paid", methods=["POST"])
