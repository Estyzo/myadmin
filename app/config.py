import os


try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    def load_dotenv(path=".env"):
        if not os.path.exists(path):
            return False
        with open(path, "r", encoding="utf-8") as env_file:
            for raw_line in env_file:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
        return True


def read_positive_int_env(name, default, minimum=1):
    raw_value = os.getenv(name, "")
    try:
        parsed_value = int(str(raw_value).strip())
    except (TypeError, ValueError):
        parsed_value = default
    return max(minimum, parsed_value)


def normalize_upstream_url(url):
    normalized = (url or "").strip()
    if normalized.startswith("http://southerntechnologies.tech"):
        normalized = "https://" + normalized[len("http://") :]
    return normalized


def join_api_url(base_url, path):
    base = (base_url or "").rstrip("/")
    suffix = (path or "").lstrip("/")
    return f"{base}/{suffix}" if suffix else base


def load_environment():
    load_dotenv()


def build_config():
    api_base_url = normalize_upstream_url(os.getenv("API_BASE_URL", "https://southerntechnologies.tech/api"))
    sender_config_api_url = normalize_upstream_url(os.getenv("SENDER_CONFIG_API_URL", ""))
    send_money_api_url = normalize_upstream_url(os.getenv("SEND_MONEY_API_URL", ""))
    redis_url = os.getenv("REDIS_URL", "").strip()

    if not sender_config_api_url:
        sender_config_api_url = join_api_url(api_base_url, "sender-configurations")
    elif sender_config_api_url.startswith("/"):
        sender_config_api_url = join_api_url(api_base_url, sender_config_api_url)

    if not send_money_api_url:
        send_money_api_url = join_api_url(api_base_url, "send-money")
    elif send_money_api_url.startswith("/"):
        send_money_api_url = join_api_url(api_base_url, send_money_api_url)

    return {
        "API_BASE_URL": api_base_url,
        "APP_TIMEZONE": os.getenv("APP_TIMEZONE", "Africa/Dar_es_Salaam"),
        "SENDER_CONFIG_API_URL": sender_config_api_url,
        "SEND_MONEY_API_URL": send_money_api_url,
        "SECRET_KEY": os.getenv("FLASK_SECRET_KEY", "transferflow-dev-key"),
        "TRANSACTION_CACHE_TTL_SECONDS": read_positive_int_env("TRANSACTION_CACHE_TTL_SECONDS", 180, minimum=20),
        "MESSAGES_CACHE_TTL_SECONDS": read_positive_int_env("MESSAGES_CACHE_TTL_SECONDS", 120, minimum=20),
        "SENDER_CONFIG_CACHE_TTL_SECONDS": read_positive_int_env("SENDER_CONFIG_CACHE_TTL_SECONDS", 180, minimum=20),
        "TRANSACTION_FETCH_WORKERS": read_positive_int_env("TRANSACTION_FETCH_WORKERS", 6, minimum=1),
        "CACHE_DEFAULT_TIMEOUT": read_positive_int_env("CACHE_DEFAULT_TTL", 180, minimum=20),
        "DASHBOARD_CACHE_TTL": read_positive_int_env("DASHBOARD_CACHE_TTL", 180, minimum=20),
        "REDIS_URL": redis_url,
        "CACHE_TYPE": "RedisCache" if redis_url else "SimpleCache",
        "CACHE_REDIS_URL": redis_url,
        "HTTPX_TIMEOUT_SECONDS": float(os.getenv("HTTPX_TIMEOUT_SECONDS", "12")),
        "HTTPX_CONNECT_TIMEOUT_SECONDS": float(os.getenv("HTTPX_CONNECT_TIMEOUT_SECONDS", "5")),
        "HTTPX_MAX_CONNECTIONS": read_positive_int_env("HTTPX_MAX_CONNECTIONS", 20, minimum=1),
        "HTTPX_MAX_KEEPALIVE_CONNECTIONS": read_positive_int_env("HTTPX_MAX_KEEPALIVE_CONNECTIONS", 10, minimum=1),
        "CELERY_BROKER_URL": os.getenv("CELERY_BROKER_URL", redis_url).strip(),
        "CELERY_RESULT_BACKEND": os.getenv("CELERY_RESULT_BACKEND", redis_url).strip(),
        "CELERY_TASK_ALWAYS_EAGER": os.getenv("CELERY_TASK_ALWAYS_EAGER", "").strip().lower() in {"1", "true", "yes"},
        "USE_CELERY_CACHE_WARMING": os.getenv("USE_CELERY_CACHE_WARMING", "true").strip().lower() in {"1", "true", "yes"},
        "DASHBOARD_REFRESH_LOCK_TTL": read_positive_int_env("DASHBOARD_REFRESH_LOCK_TTL", 120, minimum=30),
    }
