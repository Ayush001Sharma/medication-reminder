from .models import AuditAction, AuditLog


def record_view(viewer, patient, rng, action: str = AuditAction.REPORT_VIEW) -> AuditLog:
    """Append an audit row. Raises on failure, so no data is returned unaudited."""
    return AuditLog.objects.create(
        viewer=viewer, viewer_email=viewer.email, viewer_role=viewer.role, patient=patient,
        action=action, range_start=rng.start_date, range_end=rng.end_date,
    )
