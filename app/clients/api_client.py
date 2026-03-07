import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from flask import current_app


try:
    import httpx
except ModuleNotFoundError:
    httpx = None


class ApiClientError(Exception):
    def __init__(self, message, status_code=None, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload


class TransferFlowApiClient:
    def __init__(self):
        self._config = {}
        self._client = None

    def init_app(self, app):
        self._config = app.config
        if httpx is not None:
            timeout = httpx.Timeout(
                timeout=app.config.get("HTTPX_TIMEOUT_SECONDS", 12),
                connect=app.config.get("HTTPX_CONNECT_TIMEOUT_SECONDS", 5),
            )
            limits = httpx.Limits(
                max_connections=app.config.get("HTTPX_MAX_CONNECTIONS", 20),
                max_keepalive_connections=app.config.get("HTTPX_MAX_KEEPALIVE_CONNECTIONS", 10),
            )
            self._client = httpx.Client(timeout=timeout, limits=limits, headers={"Accept": "application/json"})
        app.extensions["transferflow_api_client"] = self

    def _runtime_config(self, config=None):
        if config is not None:
            return config
        try:
            return current_app.config
        except RuntimeError:
            return self._config

    def _request_json(self, method, url, payload=None, timeout=None, config=None):
        runtime_config = self._runtime_config(config)
        request_timeout = timeout if timeout is not None else runtime_config.get("HTTPX_TIMEOUT_SECONDS", 12)

        if self._client is not None:
            try:
                response = self._client.request(method, url, json=payload, timeout=request_timeout)
                response.raise_for_status()
                if not response.text:
                    return {}, response.status_code
                return response.json(), response.status_code
            except httpx.HTTPStatusError as exc:
                response_payload = None
                try:
                    response_payload = exc.response.json()
                except ValueError:
                    response_payload = exc.response.text
                raise ApiClientError(
                    self._extract_error_message(response_payload, fallback=f"Upstream API returned HTTP {exc.response.status_code}."),
                    status_code=exc.response.status_code,
                    payload=response_payload,
                ) from exc
            except (httpx.RequestError, ValueError) as exc:
                raise ApiClientError("Unable to reach upstream API.") from exc

        request_data = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            request_data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(url, data=request_data, headers=headers, method=method.upper())
        try:
            with urlopen(request, timeout=request_timeout) as response:
                response_body = response.read().decode("utf-8")
                status_code = int(getattr(response, "status", response.getcode()))
                if not response_body:
                    return {}, status_code
                try:
                    return json.loads(response_body), status_code
                except json.JSONDecodeError:
                    return {"raw": response_body}, status_code
        except HTTPError as exc:
            error_payload = self._parse_http_error_payload(exc)
            raise ApiClientError(
                self._extract_error_message(error_payload, fallback=f"Upstream API returned HTTP {exc.code}."),
                status_code=exc.code,
                payload=error_payload,
            ) from exc
        except (URLError, TimeoutError) as exc:
            raise ApiClientError("Unable to reach upstream API.") from exc

    @staticmethod
    def _parse_http_error_payload(error):
        try:
            raw_body = error.read().decode("utf-8")
        except Exception:
            return None
        if not raw_body:
            return None
        try:
            return json.loads(raw_body)
        except json.JSONDecodeError:
            return raw_body

    @staticmethod
    def _extract_error_message(payload, fallback):
        if isinstance(payload, dict):
            return str(payload.get("error") or payload.get("message") or fallback)
        if isinstance(payload, str) and payload.strip():
            return payload.strip()[:240]
        return fallback

    def get_transactions_page(self, page, page_size, config=None):
        runtime_config = self._runtime_config(config)
        endpoint = f"{runtime_config['API_BASE_URL'].rstrip('/')}/transactions?page={page}&pageSize={page_size}"
        return self._request_json("GET", endpoint, config=runtime_config)

    def get_messages(self, config=None):
        runtime_config = self._runtime_config(config)
        endpoint = f"{runtime_config['API_BASE_URL'].rstrip('/')}/getmessages"
        return self._request_json("GET", endpoint, config=runtime_config)

    def get_sender_configurations(self, config=None):
        runtime_config = self._runtime_config(config)
        return self._request_json("GET", runtime_config["SENDER_CONFIG_API_URL"], config=runtime_config)

    def post_send_money(self, payload, config=None):
        runtime_config = self._runtime_config(config)
        return self._request_json("POST", runtime_config["SEND_MONEY_API_URL"], payload=payload, config=runtime_config)


api_client = TransferFlowApiClient()
