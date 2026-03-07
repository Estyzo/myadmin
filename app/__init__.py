from flask import Flask

from app.clients.api_client import api_client
from app.config import build_config, load_environment
from app.extensions import cache, create_celery_app
from app.routes import register_routes
from app.services.shared import init_service_config


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

    cache.init_app(app)
    api_client.init_app(app)
    app.extensions["celery"] = create_celery_app(app)
    init_service_config(app)

    @app.context_processor
    def inject_api_base_url():
        return {
            "api_base_url": app.config["API_BASE_URL"],
            "sender_config_api_url": app.config["SENDER_CONFIG_API_URL"],
        }

    register_routes(app)
    return app


app = create_app()
