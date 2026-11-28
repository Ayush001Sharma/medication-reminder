from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from .models import AccessGrant, GrantStatus, User


class InviteSerializer(serializers.Serializer):
    email = serializers.EmailField()

    def validate_email(self, value):
        value = value.strip().lower()
        if value == self.context["request"].user.email.lower():
            raise serializers.ValidationError("You cannot invite yourself.")
        return value


class InviteResponseSerializer(serializers.Serializer):
    detail = serializers.CharField()


class UserBriefSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "email", "full_name", "role"]
        read_only_fields = fields


class GrantSerializer(serializers.ModelSerializer):
    """The patient's view of a grant.

    ``grantee`` is shown only once the invitation is accepted, so a pending
    invitation looks the same whether or not the email has an account.
    """

    grantee = serializers.SerializerMethodField()

    class Meta:
        model = AccessGrant
        fields = ["id", "invited_email", "status", "grantee", "created_at", "accepted_at", "revoked_at"]
        read_only_fields = fields

    @extend_schema_field(UserBriefSerializer(allow_null=True))
    def get_grantee(self, grant):
        if grant.status == GrantStatus.PENDING or grant.grantee is None:
            return None
        return UserBriefSerializer(grant.grantee).data


class InvitationSerializer(serializers.ModelSerializer):
    """The invited caregiver/doctor's view: who invited them."""

    patient = UserBriefSerializer(read_only=True)

    class Meta:
        model = AccessGrant
        fields = ["id", "patient", "status", "created_at", "accepted_at"]
        read_only_fields = fields


class AccessiblePatientSerializer(serializers.ModelSerializer):
    timezone = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "email", "full_name", "timezone"]
        read_only_fields = fields

    def get_timezone(self, user) -> str:
        profile = getattr(user, "patient_profile", None)
        return profile.timezone if profile else "UTC"
