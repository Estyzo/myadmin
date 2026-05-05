from flask import current_app, jsonify, render_template, request

from app.services.transfers import (
    get_active_sender_options,
    poll_transfer_approval_status,
    submit_send_money_request,
    submit_transfer_approval_decision,
)
from app.services.shared import is_fragment_request


def api_send_money():
    payload = request.get_json(silent=True) or {}
    response_payload, status_code = submit_send_money_request(current_app.config, payload)
    return jsonify(response_payload), status_code


def api_send_money_approval_status():
    payload = request.get_json(silent=True) or {}
    response_payload, status_code = poll_transfer_approval_status(current_app.config, payload)
    return jsonify(response_payload), status_code


def api_send_money_approval_decision():
    payload = request.get_json(silent=True) or {}
    response_payload, status_code = submit_transfer_approval_decision(current_app.config, payload)
    return jsonify(response_payload), status_code


def send_money():
    sender_options = get_active_sender_options(current_app.config)
    template_name = "partials/send_money_content.html" if is_fragment_request() else "send_money.html"
    return render_template(template_name, sender_options=sender_options)


def recent_transfers():
    template_name = "partials/recent_transfers_content.html" if is_fragment_request() else "recent_transfers.html"
    return render_template(template_name)


def register_send_money_routes(app):
    app.add_url_rule("/api/send-money", view_func=api_send_money, endpoint="api_send_money", methods=["POST"])
    app.add_url_rule(
        "/api/send-money/approval-status",
        view_func=api_send_money_approval_status,
        endpoint="api_send_money_approval_status",
        methods=["POST"],
    )
    app.add_url_rule(
        "/api/send-money/approval-decision",
        view_func=api_send_money_approval_decision,
        endpoint="api_send_money_approval_decision",
        methods=["POST"],
    )
    app.add_url_rule("/send-money", view_func=send_money, endpoint="send_money")
    app.add_url_rule("/recent-transfers", view_func=recent_transfers, endpoint="recent_transfers")
