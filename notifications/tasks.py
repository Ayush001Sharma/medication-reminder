import logging

from celery import shared_task
from django.conf import settings

from . import services

logger = logging.getLogger(__name__)


@shared_task
def ping() -> str:
    """Trivial task used to verify the Celery worker pipeline end to end."""
    return "pong"


@shared_task(ignore_result=True)
def dispatch_reminders() -> int:
    """Every minute: claim due doses and pick up retries / stuck sends.

    Claims are committed before tasks are queued. If queuing fails (e.g. the
    broker is down), the rows' leases expire and the next tick recovers them.
    """
    reservations = services.dispatch()
    for reservation in reservations:
        deliver_notification.delay(reservation.log_id, str(reservation.token))
    return len(reservations)


@shared_task(
    ignore_result=True,
    soft_time_limit=settings.EMAIL_TIMEOUT + 15,
    time_limit=settings.EMAIL_TIMEOUT + 30,  # hard kill: a send can never outlive its lease
)
def deliver_notification(log_id: int, token: str) -> str:
    """One delivery attempt. Idempotent: a retried or redelivered copy sends nothing."""
    return services.deliver(log_id, token)


@shared_task(ignore_result=True)
def mark_missed_doses() -> int:
    """Every 5 minutes: doses still untaken after DOSE_MISSED_AFTER_MINUTES become missed."""
    count = services.mark_missed_doses()
    if count:
        logger.info("Marked %s dose(s) missed", count)
    return count
