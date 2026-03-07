from app.services.dashboard import warm_dashboard_cache
from app.services.messages import fetch_messages
from app.services.settings import fetch_sender_configurations


def warm_dashboard_cache_task(config):
    return warm_dashboard_cache(config)


def warm_messages_cache_task(config):
    return fetch_messages(config=config, force_refresh=True)


def warm_sender_config_cache_task(config):
    return fetch_sender_configurations(config=config, force_refresh=True)
