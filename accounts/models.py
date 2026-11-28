from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.db.models import Q
from django.db.models.functions import Lower

from .validators import validate_iana_timezone


class Role(models.TextChoices):
    PATIENT = "patient", "Patient"
    CAREGIVER = "caregiver", "Caregiver"
    DOCTOR = "doctor", "Doctor"


class UserManager(BaseUserManager):
    """Manager for a user model that logs in with email instead of username."""

    use_in_migrations = True

    def _create(self, email, password, **extra):
        if not email:
            raise ValueError("Users must have an email address.")
        user = self.model(email=self.normalize_email(email).lower(), **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email, password=None, **extra):
        extra.setdefault("role", Role.PATIENT)
        return self._create(email, password, **extra)

    def create_superuser(self, email, password=None, **extra):
        extra.setdefault("role", Role.DOCTOR)
        extra.setdefault("is_staff", True)
        extra.setdefault("is_superuser", True)
        return self._create(email, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    email = models.EmailField(unique=True)
    full_name = models.CharField(max_length=150, blank=True)
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.PATIENT)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    date_joined = models.DateTimeField(auto_now_add=True)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS: list[str] = []

    objects = UserManager()

    def __str__(self):
        return self.email


def default_notification_preferences() -> dict:
    """Email is the only live channel; sms/whatsapp are reserved for later."""
    return {"email": True, "sms": False, "whatsapp": False}


class PatientProfile(models.Model):
    """Per-patient settings. The timezone drives all schedule calculations."""

    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name="patient_profile"
    )
    timezone = models.CharField(
        max_length=64, default="UTC", validators=[validate_iana_timezone]
    )
    phone_number = models.CharField(max_length=20, blank=True)
    notification_preferences = models.JSONField(default=default_notification_preferences)

    def __str__(self):
        return f"Profile of {self.user.email}"


class GrantStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    ACTIVE = "active", "Active"
    REVOKED = "revoked", "Revoked"


class AccessGrant(models.Model):
    """A patient's permission for a caregiver or doctor to read their data.

    The invitation is addressed to an EMAIL, not to a user row, so inviting
    an address looks identical whether or not an account exists (the API
    cannot be used to discover registered emails). ``grantee`` is filled in
    only when a caregiver/doctor account with that email accepts.

    Lifecycle: pending -> active -> revoked (pending -> revoked also allowed).
    Revoked rows are kept as history, and the same email can be invited again.
    """

    patient = models.ForeignKey(User, on_delete=models.CASCADE, related_name="access_grants")
    invited_email = models.EmailField(help_text="Always stored lowercase.")
    grantee = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.CASCADE, related_name="received_grants"
    )
    status = models.CharField(
        max_length=10, choices=GrantStatus.choices, default=GrantStatus.PENDING
    )
    created_at = models.DateTimeField(auto_now_add=True)
    accepted_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            # At most one pending-or-active grant per patient and grantee.
            models.UniqueConstraint(
                fields=["patient", "invited_email"],
                condition=Q(status__in=["pending", "active"]),
                name="one_open_grant_per_patient_and_email",
            ),
            models.CheckConstraint(
                condition=Q(invited_email=Lower("invited_email")), name="grant_email_lowercase"
            ),
            models.CheckConstraint(
                condition=~Q(status="active") | Q(grantee__isnull=False),
                name="active_grant_has_grantee",
            ),
            models.CheckConstraint(
                condition=~Q(status="revoked") | Q(revoked_at__isnull=False),
                name="revoked_grant_has_timestamp",
            ),
        ]
        indexes = [
            models.Index(fields=["grantee", "status"], name="grant_grantee_status_idx"),
            models.Index(fields=["invited_email", "status"], name="grant_email_status_idx"),
        ]

    def __str__(self):
        return f"{self.patient_id} -> {self.invited_email} [{self.status}]"
