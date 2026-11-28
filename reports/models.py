from django.conf import settings
from django.db import models
from django.db.models import Q


class AuditAction(models.TextChoices):
    REPORT_VIEW = "report_view", "Report viewed"
    WEEKLY_SUMMARY = "weekly_summary", "Weekly summary emailed"


class AuditLog(models.Model):
    """Who looked at a patient's adherence data, and when.

    Written whenever a caregiver or doctor views a report or is emailed a
    weekly summary. The viewer's email and role are copied onto the row, so
    the history stays meaningful even if that account is later deleted.
    Rows are append-only: nothing in the app updates or deletes them.
    """

    viewer = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+"
    )
    viewer_email = models.EmailField()
    viewer_role = models.CharField(max_length=20)
    patient = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="audit_entries"
    )
    action = models.CharField(max_length=20, choices=AuditAction.choices)
    range_start = models.DateField(help_text="First local date covered (patient's timezone).")
    range_end = models.DateField(help_text="Last local date covered (inclusive).")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["patient", "-created_at"], name="audit_patient_time_idx")]

    def __str__(self):
        return f"{self.viewer_email} -> patient {self.patient_id} [{self.action}]"


class SummaryStatus(models.TextChoices):
    SENDING = "sending", "Sending"
    SENT = "sent", "Sent"
    FAILED = "failed", "Failed"
    CANCELLED = "cancelled", "Cancelled"  # grant revoked before the email went out


class WeeklySummary(models.Model):
    """One weekly summary email for one patient, week and recipient.

    The unique constraint is what makes the weekly job safe to run any number
    of times: a second run cannot create, and so cannot send, the same
    summary again.
    """

    patient = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="weekly_summaries"
    )
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+"
    )
    week_start = models.DateField(help_text="Monday, in the patient's timezone.")
    week_end = models.DateField(help_text="Sunday, in the patient's timezone.")
    status = models.CharField(
        max_length=10, choices=SummaryStatus.choices, default=SummaryStatus.SENDING
    )
    attempts = models.PositiveSmallIntegerField(default=1)
    error = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-week_start", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["patient", "week_start", "recipient"], name="unique_summary_per_week_recipient"
            ),
            models.CheckConstraint(
                condition=Q(week_end__gte=models.F("week_start")), name="summary_week_ordered"
            ),
        ]

    def __str__(self):
        return f"{self.week_start} patient {self.patient_id} -> {self.recipient_id} [{self.status}]"
