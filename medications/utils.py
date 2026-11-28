from datetime import date, datetime
from zoneinfo import ZoneInfo

UTC = ZoneInfo("UTC")


def patient_timezone(user) -> ZoneInfo:
    """The patient's IANA zone as a ZoneInfo (UTC if the user has no profile)."""
    profile = getattr(user, "patient_profile", None)
    return ZoneInfo(profile.timezone) if profile else UTC


def patient_today(user) -> date:
    """Today's date in the patient's own timezone."""
    return datetime.now(patient_timezone(user)).date()
