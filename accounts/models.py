from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models

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
