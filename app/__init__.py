import secrets

from flask import Flask, abort, jsonify, redirect, request, send_from_directory, session, url_for

from app.clients.api_client import api_client
from app.config import build_config, load_environment
from app.extensions import cache, create_celery_app
from app.routes import register_routes
from app.services.shared import (
    init_service_config,
    mask_digit_sequence,
    mask_identifier,
    mask_message_preview,
    mask_name,
    mask_numeric_sequences,
)
from app.services.auth import (
    current_user,
    has_permission,
    init_auth_storage,
    is_fragment_or_json_request,
    is_public_endpoint,
    load_current_user,
    role_home_endpoint,
    user_permissions,
)
from app.services.operations import init_operations_storage


ENDPOINT_PERMISSIONS = {
    "root": "dashboard",
    "dashboard": "dashboard",
    "api_dashboard_data": "dashboard",
    "export_transactions": "exports",
    "send_money": "send_money",
    "api_send_money": "send_money",
    "api_send_money_approval_status": "send_money",
    "api_send_money_approval_decision": "send_money",
    "recent_transfers": "recent_transfers",
    "requests": "requests",
    "api_getrequests": "requests",
    "balance": "balance",
    "api_balance_data": "balance",
    "api_client_status": "balance",
    "messages": "messages",
    "settings": "settings",
    "api_sender_configurations": "settings",
    "api_sender_configuration_status": "settings",
    "operations": "operations",
    "export_operations": "operations",
    "reports": "reports",
    "export_reports": "reports",
    "create_expense_record": "operations",
    "create_commission_record": "operations",
    "create_asset_record": "operations",
    "update_asset_record_status": "operations",
    "create_loan_record": "operations",
    "mark_loan_record_paid": "operations",
    "users": "manage_users",
    "create_user_invite": "manage_users",
    "update_user": "manage_users",
    "toggle_user_status": "manage_users",
    "revoke_user_invite": "manage_users",
    "resend_user_invite": "manage_users",
}


def create_app():
    load_environment()
    app = Flask(
        __name__,
        instance_relative_config=True,
        template_folder="../templates",
        static_folder="../static",
        static_url_path="/static",
    )
    app.config.from_mapping(build_config())
    app.add_template_filter(mask_digit_sequence, "mask_digits")
    app.add_template_filter(mask_identifier, "mask_identifier")
    app.add_template_filter(mask_message_preview, "mask_message_preview")
    app.add_template_filter(mask_name, "mask_name")
    app.add_template_filter(mask_numeric_sequences, "mask_sensitive_numbers")

    cache.init_app(app)
    api_client.init_app(app)
    app.extensions["celery"] = create_celery_app(app)
    init_service_config(app)
    init_auth_storage(app)
    init_operations_storage(app)

    @app.context_processor
    def inject_api_base_url():
        session.setdefault("csrf_token", secrets.token_urlsafe(32))
        active_user = current_user()
        return {
            "api_base_url": app.config["API_BASE_URL"],
            "sender_config_api_url": app.config["SENDER_CONFIG_API_URL"],
            "csrf_token": session["csrf_token"],
            "current_user": active_user,
            "current_permissions": user_permissions(active_user),
        }

    @app.before_request
    def require_login_and_permission():
        load_current_user()
        if is_public_endpoint(request.endpoint):
            return None
        if not current_user():
            if is_fragment_or_json_request():
                return jsonify({"ok": False, "error": "Authentication required."}), 401
            return redirect(url_for("login"))
        required_permission = ENDPOINT_PERMISSIONS.get(request.endpoint)
        if required_permission and not has_permission(required_permission):
            if is_fragment_or_json_request():
                return jsonify({"ok": False, "error": "You do not have permission to access this resource."}), 403
            return redirect(url_for(role_home_endpoint()))
        return None

    @app.before_request
    def protect_state_changing_requests():
        if request.method != "POST" or request.endpoint in {"login", "accept_invite"}:
            return None
        expected_token = session.get("csrf_token")
        provided_token = request.headers.get("X-CSRF-Token", "") or request.form.get("csrf_token", "")
        if not expected_token or not secrets.compare_digest(expected_token, provided_token):
            abort(400, description="Invalid CSRF token.")
        return None

    @app.get("/service-worker.js")
    def service_worker():
        response = send_from_directory(
            app.static_folder,
            "service-worker.js",
            mimetype="application/javascript",
            max_age=0,
        )
        response.headers["Service-Worker-Allowed"] = "/"
        response.headers["Cache-Control"] = "no-cache"
        return response

    register_routes(app)
    return app


app = create_app()
