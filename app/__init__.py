import secrets

from flask import Flask, abort, request, send_from_directory, session

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

    @app.context_processor
    def inject_api_base_url():
        session.setdefault("csrf_token", secrets.token_urlsafe(32))
        return {
            "api_base_url": app.config["API_BASE_URL"],
            "sender_config_api_url": app.config["SENDER_CONFIG_API_URL"],
            "csrf_token": session["csrf_token"],
        }

    @app.before_request
    def protect_state_changing_requests():
        if request.method != "POST" or not str(request.endpoint or "").startswith("api_"):
            return None
        expected_token = session.get("csrf_token")
        provided_token = request.headers.get("X-CSRF-Token", "")
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
