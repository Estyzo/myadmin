from flask import current_app, jsonify, render_template, request

from app.services.settings import build_settings_view_model, fetch_sender_configurations
from app.services.shared import format_cache_timestamp, is_fragment_request


def api_sender_configurations():
    force_refresh = str(request.args.get("refresh", "0")).strip().lower() in {"1", "true", "yes"}
    active_only = (request.args.get("active_only", "") or "").strip().lower() in {"1", "true", "yes"}
    sender_configs, fetch_meta = fetch_sender_configurations(
        config=current_app.config,
        active_only=active_only,
        force_refresh=force_refresh,
    )
    http_status = 200 if fetch_meta["source"] != "error" else 502
    return jsonify(
        {
            "data": sender_configs,
            "meta": {
                "source": fetch_meta["source"],
                "used_stale": fetch_meta["used_stale"],
                "last_updated": fetch_meta["last_updated"],
                "last_updated_label": format_cache_timestamp(fetch_meta["last_updated"]),
                "error": fetch_meta["error"],
                "active_only": active_only,
            },
        }
    ), http_status


def settings():
    force_refresh = str(request.args.get("refresh", "0")).strip().lower() in {"1", "true", "yes"}
    view_model = build_settings_view_model(current_app.config, force_refresh=force_refresh)
    template_name = "partials/settings_content.html" if is_fragment_request() else "settings.html"
    return render_template(template_name, **view_model)


def register_settings_routes(app):
    app.add_url_rule("/api/sender-configurations", view_func=api_sender_configurations, endpoint="api_sender_configurations")
    app.add_url_rule("/settings", view_func=settings, endpoint="settings")
