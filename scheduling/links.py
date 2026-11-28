"""Signed one-click "mark as taken" links for reminder emails.

The token is ``django.core.signing`` output (signed with SECRET_KEY plus a
purpose-specific salt, timestamped) carrying the dose id AND the patient id.
It expires after 24 hours. Using it twice is safe because the action behind
it is idempotent. The patient id is re-checked against the dose on every
use, and the dose is read from the token only, so a token for one dose can
never act on another.
"""
from django.conf import settings
from django.core import signing
from django.urls import reverse

SALT = "scheduling.dose-taken-link"
LINK_MAX_AGE_SECONDS = 24 * 60 * 60


class LinkInvalid(Exception):
    """Bad signature, wrong purpose, or malformed payload."""


class LinkExpired(LinkInvalid):
    """Correctly signed but older than 24 hours."""


def make_token(dose) -> str:
    return signing.dumps({"dose": dose.pk, "patient": dose.patient_id}, salt=SALT)


def read_token(token: str) -> tuple[int, int]:
    """Return ``(dose_id, patient_id)`` or raise LinkInvalid / LinkExpired."""
    try:
        data = signing.loads(token, salt=SALT, max_age=LINK_MAX_AGE_SECONDS)
        dose_id, patient_id = data["dose"], data["patient"]
    except signing.SignatureExpired:  # subclass of BadSignature: check first
        raise LinkExpired("This link has expired.")
    except (signing.BadSignature, KeyError, TypeError):
        raise LinkInvalid("This link is not valid.")
    if not (isinstance(dose_id, int) and isinstance(patient_id, int)):
        raise LinkInvalid("This link is not valid.")
    return dose_id, patient_id


def dose_link(dose) -> str:
    """Absolute URL of the confirmation page for ``dose``."""
    path = reverse("dose-link", args=[make_token(dose)])
    return settings.SITE_BASE_URL.rstrip("/") + path
