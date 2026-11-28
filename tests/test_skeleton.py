import pytest
from django.core.exceptions import ImproperlyConfigured

from config.env import normalize_redis_url, require_env
from notifications.tasks import ping


def test_plain_redis_url_unchanged():
    assert normalize_redis_url("redis://localhost:6379/0") == "redis://localhost:6379/0"


def test_rediss_gets_ssl_cert_reqs():
    out = normalize_redis_url("rediss://:pw@host.upstash.io:6379")
    assert out.endswith("?ssl_cert_reqs=required")


def test_rediss_keeps_existing_ssl_cert_reqs():
    url = "rediss://host:6379/0?ssl_cert_reqs=none"
    assert normalize_redis_url(url) == url


def test_rediss_appends_to_existing_query():
    out = normalize_redis_url("rediss://host:6379/0?foo=bar")
    assert "foo=bar" in out and "ssl_cert_reqs=required" in out


def test_require_env_missing(monkeypatch):
    monkeypatch.delenv("SOME_MISSING_VAR", raising=False)
    with pytest.raises(ImproperlyConfigured, match="SOME_MISSING_VAR"):
        require_env("SOME_MISSING_VAR")


@pytest.mark.django_db
def test_health_ok(client):
    response = client.get("/health/")
    assert response.status_code == 200
    assert response.json()["status"] == "OK"


def test_ping_task_runs_eagerly():
    assert ping.apply().get() == "pong"
