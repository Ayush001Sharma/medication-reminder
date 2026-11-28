"""Validators for account fields."""
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.core.exceptions import ValidationError


def validate_iana_timezone(value: str) -> None:
    """Raise ValidationError unless ``value`` is a real IANA timezone name.

    ZoneInfo raises ValueError for malformed keys (e.g. absolute paths or
    '..' segments) and ZoneInfoNotFoundError for unknown names; both are
    treated as invalid. Abbreviations like 'IST' are rejected too.
    """
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        raise ValidationError(
            "'%(value)s' is not a valid IANA timezone (e.g. Asia/Kolkata).",
            params={"value": value},
            code="invalid_timezone",
        )
