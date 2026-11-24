from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from medications.models import Medication
from medications.utils import patient_timezone, patient_today

from .models import DoseEvent, Schedule


class ScheduleSerializer(serializers.ModelSerializer):
    times_of_day = serializers.ListField(
        child=serializers.TimeField(format="%H:%M", input_formats=["%H:%M"]),
        help_text="Local times as HH:MM, e.g. ['08:00', '20:00'].",
    )
    days_of_week = serializers.ListField(
        child=serializers.IntegerField(min_value=0, max_value=6),
        required=False,
        help_text="0=Monday .. 6=Sunday. Omit for every day.",
    )

    class Meta:
        model = Schedule
        fields = ["id", "times_of_day", "days_of_week", "start_date", "end_date",
                  "is_active", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]

    def validate_times_of_day(self, value):
        if not value:
            raise serializers.ValidationError("Provide at least one time of day.")
        if len(set(value)) != len(value):
            raise serializers.ValidationError("Duplicate times are not allowed.")
        return sorted(value)

    def validate_days_of_week(self, value):
        if not value:
            raise serializers.ValidationError("Provide at least one day, or omit for every day.")
        if len(set(value)) != len(value):
            raise serializers.ValidationError("Duplicate days are not allowed.")
        return sorted(value)

    def validate_end_date(self, value):
        """No past end dates; an unchanged value on update is tolerated."""
        unchanged = self.instance is not None and value == self.instance.end_date
        if value and not unchanged and value < patient_today(self.context["request"].user):
            raise serializers.ValidationError("End date cannot be in the past.")
        return value

    def validate(self, attrs):
        start = attrs.get("start_date", getattr(self.instance, "start_date", None))
        end = attrs.get("end_date", getattr(self.instance, "end_date", None))
        if start and end and end < start:
            raise serializers.ValidationError({"end_date": "End date cannot be before start date."})
        return attrs


class MedicationBriefSerializer(serializers.ModelSerializer):
    class Meta:
        model = Medication
        fields = ["id", "name", "dosage", "instructions"]
        read_only_fields = fields


class DoseSerializer(serializers.ModelSerializer):
    """A dose as the patient sees it: UTC instant plus their local time."""

    medication = MedicationBriefSerializer(read_only=True)
    scheduled_local = serializers.SerializerMethodField()

    class Meta:
        model = DoseEvent
        fields = [
            "id", "medication", "scheduled_at", "scheduled_local", "status",
            "reminder_sent_at", "taken_at", "taken_late", "missed_at",
        ]
        read_only_fields = fields

    @extend_schema_field(serializers.DateTimeField())
    def get_scheduled_local(self, dose) -> str:
        tz = patient_timezone(self.context["request"].user)
        return dose.scheduled_at.astimezone(tz).isoformat()
