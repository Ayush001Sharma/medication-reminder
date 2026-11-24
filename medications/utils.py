from datetime import date, datetime
from zoneinfo import ZoneInfo


def patient_today(user) -> date:
    """Today's date in the patient's own timezone (UTC if no profile)."""
    profile = getattr(user, "patient_profile", None)
    tz = ZoneInfo(profile.timezone) if profile else ZoneInfo("UTC")
    return datetime.now(tz).date()
