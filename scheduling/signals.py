"""Keep DoseEvents in sync whenever their inputs change.

Signals (rather than view code) are used so admin edits and shell edits are
covered too. Note: ``QuerySet.update()`` bypasses signals; the daily job
repairs anything missed that way.
"""
from django.db.models.signals import post_save, pre_delete
from django.dispatch import receiver

from accounts.models import PatientProfile
from medications.models import Medication

from .models import DoseEvent, Schedule
from .services import delete_future_pending, sync_schedule_events


@receiver(post_save, sender=Schedule)
def schedule_saved(sender, instance, **kwargs):
    sync_schedule_events(instance.pk)


@receiver(pre_delete, sender=Schedule)
def schedule_deleting(sender, instance, **kwargs):
    """Drop future pending doses BEFORE SET_NULL detaches them from the schedule."""
    delete_future_pending(DoseEvent.objects.filter(schedule=instance))


@receiver(post_save, sender=Medication)
def medication_saved(sender, instance, **kwargs):
    """Deactivation, reactivation or new dates: resync each of its schedules."""
    for schedule_id in instance.schedules.values_list("pk", flat=True):
        sync_schedule_events(schedule_id)


@receiver(post_save, sender=PatientProfile)
def profile_saved(sender, instance, **kwargs):
    """A timezone change moves every future local time to a new UTC instant."""
    ids = Schedule.objects.filter(medication__patient=instance.user_id).values_list("pk", flat=True)
    for schedule_id in ids:
        sync_schedule_events(schedule_id)
