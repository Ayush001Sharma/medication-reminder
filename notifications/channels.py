"""Notification channels.

A channel only delivers a ReminderMessage; claiming, deduplication, retries
and bookkeeping live in ``services.py``, so new channels get them for free.
To add a real SMS/WhatsApp provider, implement ``send`` and list the channel
in the NOTIFICATION_CHANNELS setting.
"""
import logging
from abc import ABC, abstractmethod

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.core.mail import EmailMessage

from accounts.models import default_notification_preferences

from .content import ReminderMessage, message_id

logger = logging.getLogger(__name__)


class NotificationChannel(ABC):
    """Deliver one message. Raise any exception to signal a failed attempt."""

    #: Also the key in PatientProfile.notification_preferences.
    name: str = ""

    @abstractmethod
    def send(self, message: ReminderMessage) -> None: ...


class EmailChannel(NotificationChannel):
    """Real channel. Uses EMAIL_BACKEND (console in development)."""

    name = "email"

    def send(self, message: ReminderMessage) -> None:
        EmailMessage(
            subject=message.subject,
            body=message.body,
            from_email=settings.DEFAULT_FROM_EMAIL,
            to=[message.to_email],
            # Same Message-ID on a resend lets mail systems collapse duplicates.
            headers={"Message-ID": message_id(message)},
        ).send(fail_silently=False)


class SmsChannel(NotificationChannel):
    """Placeholder: logs only, never sends a real SMS."""

    name = "sms"

    def send(self, message: ReminderMessage) -> None:
        logger.info("SMS stub: would send %s", message.idempotency_key)


class WhatsAppChannel(NotificationChannel):
    """Placeholder: logs only, never sends a real WhatsApp message."""

    name = "whatsapp"

    def send(self, message: ReminderMessage) -> None:
        logger.info("WhatsApp stub: would send %s", message.idempotency_key)


REGISTRY: dict[str, NotificationChannel] = {
    channel.name: channel for channel in (EmailChannel(), SmsChannel(), WhatsAppChannel())
}


def get_channel(name: str) -> NotificationChannel:
    return REGISTRY[name]


def enabled_channels() -> list[str]:
    """Channels switched on for the deployment (NOTIFICATION_CHANNELS)."""
    unknown = set(settings.NOTIFICATION_CHANNELS) - set(REGISTRY)
    if unknown:
        raise ImproperlyConfigured(f"Unknown NOTIFICATION_CHANNELS: {sorted(unknown)}")
    return list(settings.NOTIFICATION_CHANNELS)


def default_preference(channel: str) -> bool:
    """Preference used when a patient's preferences omit this channel."""
    return default_notification_preferences().get(channel, False)


def patient_channels(patient, channels: list[str]) -> list[str]:
    """The subset of ``channels`` this patient has switched on."""
    profile = getattr(patient, "patient_profile", None)
    prefs = profile.notification_preferences if profile else {}
    return [c for c in channels if prefs.get(c, default_preference(c)) is True]
