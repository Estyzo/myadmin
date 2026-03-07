from app.routes.dashboard import register_dashboard_routes
from app.routes.messages import register_messages_routes
from app.routes.send_money import register_send_money_routes
from app.routes.settings import register_settings_routes


def register_routes(app):
    register_dashboard_routes(app)
    register_messages_routes(app)
    register_send_money_routes(app)
    register_settings_routes(app)
