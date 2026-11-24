"""Helpers for reading configuration from environment variables."""
import os
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from django.core.exceptions import ImproperlyConfigured


def load_env_file(path) -> None:
    """Load KEY=VALUE pairs from ``path`` if it exists (real environment variables win).

    Windows PowerShell 5.1 writes UTF-16 when you create a file with ``>`` or ``echo``, which cannot
    be read as text: say so instead of crashing with a confusing UnicodeDecodeError.
    """
    from dotenv import load_dotenv

    try:
        load_dotenv(path, encoding="utf-8-sig")  # utf-8-sig also accepts the BOM some editors add
    except UnicodeDecodeError:
        raise ImproperlyConfigured(
            f"{path} is not a UTF-8 text file. Recreate it with: Copy-Item .env.example .env "
            "and edit it in an editor that saves UTF-8 (do not create it with > or echo in Windows PowerShell 5.1)."
        )


def require_env(name: str) -> str:
    """Return a required environment variable or fail with a clear message."""
    value = os.environ.get(name, "").strip()
    if not value:
        raise ImproperlyConfigured(
            f"Missing required environment variable {name}. "
            f"Copy .env.example to .env and set {name} (see README)."
        )
    return value


def env_int(name: str, default: int) -> int:
    """Read an integer environment variable, failing clearly on bad input."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        raise ImproperlyConfigured(f"{name} must be an integer, got {raw!r}.")


def env_bool(name: str, default: bool) -> bool:
    """Read a true/false environment variable ("true", "1", "yes" are true)."""
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    if raw in {"true", "1", "yes", "on"}:
        return True
    if raw in {"false", "0", "no", "off"}:
        return False
    raise ImproperlyConfigured(f"{name} must be true or false, got {raw!r}.")


def env_list(name: str, default: str) -> list[str]:
    """Comma-separated environment variable as a list of non-empty items."""
    return [item.strip() for item in os.environ.get(name, default).split(",") if item.strip()]


_ORIGIN = re.compile(r"^https?://(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::\d{1,5})?$")


def env_origins(name: str) -> list[str]:
    """Comma-separated browser origins, e.g. ``https://app.example.com,http://localhost:5173``.

    An origin is scheme + host (+ port) and nothing else. A trailing slash is tolerated and removed. A
    wildcard, a missing scheme or a path is rejected at startup rather than silently ignored, because an
    origin that does not match exactly would simply never be allowed (or, worse, be too permissive).
    """
    origins = []
    for item in env_list(name, ""):
        origin = item.rstrip("/")
        if not _ORIGIN.match(origin):
            raise ImproperlyConfigured(
                f"{name} must be comma-separated origins such as https://app.example.com "
                f"(scheme and host, optional port, no path or wildcard), got {item!r}."
            )
        origins.append(origin)
    return origins


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


_UNITS = {"s": 1, "sec": 1, "m": 60, "min": 60, "h": 3600, "hour": 3600, "d": 86400, "day": 86400}


def validate_rate(name: str, rate: str) -> None:
    """Fail at startup on a malformed rate such as ``"10/fortnight"``."""
    count, _, unit = rate.partition("/")
    if not count.isdigit() or unit not in _UNITS:
        raise ImproperlyConfigured(f"{name} must look like '10/min' (sec, min, hour, day), got {rate!r}.")


def validate_secret_key(secret_key: str, *, debug: bool, dev_key: str) -> None:
    """Outside debug mode, refuse the built-in dev key, placeholders and short keys.

    Dose links and JWTs are signed with this key, so a guessable key means forgeable links and tokens.
    """
    if debug:
        return
    if secret_key == dev_key or secret_key.lower().startswith("change-me") or len(secret_key) < 32:
        raise ImproperlyConfigured(
            "Set DJANGO_SECRET_KEY to a long random value (at least 32 characters) when DJANGO_DEBUG is not "
            "true. Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(50))\""
        )
