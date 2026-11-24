"""CORS: the web frontend (a different origin) may call /api/ only when its origin is configured."""
import pytest
from django.core.exceptions import ImproperlyConfigured

from config.env import env_origins

ORIGIN = "http://localhost:5173"
LOGIN = "/api/auth/login/"


@pytest.fixture
def allowed(settings):
    settings.CORS_ALLOWED_ORIGINS = [ORIGIN]


def preflight(client, path=LOGIN, origin=ORIGIN, method="POST"):
    return client.options(
        path, HTTP_ORIGIN=origin, HTTP_ACCESS_CONTROL_REQUEST_METHOD=method,
        HTTP_ACCESS_CONTROL_REQUEST_HEADERS="authorization,content-type",
    )


# --- preflight ---------------------------------------------------------------------------------
def test_preflight_from_an_allowed_origin_is_answered(client, allowed):
    response = preflight(client)
    assert response.status_code == 200
    assert response["Access-Control-Allow-Origin"] == ORIGIN
    allowed_headers = response["Access-Control-Allow-Headers"].lower()
    assert "authorization" in allowed_headers and "content-type" in allowed_headers
    for method in ("POST", "PATCH", "DELETE", "GET"):
        assert method in response["Access-Control-Allow-Methods"]
    assert int(response["Access-Control-Max-Age"]) > 0


def test_preflight_from_another_origin_gets_no_permission(client, allowed):
    assert "Access-Control-Allow-Origin" not in preflight(client, origin="https://evil.example")


def test_preflight_for_every_http_method_the_frontend_uses(client, allowed):
    for method in ("GET", "POST", "PATCH", "DELETE"):
        assert preflight(client, "/api/me/", method=method)["Access-Control-Allow-Origin"] == ORIGIN


# --- real requests --------------------------------------------------------------------------------
def test_real_response_carries_the_allow_header_and_vary(client, allowed, db):
    response = client.post(LOGIN, {"email": "x@example.com", "password": "wrong"},
                           content_type="application/json", HTTP_ORIGIN=ORIGIN)
    assert response.status_code == 401
    assert response["Access-Control-Allow-Origin"] == ORIGIN
    assert "origin" in response["Vary"].lower()  # caches must key on the Origin header


def test_an_unauthenticated_401_is_readable_by_the_frontend(client, allowed):
    """The frontend refreshes its token on a 401, so it must be allowed to see that status."""
    response = client.get("/api/me/", HTTP_ORIGIN=ORIGIN)
    assert response.status_code == 401 and response["Access-Control-Allow-Origin"] == ORIGIN


def test_error_pages_under_api_are_readable_too(client, allowed):
    response = client.get("/api/does-not-exist/", HTTP_ORIGIN=ORIGIN)
    assert response.status_code == 404 and response["Access-Control-Allow-Origin"] == ORIGIN


def test_other_origins_get_nothing_on_real_requests(client, allowed):
    response = client.get("/api/me/", HTTP_ORIGIN="https://evil.example")
    assert "Access-Control-Allow-Origin" not in response


def test_no_origins_configured_means_no_cross_origin_access(client, settings):
    settings.CORS_ALLOWED_ORIGINS = []
    assert "Access-Control-Allow-Origin" not in client.get("/api/me/", HTTP_ORIGIN=ORIGIN)
    assert "Access-Control-Allow-Origin" not in preflight(client)


def test_default_configuration_in_the_repository_is_closed(settings):
    """Unless CORS_ALLOWED_ORIGINS is set, nothing is allowed (no wildcard, no credentials)."""
    assert getattr(settings, "CORS_ALLOW_ALL_ORIGINS", False) is False
    assert getattr(settings, "CORS_ALLOW_CREDENTIALS", False) is False


def test_never_a_wildcard_and_never_credentials(client, allowed):
    response = client.get("/api/me/", HTTP_ORIGIN=ORIGIN)
    assert response["Access-Control-Allow-Origin"] != "*"
    assert "Access-Control-Allow-Credentials" not in response


def test_only_the_api_is_exposed(client, allowed):
    for path in ("/health/", "/dose/taken/some-token/", "/admin/login/"):
        response = client.get(path, HTTP_ORIGIN=ORIGIN)
        assert "Access-Control-Allow-Origin" not in response, path


def test_retry_after_is_readable_when_rate_limited(client, allowed, settings, db):
    settings.RATE_LIMITS = {**settings.RATE_LIMITS, "login": "1/min", "login_account": "100/min"}
    body = {"email": "x@example.com", "password": "wrong"}
    client.post(LOGIN, body, content_type="application/json", HTTP_ORIGIN=ORIGIN)
    blocked = client.post(LOGIN, body, content_type="application/json", HTTP_ORIGIN=ORIGIN)
    assert blocked.status_code == 429 and blocked["Retry-After"]
    assert "Retry-After" in blocked["Access-Control-Expose-Headers"]
    assert blocked["Access-Control-Allow-Origin"] == ORIGIN


def test_several_origins_each_get_their_own_value(client, settings):
    settings.CORS_ALLOWED_ORIGINS = [ORIGIN, "https://app.example.com"]
    for origin in settings.CORS_ALLOWED_ORIGINS:
        assert client.get("/api/me/", HTTP_ORIGIN=origin)["Access-Control-Allow-Origin"] == origin


# --- parsing the environment variable --------------------------------------------------------------------
@pytest.mark.parametrize("raw,expected", [
    ("", []),
    ("http://localhost:5173", ["http://localhost:5173"]),
    (" http://localhost:5173 , https://app.example.com/ ", ["http://localhost:5173", "https://app.example.com"]),
    ("https://app.example.com:8443", ["https://app.example.com:8443"]),
    ("http://[::1]:5173", ["http://[::1]:5173"]),
])
def test_valid_origin_lists(monkeypatch, raw, expected):
    monkeypatch.setenv("SOME_ORIGINS", raw)
    assert env_origins("SOME_ORIGINS") == expected


@pytest.mark.parametrize("bad", [
    "*", "localhost:5173", "app.example.com", "http://app.example.com/path", "ftp://app.example.com",
    "http://", "https://app.example.com?x=1", "http://a b.com", "http://localhost:5173,*",
])
def test_invalid_origins_are_rejected_at_startup(monkeypatch, bad):
    monkeypatch.setenv("SOME_ORIGINS", bad)
    with pytest.raises(ImproperlyConfigured, match="SOME_ORIGINS"):
        env_origins("SOME_ORIGINS")
