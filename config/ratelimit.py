"""Rate limits for abuse-prone endpoints.

Limits live in ``settings.RATE_LIMITS`` (``"<count>/<sec|min|hour|day>"``),
are read on every request, and are counted in the Django cache, which is
Redis in every real run, so they hold across web processes.

Fail open: if Redis is unreachable the request is allowed and an error is
logged. Rate limiting must not turn a cache outage into a login outage.
Counting is DRF's sliding-window list, which is read-modify-write rather than
atomic, so under heavy concurrency a few extra requests can slip through.
These are abuse limits, not exact quotas.
"""
import hashlib
import logging

from django.conf import settings
from redis.exceptions import RedisError
from rest_framework.throttling import SimpleRateThrottle

from .logging_utils import log_event

logger = logging.getLogger(__name__)
def _digest(value: str) -> str:
    """Keys hold a hash, so no email address ever sits in Redis."""
    return hashlib.sha256(value.encode()).hexdigest()[:32]


class ConfiguredThrottle(SimpleRateThrottle):
    """Base class: the rate comes from settings.RATE_LIMITS[scope], fail-open on cache errors."""

    scope = ""

    def get_rate(self):
        return settings.RATE_LIMITS[self.scope]

    def allow_request(self, request, view):
        try:
            return super().allow_request(request, view)
        except (RedisError, OSError) as exc:
            log_event(logger, "ratelimit.cache_unavailable", logging.ERROR,
                      scope=self.scope, error_type=type(exc).__name__)
            return True


class LoginIPThrottle(ConfiguredThrottle):
    """Per client address: slows password spraying from one machine."""

    scope = "login"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class LoginAccountThrottle(ConfiguredThrottle):
    """Per account: slows guessing one account's password from many addresses."""

    scope = "login_account"

    def get_cache_key(self, request, view):
        try:
            email = request.data.get("email")
        except Exception:  # unparseable body: the view will reject it anyway
            return None
        if not isinstance(email, str) or not email.strip():
            return None
        return self.cache_format % {"scope": self.scope, "ident": _digest(email.strip().lower())}


class RegisterThrottle(ConfiguredThrottle):
    scope = "register"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class InviteThrottle(ConfiguredThrottle):
    """Per patient: stops the invite endpoint being used to spam addresses."""

    scope = "invite"

    def get_cache_key(self, request, view):
        ident = request.user.pk if request.user and request.user.is_authenticated else self.get_ident(request)
        return self.cache_format % {"scope": self.scope, "ident": ident}


class DoseLinkThrottle(ConfiguredThrottle):
    """Per client address, for the plain-Django one-click link view."""

    scope = "dose_link"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}
