"""Structured logging: one event name plus key/value fields per log line.

Usage::

    log_event(logger, "reminder.sent", log_id=7, dose_id=3, attempt=1)

The formatter prints either one JSON object per line (LOG_FORMAT=json, for
log aggregation) or a readable ``event key=value`` line (LOG_FORMAT=plain).

PRIVACY: log identifiers and counts only. Never put emails, phone numbers,
tokens, medication names or exception messages (which can echo an address)
into fields.
"""
import json
import logging
from datetime import UTC, datetime


def log_event(logger: logging.Logger, event: str, level: int = logging.INFO, **fields) -> None:
    """Emit one structured event. ``fields`` must be JSON-friendly scalars."""
    logger.log(level, event, extra={"event": event, "fields": fields})


class StructuredFormatter(logging.Formatter):
    """Render records produced by ``log_event`` (and ordinary ones) as JSON or key=value."""

    def __init__(self, style: str = "plain"):
        super().__init__()
        self.as_json = style == "json"

    def format(self, record: logging.LogRecord) -> str:
        event = getattr(record, "event", None) or record.getMessage()
        fields = dict(getattr(record, "fields", {}))
        ts = datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds")
        if record.exc_info:
            fields["exception"] = self.formatException(record.exc_info)
        if self.as_json:
            payload = {"ts": ts, "level": record.levelname, "logger": record.name, "event": event, **fields}
            return json.dumps(payload, default=str, separators=(",", ":"))
        pairs = " ".join(f"{key}={value}" for key, value in fields.items())
        return f"{ts} {record.levelname} {record.name} {event} {pairs}".rstrip()
