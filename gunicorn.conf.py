import os


bind = os.getenv("GUNICORN_BIND", "127.0.0.1:8000")
workers = int(os.getenv("GUNICORN_WORKERS", "4"))
threads = int(os.getenv("GUNICORN_THREADS", "2"))
timeout = int(os.getenv("GUNICORN_TIMEOUT", "60"))
graceful_timeout = int(os.getenv("GUNICORN_GRACEFUL_TIMEOUT", "30"))
default_worker_tmp_dir = "/dev/shm" if os.path.isdir("/dev/shm") else "/tmp"
worker_tmp_dir = os.getenv("GUNICORN_WORKER_TMP_DIR", default_worker_tmp_dir)
accesslog = "-"
errorlog = "-"
capture_output = True
preload_app = True
