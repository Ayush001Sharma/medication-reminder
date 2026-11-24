"""Create demo data: patients in two timezones, a caregiver, a doctor, a week of dose history.

    python manage.py seed_demo            # create (does nothing if the demo users already exist)
    python manage.py seed_demo --reset    # delete the demo users and rebuild everything

LOCAL DEVELOPMENT ONLY. The demo accounts share one well-known password, so the command refuses
to run unless DJANGO_DEBUG is true (override with --force at your own risk). Choose the password with
--password or the DEMO_PASSWORD environment variable; the default is documented in the README.

The history is deterministic (fixed random seed) and looks like real use: most doses taken on time,
some taken late, some skipped, some missed, the most recent doses still open.
"""
import os
import random
from datetime import timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from accounts.models import AccessGrant, GrantStatus, PatientProfile, Role, User
from medications.models import Medication
from notifications import conf
from notifications.models import NotificationLog, NotificationStatus
from reports import audit
from reports.ranges import build_range
from scheduling.models import DoseEvent, DoseStatus, Schedule
from scheduling.services import dose_times

DEFAULT_DEMO_PASSWORD = "demo-password-123"
HISTORY_DAYS = 7

CAREGIVER_EMAIL = "demo.carla@example.com"
DOCTOR_EMAIL = "demo.dr.rao@example.com"

# (name, dosage, instructions, local times, days of week or None for every day)
PATIENTS = [
    {
        "email": "demo.asha@example.com", "name": "Asha Patel", "timezone": "Asia/Kolkata", "seed": 1,
        "weights": {"taken": 0.85, "late": 0.05, "skipped": 0.05, "missed": 0.05},
        "tail": (DoseStatus.TAKEN, 6),  # a streak of 6 taken doses up to now
        "medications": [
            ("Metformin", "500 mg", "Take with food", ["08:00", "20:00"], None),
            ("Atorvastatin", "20 mg", "At bedtime", ["21:00"], None),
            ("Vitamin D", "1000 IU", "", ["09:00"], [0, 3]),
        ],
    },
    {
        "email": "demo.ben@example.com", "name": "Ben Carter", "timezone": "America/New_York", "seed": 2,
        "weights": {"taken": 0.60, "late": 0.08, "skipped": 0.07, "missed": 0.25},
        "tail": (DoseStatus.MISSED, 1),  # the latest resolved dose was missed: streak 0
        "medications": [
            ("Lisinopril", "10 mg", "Morning, before breakfast", ["07:30"], None),
            ("Levothyroxine", "50 mcg", "On an empty stomach", ["06:00"], None),
        ],
    },
]
DEMO_EMAILS = [p["email"] for p in PATIENTS] + [CAREGIVER_EMAIL, DOCTOR_EMAIL]


