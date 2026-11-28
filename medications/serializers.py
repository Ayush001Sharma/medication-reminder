from rest_framework import serializers

from .models import Medication
from .utils import patient_today


class MedicationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Medication
        fields = [
            "id", "name", "dosage", "instructions", "start_date", "end_date",
            "is_active", "created_at", "updated_at",
        ]
        # Use POST .../deactivate/ to change is_active.
        read_only_fields = ["id", "is_active", "created_at", "updated_at"]

    def validate_end_date(self, value):
        """Reject end dates in the past (patient's local today).

        On update, an unchanged end date is allowed so an already-expired
        medication can still have its other fields edited.
        """
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
