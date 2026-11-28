from django.conf import settings
from django.db import models
from django.db.models import F, Q


class Medication(models.Model):
    """A prescription entry owned by one patient."""

    patient = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="medications"
    )
    name = models.CharField(max_length=200)
    dosage = models.CharField(max_length=200, help_text="Free text, e.g. '500 mg' or '2 tablets'.")
    instructions = models.TextField(blank=True)
    start_date = models.DateField()
    end_date = models.DateField(null=True, blank=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-is_active", "name", "id"]
        constraints = [
            models.CheckConstraint(
                condition=Q(end_date__isnull=True) | Q(end_date__gte=F("start_date")),
                name="medication_end_not_before_start",
            ),
        ]

    def __str__(self):
        return f"{self.name} ({self.patient_id})"
