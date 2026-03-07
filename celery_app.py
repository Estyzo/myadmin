from app import create_app
from app.tasks.cache_tasks import (
    warm_dashboard_cache_task as run_dashboard_warm,
    warm_messages_cache_task as run_messages_warm,
    warm_sender_config_cache_task as run_sender_config_warm,
)


flask_app = create_app()
celery = flask_app.extensions["celery"]


@celery.task(name="transferflow.cache.warm_dashboard")
def warm_dashboard_cache():
    return run_dashboard_warm(flask_app.config)


@celery.task(name="transferflow.cache.warm_messages")
def warm_messages_cache():
    return run_messages_warm(flask_app.config)


@celery.task(name="transferflow.cache.warm_sender_configs")
def warm_sender_config_cache():
    return run_sender_config_warm(flask_app.config)
