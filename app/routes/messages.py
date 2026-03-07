from flask import current_app, render_template, request

from app.services.messages import build_messages_view_model
from app.services.shared import is_fragment_request


def messages():
    view_model = build_messages_view_model(current_app.config, request.args)
    template_name = "partials/messages_content.html" if is_fragment_request() else "messages.html"
    return render_template(template_name, **view_model)


def register_messages_routes(app):
    app.add_url_rule("/messages", view_func=messages, endpoint="messages")
