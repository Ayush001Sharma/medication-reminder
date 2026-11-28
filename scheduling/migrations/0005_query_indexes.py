"""Indexes for the hot queries (see the "Indexes" section of the README for the measurements).

Built CONCURRENTLY (``atomic = False``) so a large production table is not locked while an
index is created, and the new indexes are added before the old ones are dropped, so there is
never a moment without a usable index.
"""
from django.contrib.postgres.operations import AddIndexConcurrently, RemoveIndexConcurrently
from django.db import migrations, models


class Migration(migrations.Migration):
    atomic = False

    dependencies = [("scheduling", "0004_dose_taken_late")]

    operations = [
        AddIndexConcurrently(
            model_name="doseevent",
            index=models.Index(
                condition=models.Q(("status__in", ["pending", "reminded"])),
                fields=["scheduled_at"], name="dose_open_idx",
            ),
        ),
        AddIndexConcurrently(
            model_name="doseevent",
            index=models.Index(
                fields=["patient", "scheduled_at"], include=("status", "medication", "taken_late"),
                name="dose_patient_cover_idx",
            ),
        ),
        AddIndexConcurrently(
            model_name="doseevent",
            index=models.Index(
                condition=models.Q(("status", "missed")),
                fields=["patient", "scheduled_at"], name="dose_patient_missed_idx",
            ),
        ),
        RemoveIndexConcurrently(model_name="doseevent", name="dose_status_time_idx"),
        RemoveIndexConcurrently(model_name="doseevent", name="dose_patient_time_idx"),
    ]
