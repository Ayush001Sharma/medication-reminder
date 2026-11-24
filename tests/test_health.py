import pytest
import redis
from django.db.utils import OperationalError
from django.conf import settings

from config import health

pytestmark = pytest.mark.django_db


class FakeRedis:
    def __init__(self, error=None):
        self.error = error

    def ping(self):
        if self.error:
            raise self.error
        return True


def use_fake_redis(monkeypatch, error=None):
    monkeypatch.setattr(health.redis.Redis, "from_url", lambda *a, **k: FakeRedis(error))


def test_healthy(client, monkeypatch):
    use_fake_redis(monkeypatch)
    response = client.get("/health/")
    assert response.status_code == 200
    assert response.json() == {"status": "OK", "database": "ok", "redis": "ok"}


def test_redis_down_is_reported_as_503_without_leaking_details(client, monkeypatch):
    use_fake_redis(monkeypatch, redis.ConnectionError("Error 111 connecting to secret-host:6379"))
    response = client.get("/health/")
    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "ERROR" and body["database"] == "ok" and body["redis"] == "error: ConnectionError"
    assert "secret-host" not in response.content.decode()  # only the error class is exposed


def test_database_down_is_reported_as_503(client, monkeypatch):
    use_fake_redis(monkeypatch)

    def boom():
        raise OperationalError("connection to server at db.internal failed")

    monkeypatch.setattr(health.connection, "cursor", boom)
    response = client.get("/health/")
    assert response.status_code == 503
    assert response.json() == {"status": "ERROR", "database": "error: OperationalError", "redis": "ok"}
    assert "db.internal" not in response.content.decode()


def test_the_check_functions_never_raise(monkeypatch):
    monkeypatch.setattr(health.connection, "cursor", lambda: (_ for _ in ()).throw(RuntimeError("x")))
    monkeypatch.setattr(health.redis.Redis, "from_url", lambda *a, **k: (_ for _ in ()).throw(ValueError("bad url")))
    assert health.check_database() == "error: RuntimeError" and health.check_redis() == "error: ValueError"


def real_redis_available() -> bool:
    try:
        return bool(redis.Redis.from_url(settings.REDIS_URL, socket_connect_timeout=1).ping())
    except Exception:
        return False


@pytest.mark.skipif(not real_redis_available(), reason="needs the Redis from REDIS_URL")
def test_real_redis_and_database(client):
    """Integration check against the real services (skipped when Redis is not reachable)."""
    assert client.get("/health/").json() == {"status": "OK", "database": "ok", "redis": "ok"}
