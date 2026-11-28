"""Date ranges for reports, read in the PATIENT'S timezone.

``from`` and ``to`` are local calendar dates, both inclusive. They are turned
into a half-open UTC interval ``[start_utc, end_utc)`` between local
midnights, so a dose at 00:15 local time belongs to that local day even
though its UTC date differs, and 23/25-hour DST days are handled.
"""
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from rest_framework import serializers
from rest_framework.exceptions import ValidationError

from scheduling.services import local_to_utc

MAX_RANGE_DAYS = 366
DEFAULT_RANGE_DAYS = 30


@dataclass(frozen=True)
class LocalRange:
    start_date: date
    end_date: date  # inclusive
    start_utc: datetime
    end_utc: datetime  # exclusive
    timezone: str


def build_range(start_date: date, end_date: date, tz: ZoneInfo) -> LocalRange:
    """Validate and convert two inclusive local dates (max 366 days)."""
    if end_date < start_date:
        raise ValidationError({"to": "Must not be before 'from'."})
    days = (end_date - start_date).days + 1
    if days > MAX_RANGE_DAYS:
        raise ValidationError({"to": f"Range is limited to {MAX_RANGE_DAYS} days (got {days})."})
    return LocalRange(
        start_date=start_date,
        end_date=end_date,
        start_utc=local_to_utc(start_date, time.min, tz),
        end_utc=local_to_utc(end_date + timedelta(days=1), time.min, tz),
        timezone=tz.key,
    )


_date_field = serializers.DateField(input_formats=["%Y-%m-%d"])


def _parse(name: str, raw) -> date | None:
    if raw in (None, ""):
        return None
    try:
        return _date_field.to_internal_value(raw)
    except ValidationError:
        raise ValidationError({name: "Use the format YYYY-MM-DD."})


def parse_query_range(params, tz: ZoneInfo, now: datetime) -> LocalRange:
    """Read ``from`` / ``to`` query parameters; default to the last 30 local days."""
    end = _parse("to", params.get("to")) or now.astimezone(tz).date()
    start = _parse("from", params.get("from")) or end - timedelta(days=DEFAULT_RANGE_DAYS - 1)
    return build_range(start, end, tz)
