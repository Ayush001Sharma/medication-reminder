"""Adherence calculation, done with database aggregation (no Python loops).

DEFINITION
==========
Only doses that are DUE are counted: scheduled_at <= now. Future doses, and
due doses still ``pending`` or ``reminded`` (not resolved yet), are never
counted anywhere in the report.

    taken    = due doses with status taken (includes late ones)
    taken_late = the subset of ``taken`` that was recorded after the dose
                 had already become missed (reported separately)
    missed   = due doses with status missed
    skipped  = due doses the patient chose to skip (reported separately)
    total    = taken + missed + skipped   (resolved due doses)

    adherence % = taken / (taken + missed) * 100, rounded to 1 decimal.
    Skipped doses are NOT in the percentage. It is null when there is no
    taken or missed dose in the range.

    current_streak = number of consecutive taken doses, most recent first,
    ending now. A missed dose ends the streak; skipped, pending and future
    doses are ignored. It is "as of now" and does not depend on the range.
"""
from datetime import datetime

from django.db.models import Count, Max, Q

from medications.utils import patient_timezone
from scheduling.models import DoseEvent, DoseStatus

from .ranges import LocalRange

DEFINITION = (
    "adherence % = taken / (taken + missed). Late doses count as taken (and are reported as "
    "taken_late). Skipped doses are reported separately and left out of the percentage. "
    "Pending, reminded and future doses are never counted."
)

_COUNTS = {
    "taken": Count("pk", filter=Q(status=DoseStatus.TAKEN)),
    "taken_late": Count("pk", filter=Q(status=DoseStatus.TAKEN, taken_late=True)),
    "missed": Count("pk", filter=Q(status=DoseStatus.MISSED)),
    "skipped": Count("pk", filter=Q(status=DoseStatus.SKIPPED)),
}


def adherence_percent(taken: int, missed: int) -> float | None:
    """taken / (taken + missed) as a percentage, or None when undefined."""
    denominator = taken + missed
    return None if denominator == 0 else round(100 * taken / denominator, 1)


def _with_derived(counts: dict) -> dict:
    return {
        **counts,
        "total": counts["taken"] + counts["missed"] + counts["skipped"],
        "adherence_percent": adherence_percent(counts["taken"], counts["missed"]),
    }


def current_streak(patient, now: datetime) -> int:
    """Taken doses since the most recent missed dose (two aggregate queries)."""
    taken = DoseEvent.objects.filter(patient=patient, status=DoseStatus.TAKEN, scheduled_at__lte=now)
    last_missed = DoseEvent.objects.filter(
        patient=patient, status=DoseStatus.MISSED, scheduled_at__lte=now
    ).aggregate(at=Max("scheduled_at"))["at"]
    if last_missed is not None:
        taken = taken.filter(scheduled_at__gt=last_missed)
    return taken.count()


def adherence_report(patient, rng: LocalRange, now: datetime) -> dict:
    """The full report for one patient and local date range. Four queries, any size."""
    doses = DoseEvent.objects.filter(
        patient=patient, scheduled_at__gte=rng.start_utc, scheduled_at__lt=rng.end_utc,
        scheduled_at__lte=now, status__in=[DoseStatus.TAKEN, DoseStatus.MISSED, DoseStatus.SKIPPED],
    ).order_by()  # clear default ordering so it cannot leak into GROUP BY

    totals = doses.aggregate(**_COUNTS)
    per_medication = (
        doses.values("medication_id", "medication__name", "medication__dosage")
        .annotate(**_COUNTS)
        .order_by("medication__name", "medication_id")
    )
    return {
        "patient": {
            "id": patient.pk, "full_name": patient.full_name, "timezone": patient_timezone(patient).key,
        },
        "range": {
            "from": rng.start_date, "to": rng.end_date, "timezone": rng.timezone,
            "start_utc": rng.start_utc, "end_utc": rng.end_utc,
        },
        "generated_at": now,
        "definition": DEFINITION,
        "totals": _with_derived(totals),
        "medications": [
            {
                "medication_id": row["medication_id"], "name": row["medication__name"],
                "dosage": row["medication__dosage"],
                **_with_derived({k: row[k] for k in _COUNTS}),
            }
            for row in per_medication
        ],
        "current_streak": current_streak(patient, now),
    }
