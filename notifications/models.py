from django.db import models

from scheduling.models import DoseEvent


class NotificationStatus(models.TextChoices):
    SENDING = "sending", "Sending"  # claimed; in flight or waiting for a retry
    SENT = "sent", "Sent"
    FAILED = "failed", "Failed"  # gave up after REMINDER_MAX_ATTEMPTS
    CANCELLED = "cancelled", "Cancelled"  # dose taken/missed or too late to remind


class NotificationLog(models.Model):
    """One reminder for one dose on one channel, and every attempt to send it.

    The unique (dose_event, channel) constraint means a dose can be claimed
    for a channel only once. ``lease_token`` / ``lease_until`` say which
    worker may send right now; see notifications/services.py.
    """

    dose_event = models.ForeignKey(
        DoseEvent, on_delete=models.CASCADE, related_name="notification_logs"
    )
    channel = models.CharField(max_length=20)
    status = models.CharField(
        max_length=10, choices=NotificationStatus.choices, default=NotificationStatus.SENDING
    )
    attempts = models.PositiveSmallIntegerField(default=0)
    error = models.TextField(blank=True)
    lease_token = models.UUIDField(null=True, blank=True)
    lease_until = models.DateTimeField(null=True, blank=True)
    next_attempt_at = models.DateTimeField()
    last_attempt_at = models.DateTimeField(null=True, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["dose_event", "channel"], name="unique_notification_per_dose_channel"
            ),
        ]
        indexes = [
            models.Index(fields=["status", "next_attempt_at"], name="notif_status_next_idx"),
        ]

    def __str__(self):
        return f"{self.channel} for dose {self.dose_event_id} [{self.status}]"
