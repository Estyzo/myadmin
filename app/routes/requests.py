from flask import current_app, jsonify, render_template

from app.services.request_feed import fetch_requests
from app.services.shared import is_fragment_request


def api_getrequests():
    response_payload, status_code = fetch_requests(current_app.config)
    return jsonify(response_payload), status_code


def requests_page():
    template_name = "partials/requests_content.html" if is_fragment_request() else "requests.html"
    return render_template(template_name)


def register_requests_routes(app):
    app.add_url_rule("/api/getrequests", view_func=api_getrequests, endpoint="api_getrequests")
    app.add_url_rule("/requests", view_func=requests_page, endpoint="requests")
