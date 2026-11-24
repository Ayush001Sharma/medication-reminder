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
    end_date = models.DateField(null=True, blank=True)
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
