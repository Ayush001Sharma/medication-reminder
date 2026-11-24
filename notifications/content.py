"""What a reminder says. Channels decide how it is delivered."""
from dataclasses import dataclass

from django.conf import settings

from medications.utils import patient_timezone


@dataclass(frozen=True)
class ReminderMessage:
    # Stable per (dose, channel): a resend after a crash carries the same key.
    idempotency_key: str
    to_email: str
    to_phone: str
    subject: str
    body: str


def build_reminder(log) -> ReminderMessage:
    """Render the reminder for a NotificationLog, in the patient's local time."""
    dose = log.dose_event
    med = dose.medication
    patient = dose.patient
    local = dose.scheduled_at.astimezone(patient_timezone(patient))
    when = local.strftime("%H:%M on %a %d %b %Y") + f" ({local.tzname()})"
    lines = [f"It's time to take {med.name} ({med.dosage}).", f"Scheduled for {when}."]
    if med.instructions:
        lines.append(f"Instructions: {med.instructions}")
    profile = getattr(patient, "patient_profile", None)
    return ReminderMessage(
        idempotency_key=f"dose-reminder-{log.pk}",
        to_email=patient.email,
        to_phone=profile.phone_number if profile else "",
        subject=f"Medication reminder: {med.name}",
        body="\n".join(lines),
    )


def message_id(message: ReminderMessage) -> str:
    domain = settings.DEFAULT_FROM_EMAIL.rpartition("@")[2] or "medreminder.local"
    return f"<{message.idempotency_key}@{domain}>"
