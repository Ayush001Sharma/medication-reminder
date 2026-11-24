"""Reminder settings, read on every call so tests can override them."""
from datetime import timedelta

from django.conf import settings


def lead() -> timedelta:
    return timedelta(seconds=settings.REMINDER_LEAD_SECONDS)


def grace() -> timedelta:
    return timedelta(minutes=settings.REMINDER_GRACE_MINUTES)


def sending_timeout() -> timedelta:
    return timedelta(seconds=settings.REMINDER_SENDING_TIMEOUT_SECONDS)


def max_attempts() -> int:
    return settings.REMINDER_MAX_ATTEMPTS


def retry_delay(attempts: int) -> timedelta:
    """Exponential backoff after the Nth failed attempt: base, 2x, 4x, 8x ..."""
    return timedelta(seconds=settings.REMINDER_RETRY_BASE_SECONDS * 2 ** (attempts - 1))


def batch_size() -> int:
    return settings.REMINDER_BATCH_SIZE


def missed_after() -> timedelta:
    return timedelta(minutes=settings.DOSE_MISSED_AFTER_MINUTES)
