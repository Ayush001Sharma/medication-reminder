"""Helpers for reading configuration from environment variables."""
import os
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from django.core.exceptions import ImproperlyConfigured


def require_env(name: str) -> str:
    """Return a required environment variable or fail with a clear message."""
    value = os.environ.get(name, "").strip()
    if not value:
        raise ImproperlyConfigured(
            f"Missing required environment variable {name}. "
            f"Copy .env.example to .env and set {name} (see README)."
        )
    return value


def normalize_redis_url(url: str) -> str:
    """Make sure a TLS (rediss://) URL has ssl_cert_reqs; default to 'required'.

    Plain redis:// URLs are returned unchanged. An explicit ssl_cert_reqs
    value in the URL is never overridden.
    """
    parts = urlsplit(url)
    if parts.scheme != "rediss":
        return url
    query = parse_qsl(parts.query, keep_blank_values=True)
    if any(key == "ssl_cert_reqs" for key, _ in query):
        return url
    query.append(("ssl_cert_reqs", "required"))
    return urlunsplit(parts._replace(query=urlencode(query)))
