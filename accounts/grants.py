"""Invite, accept and revoke access grants.

All state changes lock the grant row, so an accept racing a revoke (or two
accepts) ends in one consistent state: whichever commits first wins, and the
other sees the new status.
"""
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import NotFound

from .models import AccessGrant, GrantStatus


def invite(patient, email: str) -> None:
    """Record an invitation for ``email``. Idempotent and existence-blind.

    The same code path runs whether or not an account with that email
    exists, and a duplicate of a pending/active invitation is silently
    absorbed by the partial unique constraint (so two simultaneous invites
    cannot create two grants). The caller returns one fixed response.
    """
    try:
        with transaction.atomic():
            AccessGrant.objects.create(patient=patient, invited_email=email.strip().lower())
    except IntegrityError:
        pass  # an open grant for this email already exists: nothing to do


def accept(grantee, grant_id: int) -> AccessGrant:
    """The invited caregiver/doctor accepts. Only the matching email can.

    Accepting an already-active grant of your own is a no-op. A revoked grant
    cannot be accepted: the patient must invite again.
    """
    with transaction.atomic():
        grant = (
            AccessGrant.objects.select_for_update(of=("self",))
            .select_related("patient")
            .filter(pk=grant_id, invited_email=grantee.email.lower())
            .first()
        )
        if grant is None or grant.status == GrantStatus.REVOKED:
            raise NotFound()
        if grant.status == GrantStatus.PENDING:
            grant.status = GrantStatus.ACTIVE
            grant.grantee = grantee
            grant.accepted_at = timezone.now()
            grant.save(update_fields=["status", "grantee", "accepted_at"])
        return grant


def revoke(patient, grant_id: int) -> AccessGrant:
    """The patient revokes a pending or active grant. Repeating it is a no-op."""
    with transaction.atomic():
        grant = (
            AccessGrant.objects.select_for_update(of=("self",))
            .select_related("grantee")
            .filter(pk=grant_id, patient=patient)
            .first()
        )
        if grant is None:
            raise NotFound()
        if grant.status != GrantStatus.REVOKED:
            grant.status = GrantStatus.REVOKED
            grant.revoked_at = timezone.now()
            grant.save(update_fields=["status", "revoked_at"])
        return grant