class Command(BaseCommand):
    help = "Create demo patients, a caregiver, a doctor, medications and a week of dose history (dev only)."

    def add_arguments(self, parser):
        parser.add_argument("--reset", action="store_true", help="Delete the demo users first and rebuild.")
        parser.add_argument("--force", action="store_true", help="Run even when DJANGO_DEBUG is not true.")
        parser.add_argument("--password", help="Password for all demo accounts (or env DEMO_PASSWORD).")

    def handle(self, *args, **options):
        if not settings.DEBUG and not options["force"]:
            raise CommandError("seed_demo creates accounts with a shared demo password: it only runs when "
                               "DJANGO_DEBUG=true (use --force to override).")
        password = options["password"] or os.environ.get("DEMO_PASSWORD") or DEFAULT_DEMO_PASSWORD
        if not options["reset"] and User.objects.filter(email__in=DEMO_EMAILS).exists():
            self.stdout.write("Demo data already exists. Use --reset to rebuild it.")
            return
        with transaction.atomic():
            if options["reset"]:
                User.objects.filter(email__in=DEMO_EMAILS).delete()
            self._seed(password)
        self._summary()

    # ------------------------------------------------------------------ building
    def _seed(self, password):
        now = timezone.now()
        caregiver = User.objects.create_user(CAREGIVER_EMAIL, password, role=Role.CAREGIVER, full_name="Carla Mendes")
        doctor = User.objects.create_user(DOCTOR_EMAIL, password, role=Role.DOCTOR, full_name="Dr. Rao")
        patients = {}
        for spec in PATIENTS:
            patient = User.objects.create_user(spec["email"], password, role=Role.PATIENT, full_name=spec["name"])
            PatientProfile.objects.create(user=patient, timezone=spec["timezone"])
            self._medications_and_history(patient, spec, now)
            patients[spec["email"]] = patient
        asha, ben = patients["demo.asha@example.com"], patients["demo.ben@example.com"]
        self._grant(asha, caregiver, GrantStatus.ACTIVE, now)
        self._grant(asha, doctor, GrantStatus.ACTIVE, now)
        self._grant(ben, doctor, GrantStatus.ACTIVE, now)
        self._grant(ben, caregiver, GrantStatus.PENDING, now)  # lets you try "accept" in the API
        tz = ZoneInfo("Asia/Kolkata")
        rng = build_range(now.astimezone(tz).date() - timedelta(days=6), now.astimezone(tz).date(), tz)
        audit.record_view(doctor, asha, rng)  # so the patient audit log is not empty
        audit.record_view(caregiver, asha, rng)

    @staticmethod
    def _grant(patient, grantee, status, now):
        accepted = status == GrantStatus.ACTIVE
        AccessGrant.objects.create(
            patient=patient, invited_email=grantee.email, status=status,
            grantee=grantee if accepted else None, accepted_at=now - timedelta(days=5) if accepted else None,
        )

    def _medications_and_history(self, patient, spec, now):
        tz = ZoneInfo(spec["timezone"])
        today = now.astimezone(tz).date()
        start = today - timedelta(days=HISTORY_DAYS)
        rng = random.Random(spec["seed"])
        history = []
        for name, dosage, instructions, times, days in spec["medications"]:
            medication = Medication.objects.create(
                patient=patient, name=name, dosage=dosage, instructions=instructions, start_date=start)
            kwargs = {"days_of_week": days} if days is not None else {}
            # Saving the schedule also generates the next 7 days of pending doses (signals).
            schedule = Schedule.objects.create(
                medication=medication, times_of_day=[_parse(t) for t in times], start_date=start, **kwargs)
            for instant in dose_times(schedule, start, today):
                if instant <= now:
                    history.append(self._dose(schedule, instant, now, rng, spec["weights"]))
        self._apply_tail(history, spec["tail"], now, rng)
        DoseEvent.objects.bulk_create(history)
        NotificationLog.objects.bulk_create([
            NotificationLog(
                dose_event=dose, channel="email", status=NotificationStatus.SENT, attempts=1,
                next_attempt_at=dose.reminder_sent_at, last_attempt_at=dose.reminder_sent_at,
                sent_at=dose.reminder_sent_at,
            )
            for dose in history if dose.reminder_sent_at
        ])

    def _dose(self, schedule, instant, now, rng, weights):
        medication = schedule.medication
        dose = DoseEvent(schedule=schedule, patient=medication.patient, medication=medication,
                         scheduled_at=instant, reminder_sent_at=instant - timedelta(minutes=1))
        if now - instant < conf.missed_after():  # too recent to be resolved: still open
            dose.status = DoseStatus.REMINDED
            return dose
        outcome = rng.choices(list(weights), weights=list(weights.values()))[0]
        self._resolve(dose, outcome, now, rng)
        return dose

    @staticmethod
    def _resolve(dose, outcome, now, rng):
        """Fill in status and timestamps for one finished dose."""
        dose.status = DoseStatus.TAKEN if outcome in ("taken", "late") else outcome
        if outcome == "taken":
            dose.taken_at = dose.scheduled_at + timedelta(minutes=rng.randint(0, 40))
        elif outcome in ("late", "missed"):
            dose.missed_at = dose.scheduled_at + conf.missed_after()
            if outcome == "late":
                dose.taken_late = True
                dose.taken_at = min(dose.missed_at + timedelta(minutes=rng.randint(10, 120)), now)

    def _apply_tail(self, doses, tail, now, rng):
        """Force the most recent finished doses to a status (to get a visible streak)."""
        status, count = tail
        finished = sorted((d for d in doses if d.status != DoseStatus.REMINDED), key=lambda d: d.scheduled_at)
        for dose in finished[-count:]:
            dose.taken_late, dose.taken_at, dose.missed_at = False, None, None
            self._resolve(dose, "taken" if status == DoseStatus.TAKEN else "missed", now, rng)

    # ------------------------------------------------------------------ output
    def _summary(self):
        self.stdout.write(self.style.SUCCESS("Demo data created (local development only):"))
        users = User.objects.filter(email__in=DEMO_EMAILS).order_by("role", "email")
        for user in users:
            extra = user.patient_profile.timezone if user.role == Role.PATIENT else ""
            self.stdout.write(f"  {user.role:<10} {user.email:<28} {extra}")
        self.stdout.write(f"  doses: {DoseEvent.objects.filter(patient__email__in=DEMO_EMAILS).count()} "
                          f"(history + next 7 days)")
        self.stdout.write("All demo accounts share one password: --password, else DEMO_PASSWORD, else the "
                          "default documented in the README. Log in with POST /api/auth/login/.")


def _parse(text):
    from datetime import time
    hour, minute = text.split(":")
    return time(int(hour), int(minute))
