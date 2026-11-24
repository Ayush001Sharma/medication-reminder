from datetime import date

from medications.models import Medication
from scheduling.models import DoseEvent, DoseStatus


def create_dose(patient, scheduled_at, status=DoseStatus.PENDING, medication=None):
    """A dose with no schedule (as if its schedule was deleted): keeps tests
    independent of on-save generation."""
    med = medication or Medication.objects.filter(patient=patient).first() or Medication.objects.create(
        patient=patient, name="Metformin", dosage="500 mg", instructions="With food",
        start_date=date(2026, 1, 1),
    )
    return DoseEvent.objects.create(patient=patient, medication=med, scheduled_at=scheduled_at, status=status)
