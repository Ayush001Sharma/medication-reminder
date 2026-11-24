from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.db import models
from django.db.models import F, Q

from medications.models import Medication

ALL_DAYS = list(range(7))  # Monday=0 ... Sunday=6, as in datetime.weekday()


def default_days_of_week() -> list[int]:
    return list(ALL_DAYS)


class Schedule(models.Model):
    """When a medication should be taken, in the patient's LOCAL time.

    ``times_of_day`` are naive wall-clock times. They are deliberately not
    converted to UTC here: converting at dose-generation time, with the
    patient's IANA zone, is what keeps 08:00 meaning 08:00 across DST changes.
    """

    medication = models.ForeignKey(
        Medication, on_delete=models.CASCADE, related_name="schedules"
    )
    times_of_day = ArrayField(models.TimeField(), help_text="Local wall-clock times.")
    days_of_week = ArrayField(
        models.SmallIntegerField(), default=default_days_of_week,
        help_text="0=Monday .. 6=Sunday. Defaults to every day.",
    )
    start_date = models.DateField()
    end_date = models.DateField(
        null=True, blank=True, help_text="Inclusive, as a date in the patient's timezone."
    )
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["start_date", "id"]
        constraints = [
            models.CheckConstraint(
                condition=Q(end_date__isnull=True) | Q(end_date__gte=F("start_date")),
                name="schedule_end_not_before_start",
            ),
        ]

    def __str__(self):
        return f"Schedule {self.pk} for medication {self.medication_id}"


class DoseStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    REMINDED = "reminded", "Reminded"
    TAKEN = "taken", "Taken"
    MISSED = "missed", "Missed"
    SKIPPED = "skipped", "Skipped"


class DoseEvent(models.Model):
    """One concrete dose at one UTC instant.

    ``patient`` and ``medication`` are stored directly and ``schedule`` is
    SET_NULL, so dose history survives when a schedule is deleted.
    The unique (schedule, scheduled_at) constraint is what makes generation
    idempotent: the same dose can never exist twice. (Rows whose schedule
    was deleted have schedule=NULL and never conflict with anything.)
    """

    schedule = models.ForeignKey(
        Schedule, null=True, blank=True, on_delete=models.SET_NULL, related_name="dose_events"
    )
    patient = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="dose_events"
    )
    # RESTRICT: a medication with dose history cannot be deleted on its own
    # (deactivate it instead), but deleting the whole patient account still
    # cascades, because the doses are deleted in the same operation.
    medication = models.ForeignKey(
        Medication, on_delete=models.RESTRICT, related_name="dose_events"
    )
    scheduled_at = models.DateTimeField(help_text="UTC instant of the dose.")
    status = models.CharField(
        max_length=10, choices=DoseStatus.choices, default=DoseStatus.PENDING
    )
    reminder_sent_at = models.DateTimeField(null=True, blank=True)
    taken_at = models.DateTimeField(null=True, blank=True)
    missed_at = models.DateTimeField(
        null=True, blank=True, help_text="When the dose was marked missed (for reports)."
    )
    taken_late = models.BooleanField(
        default=False,
        help_text="True when the dose was marked taken after it had already become missed.",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["scheduled_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["schedule", "scheduled_at"], name="unique_dose_per_schedule_time"
            ),
        ]
        indexes = [
            models.Index(fields=["status", "scheduled_at"], name="dose_status_time_idx"),
            models.Index(fields=["patient", "scheduled_at"], name="dose_patient_time_idx"),
        ]

    def __str__(self):
        return f"{self.medication_id} @ {self.scheduled_at:%Y-%m-%d %H:%M}Z [{self.status}]"
