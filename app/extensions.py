import threading
import time


try:
    from flask_caching import Cache as FlaskCache
except ModuleNotFoundError:
    FlaskCache = None

try:
    from celery import Celery
except ModuleNotFoundError:
    Celery = None


class _FallbackCacheBackend:
    def __init__(self):
        self._store = {}
        self._lock = threading.Lock()

    def init_app(self, app):
        app.extensions["cache"] = self

    def _purge_if_expired(self, key):
        entry = self._store.get(key)
        if not entry:
            return None
        value, expires_at = entry
        if expires_at and expires_at <= time.time():
            self._store.pop(key, None)
            return None
        return value

    def get(self, key):
        with self._lock:
            return self._purge_if_expired(key)

    def set(self, key, value, timeout=None):
        ttl = timeout if timeout is not None else 0
        expires_at = time.time() + ttl if ttl and ttl > 0 else None
        with self._lock:
            self._store[key] = (value, expires_at)
        return True

    def delete(self, key):
        with self._lock:
            self._store.pop(key, None)
        return True

    def clear(self):
        with self._lock:
            self._store.clear()
        return True


class CacheProxy:
    def __init__(self):
        self._backend = _FallbackCacheBackend()
        self._using_fallback = True
        self._app = None

    def init_app(self, app):
        self._app = app
        if FlaskCache is not None:
            try:
                backend = FlaskCache()
                backend.init_app(
                    app,
                    config={
                        "CACHE_TYPE": app.config.get("CACHE_TYPE", "SimpleCache"),
                        "CACHE_DEFAULT_TIMEOUT": app.config.get("CACHE_DEFAULT_TIMEOUT", 180),
                        "CACHE_REDIS_URL": app.config.get("CACHE_REDIS_URL", ""),
                    },
                )
                self._backend = backend
                self._using_fallback = False
            except Exception:
                self._backend = _FallbackCacheBackend()
                self._using_fallback = True
                self._backend.init_app(app)
                return
        else:
            self._backend = _FallbackCacheBackend()
            self._using_fallback = True
            self._backend.init_app(app)

    def _activate_fallback(self):
        fallback_backend = _FallbackCacheBackend()
        if self._app is not None:
            fallback_backend.init_app(self._app)
        self._backend = fallback_backend
        self._using_fallback = True

    def get(self, key):
        try:
            return self._backend.get(key)
        except Exception:
            self._activate_fallback()
            return self._backend.get(key)

    def set(self, key, value, timeout=None):
        try:
            return self._backend.set(key, value, timeout=timeout)
        except Exception:
            self._activate_fallback()
            return self._backend.set(key, value, timeout=timeout)

    def delete(self, key):
        try:
            return self._backend.delete(key)
        except Exception:
            self._activate_fallback()
            return self._backend.delete(key)

    def clear(self):
        try:
            return self._backend.clear()
        except Exception:
            self._activate_fallback()
            return self._backend.clear()

    @property
    def using_fallback(self):
        return self._using_fallback


class NullCelery:
    def __init__(self):
        self.conf = {}

    def task(self, *decorator_args, **decorator_kwargs):
        def decorator(func):
            func.delay = lambda *args, **kwargs: func(*args, **kwargs)
            func.apply_async = lambda args=None, kwargs=None, **_options: func(*(args or ()), **(kwargs or {}))
            return func

        if decorator_args and callable(decorator_args[0]) and not decorator_kwargs:
            return decorator(decorator_args[0])
        return decorator

    def send_task(self, _name, args=None, kwargs=None, **_options):
        return None


cache = CacheProxy()


def create_celery_app(flask_app):
    broker_url = (flask_app.config.get("CELERY_BROKER_URL") or "").strip()
    result_backend = (flask_app.config.get("CELERY_RESULT_BACKEND") or "").strip()

    if Celery is None or not broker_url or not result_backend:
        return NullCelery()

    celery_app = Celery(
        flask_app.import_name,
        broker=broker_url,
        backend=result_backend,
    )
    celery_app.conf.update(flask_app.config)

    class FlaskContextTask(celery_app.Task):
        def __call__(self, *args, **kwargs):
            with flask_app.app_context():
                return super().__call__(*args, **kwargs)

    celery_app.Task = FlaskContextTask
    return celery_app
