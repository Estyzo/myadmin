from flask import current_app, jsonify, render_template, request

from app.services.transfers import get_active_sender_numbers, submit_send_money_request


def api_send_money():
    payload = request.get_json(silent=True) or {}
    response_payload, status_code = submit_send_money_request(current_app.config, payload)
    return jsonify(response_payload), status_code


def send_money():
    sender_numbers = get_active_sender_numbers(current_app.config)
    return render_template("send_money.html", sender_numbers=sender_numbers)


def register_send_money_routes(app):
    app.add_url_rule("/api/send-money", view_func=api_send_money, endpoint="api_send_money", methods=["POST"])
    app.add_url_rule("/send-money", view_func=send_money, endpoint="send_money")
