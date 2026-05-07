from flask import current_app, render_template

from app.services.reports import build_reports_view_model


def reports_page():
    return render_template("reports.html", **build_reports_view_model(current_app.config))


def register_reports_routes(app):
    app.add_url_rule("/reports", view_func=reports_page, endpoint="reports")
