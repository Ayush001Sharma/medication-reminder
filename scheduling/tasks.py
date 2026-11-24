import logging

from celery import shared_task

from .services import sync_all_active_schedules

logger = logging.getLogger(__name__)


@shared_task
def generate_upcoming_doses() -> int:
    """Daily: keep HORIZON_DAYS of future doses for every active schedule.

    Safe to run any number of times (idempotent), so running it more often
    than daily, or retrying it, never creates duplicates.
    """
    created = sync_all_active_schedules()
    logger.info("generate_upcoming_doses created %s dose events", created)
    return created
