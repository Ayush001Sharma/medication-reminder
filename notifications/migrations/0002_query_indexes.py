"""Partial index on unfinished sends only (built concurrently, new index before old is dropped)."""
from django.contrib.postgres.operations import AddIndexConcurrently, RemoveIndexConcurrently
from django.db import migrations, models


class Migration(migrations.Migration):
    atomic = False

    dependencies = [("notifications", "0001_initial")]

    operations = [
        AddIndexConcurrently(
            model_name="notificationlog",
            index=models.Index(
                condition=models.Q(("status", "sending")),
                fields=["next_attempt_at"], name="notif_sending_idx",
            ),
        ),
        RemoveIndexConcurrently(model_name="notificationlog", name="notif_status_next_idx"),
    ]
