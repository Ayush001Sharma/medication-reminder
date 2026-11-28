from django.contrib.auth.password_validation import validate_password
from django.db import transaction
from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from .models import PatientProfile, Role, User
from .validators import validate_iana_timezone

PREFERENCE_KEYS = {"email", "sms", "whatsapp"}


def validate_preferences(value):
    """Only known channels, with boolean values."""
    if not isinstance(value, dict):
        raise serializers.ValidationError("Must be an object.")
    unknown = set(value) - PREFERENCE_KEYS
    if unknown:
        raise serializers.ValidationError(f"Unknown channels: {sorted(unknown)}")
    if not all(isinstance(v, bool) for v in value.values()):
        raise serializers.ValidationError("Values must be true or false.")
    return value


class PatientProfileSerializer(serializers.ModelSerializer):
    timezone = serializers.CharField(validators=[validate_iana_timezone])
    notification_preferences = serializers.JSONField(required=False)

    class Meta:
        model = PatientProfile
        fields = ["timezone", "phone_number", "notification_preferences"]

    def validate_notification_preferences(self, value):
        return validate_preferences(value)


class UserSerializer(serializers.ModelSerializer):
    """Read/update representation used by /me/."""

    patient_profile = PatientProfileSerializer(required=False)

    class Meta:
        model = User
        fields = ["id", "email", "full_name", "role", "patient_profile"]
        read_only_fields = ["id", "email", "role"]

    def update(self, instance, validated_data):
        profile_data = validated_data.pop("patient_profile", None)
        instance = super().update(instance, validated_data)
        if profile_data is not None and instance.role == Role.PATIENT:
            profile = instance.patient_profile
            for key, value in profile_data.items():
                setattr(profile, key, value)
            profile.save()
        return instance


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, style={"input_type": "password"})
    timezone = serializers.CharField(
        required=False, validators=[validate_iana_timezone],
        help_text="IANA timezone, e.g. Asia/Kolkata. Required for patients.",
    )
    phone_number = serializers.CharField(required=False, allow_blank=True, max_length=20)

    class Meta:
        model = User
        fields = ["email", "password", "full_name", "role", "timezone", "phone_number"]

    def validate_email(self, value):
        value = value.lower()
        if User.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError("A user with this email already exists.")
        return value

    def validate_password(self, value):
        validate_password(value)
        return value

    def validate(self, attrs):
        if attrs.get("role", Role.PATIENT) == Role.PATIENT and not attrs.get("timezone"):
            raise serializers.ValidationError(
                {"timezone": "Patients must provide an IANA timezone."}
            )
        return attrs

    @transaction.atomic
    def create(self, validated_data):
        timezone = validated_data.pop("timezone", None)
        phone = validated_data.pop("phone_number", "")
        user = User.objects.create_user(**validated_data)
        if user.role == Role.PATIENT:
            PatientProfile.objects.create(user=user, timezone=timezone, phone_number=phone)
        return user

    def to_representation(self, instance):
        return UserSerializer(instance).data


class EmailTokenObtainPairSerializer(TokenObtainPairSerializer):
    """Login with email + password; adds the role to the token claims."""

    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        token["role"] = user.role
        return token
