import logging

from celery import shared_task

from . import summary

logger = logging.getLogger(__name__)


@shared_task(ignore_result=True)
def send_weekly_summaries() -> int:
    """Hourly: email each patient's finished week to them and their active grantees.

    Idempotent (see reports/summary.py): re-running never re-sends.
    """
    sent = summary.send_weekly_summaries()
    if sent:
        logger.info("Sent %s weekly adherence summaries", sent)
    return sent
