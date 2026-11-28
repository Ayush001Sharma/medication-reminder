from rest_framework import serializers

from .models import AuditLog


class CountsSerializer(serializers.Serializer):
    total = serializers.IntegerField(help_text="taken + missed + skipped")
    taken = serializers.IntegerField(help_text="Includes late doses.")
    taken_late = serializers.IntegerField(help_text="Subset of taken, recorded after the dose became missed.")
    missed = serializers.IntegerField()
    skipped = serializers.IntegerField(help_text="Reported separately; not in the percentage.")
    adherence_percent = serializers.FloatField(allow_null=True, help_text="taken / (taken + missed) * 100")


class MedicationBreakdownSerializer(CountsSerializer):
    medication_id = serializers.IntegerField()
    name = serializers.CharField()
    dosage = serializers.CharField()


class ReportPatientSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    full_name = serializers.CharField(allow_blank=True)
    timezone = serializers.CharField()


class ReportRangeSerializer(serializers.Serializer):
    # "from" is a Python keyword, so the field is declared via its source key.
    to = serializers.DateField()
    timezone = serializers.CharField()
    start_utc = serializers.DateTimeField()
    end_utc = serializers.DateTimeField()

    def to_representation(self, instance):
        data = super().to_representation(instance)
        return {"from": serializers.DateField().to_representation(instance["from"]), **data}


class AdherenceReportSerializer(serializers.Serializer):
    patient = ReportPatientSerializer()
    range = ReportRangeSerializer()
    generated_at = serializers.DateTimeField()
    definition = serializers.CharField()
    totals = CountsSerializer()
    medications = MedicationBreakdownSerializer(many=True)
    current_streak = serializers.IntegerField(
        help_text="Consecutive taken doses ending now; a missed dose ends it."
    )


class AuditLogSerializer(serializers.ModelSerializer):
    class Meta:
        model = AuditLog
        fields = ["id", "action", "viewer_email", "viewer_role", "range_start", "range_end", "created_at"]
        read_only_fields = fields
