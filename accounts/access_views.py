from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from config.ratelimit import InviteThrottle

from . import grants
from .access import accessible_patients
from .access_serializers import (
    AccessiblePatientSerializer, GrantSerializer, InvitationSerializer,
    InviteResponseSerializer, InviteSerializer,
)
from .models import AccessGrant, GrantStatus
from .permissions import IsGrantee, IsPatient

# One fixed answer for every valid invitation request (see grants.invite).
INVITE_DETAIL = (
    "Invitation recorded. Access starts only if that person accepts it from "
    "a caregiver or doctor account registered with this email."
)


class GrantListCreateView(APIView):
    """Patient: list your grants, or invite a caregiver/doctor by email."""

    permission_classes = [IsPatient]

    def get_throttles(self):
        # Only sending invitations is limited; listing your own grants is not.
        return [InviteThrottle()] if self.request.method == "POST" else []

    @extend_schema(responses=GrantSerializer(many=True))
    def get(self, request):
        qs = AccessGrant.objects.filter(patient=request.user).select_related("grantee")
        return Response(GrantSerializer(qs, many=True).data)

    @extend_schema(request=InviteSerializer, responses={202: InviteResponseSerializer})
    def post(self, request):
        serializer = InviteSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        grants.invite(request.user, serializer.validated_data["email"])
        return Response({"detail": INVITE_DETAIL}, status=status.HTTP_202_ACCEPTED)


class GrantRevokeView(APIView):
    """Patient: revoke a grant at any time. Takes effect on the next request."""

    permission_classes = [IsPatient]

    @extend_schema(request=None, responses=GrantSerializer)
    def post(self, request, pk):
        return Response(GrantSerializer(grants.revoke(request.user, pk)).data)


class InvitationListView(APIView):
    """Caregiver/doctor: pending invitations addressed to your email."""

    permission_classes = [IsGrantee]

    @extend_schema(responses=InvitationSerializer(many=True))
    def get(self, request):
        qs = AccessGrant.objects.filter(
            invited_email=request.user.email.lower(), status=GrantStatus.PENDING
        ).select_related("patient")
        return Response(InvitationSerializer(qs, many=True).data)


class InvitationAcceptView(APIView):
    """Caregiver/doctor: accept an invitation addressed to your email."""

    permission_classes = [IsGrantee]

    @extend_schema(request=None, responses=InvitationSerializer)
    def post(self, request, pk):
        return Response(InvitationSerializer(grants.accept(request.user, pk)).data)


class AccessiblePatientListView(APIView):
    """Caregiver/doctor: the patients who currently grant you access."""

    permission_classes = [IsGrantee]

    @extend_schema(responses=AccessiblePatientSerializer(many=True))
    def get(self, request):
        qs = accessible_patients(request.user).select_related("patient_profile").order_by("email")
        return Response(AccessiblePatientSerializer(qs, many=True).data)
