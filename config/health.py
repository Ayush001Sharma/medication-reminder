"""Health check endpoint: verifies database and Redis connectivity."""
import redis
from django.conf import settings
from django.db import connection
from django.http import JsonResponse


def check_database() -> str:
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        return "ok"
    except Exception as exc:  # report, never raise
        return f"error: {exc.__class__.__name__}"


def check_redis() -> str:
    try:
        redis.Redis.from_url(settings.REDIS_URL, socket_connect_timeout=2).ping()
        return "ok"
    except Exception as exc:
        return f"error: {exc.__class__.__name__}"


def health(request):
    checks = {"database": check_database(), "redis": check_redis()}
    healthy = all(v == "ok" for v in checks.values())
    return JsonResponse(
        {"status": "OK" if healthy else "ERROR", **checks},
        status=200 if healthy else 503,
    )
