"""Who may read whose data.

Every check here is a live database query. Nothing is cached in memory, in
the JWT or in the session, so revoking a grant takes effect on the very next
request. Callers answer 404 (not 403) for "no access", so the API does not
reveal which patient ids exist.
"""
from rest_framework.exceptions import NotFound, ValidationError

from .models import AccessGrant, GrantStatus, Role, User

GRANTEE_ROLES = (Role.CAREGIVER, Role.DOCTOR)


def _active_grants():
    return AccessGrant.objects.filter(
        status=GrantStatus.ACTIVE, grantee__isnull=False, grantee__role__in=GRANTEE_ROLES,
        grantee__is_active=True,
    )


def accessible_patients(grantee):
    """Patients who currently have an ACTIVE grant to ``grantee``."""
    return User.objects.filter(
        role=Role.PATIENT,
        pk__in=_active_grants().filter(grantee=grantee).values("patient_id"),
    )


def active_grantees(patient):
    """Caregivers/doctors who currently hold an ACTIVE grant from ``patient``."""
    return User.objects.filter(
        pk__in=_active_grants().filter(patient=patient).values("grantee_id")
    ).order_by("email")


def has_active_grant(grantee, patient_id: int) -> bool:
    return _active_grants().filter(grantee=grantee, patient_id=patient_id).exists()


def resolve_patient(viewer, raw_patient_id):
    """The patient whose data ``viewer`` is asking for, or NotFound.

    * A patient may only ask for themselves (no id, or their own id).
    * A caregiver/doctor must name a patient and hold an active grant for them.
    """
    if viewer.role == Role.PATIENT:
        if raw_patient_id in (None, "") or str(raw_patient_id) == str(viewer.pk):
            return viewer
        raise NotFound()
    if viewer.role not in GRANTEE_ROLES:
        raise NotFound()
    if raw_patient_id in (None, ""):
        raise ValidationError({"patient": "This field is required."})
    try:
        patient_id = int(raw_patient_id)
    except (TypeError, ValueError):
        raise ValidationError({"patient": "Must be a whole number."})
    patient = accessible_patients(viewer).filter(pk=patient_id).select_related("patient_profile").first()
    if patient is None:
        raise NotFound()
    return patient
