"""Patient actions on a dose: taken / skipped.

Rules (anything not listed is rejected with DoseConflict):

* taken:   from pending, reminded or missed. A dose that was already
           ``missed`` keeps ``missed_at`` and is flagged ``taken_late``.
* skipped: from pending or reminded.
* Repeating the same action is a safe no-op (idempotent).
* A taken dose is final: it cannot become skipped, and the missed-dose job
  only touches pending/reminded rows, so it can never become missed either.

Each action runs in one transaction on a ``SELECT ... FOR UPDATE`` of the
dose row, so two simultaneous requests (a double click, a link and the app,
the missed-dose job) are serialised and the first one wins.
"""
from datetime import datetime

from django.db import transaction
from django.utils import timezone

from .models import DoseEvent, DoseStatus

TAKEABLE = {DoseStatus.PENDING, DoseStatus.REMINDED, DoseStatus.MISSED}
SKIPPABLE = {DoseStatus.PENDING, DoseStatus.REMINDED}


class DoseConflict(Exception):
    """The dose's current status does not allow the requested action."""


def _lock(dose_id: int, patient_id: int) -> DoseEvent:
    """Lock the dose, scoped to its patient. Raises DoseEvent.DoesNotExist."""
    return (
        DoseEvent.objects.select_for_update(of=("self",))
        .select_related("medication")
        .get(pk=dose_id, patient_id=patient_id)
    )


def mark_taken(dose_id: int, patient_id: int, *, now: datetime | None = None):
    """Mark a dose taken. Returns ``(dose, changed)``; ``changed`` is False on a repeat."""
    now = now or timezone.now()
    with transaction.atomic():
        dose = _lock(dose_id, patient_id)
        if dose.status == DoseStatus.TAKEN:
            return dose, False
        if dose.status not in TAKEABLE:
            raise DoseConflict(f"A {dose.status} dose cannot be marked taken.")
        dose.taken_late = dose.status == DoseStatus.MISSED
        dose.status = DoseStatus.TAKEN
        dose.taken_at = now
        dose.save(update_fields=["status", "taken_at", "taken_late"])
        return dose, True


def mark_skipped(dose_id: int, patient_id: int):
    """Mark a dose skipped. Returns ``(dose, changed)``."""
    with transaction.atomic():
        dose = _lock(dose_id, patient_id)
        if dose.status == DoseStatus.SKIPPED:
            return dose, False
        if dose.status not in SKIPPABLE:
            raise DoseConflict(f"A {dose.status} dose cannot be marked skipped.")
        dose.status = DoseStatus.SKIPPED
        dose.save(update_fields=["status"])
        return dose, True
