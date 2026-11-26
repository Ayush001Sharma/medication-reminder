# 05. Medications and schedules

## 1. First principles: three levels of "taking medicine"

People say "I take my tablet at 8" as if it were one thing. The system splits it into three levels, and
understanding the split is the key to this chapter:

| Level | Meaning | Example | Model |
|---|---|---|---|
| **Medication** | *What* is prescribed | "Metformin 500 mg, with food, from 1 Nov" | `Medication` |
| **Schedule** | *When*, as a repeating rule | "at 08:00 and 20:00, every day, from 1 Nov" | `Schedule` |
| **Dose** | *One concrete occurrence* | "the 20:00 dose on 25 Nov 2026, status: taken" | `DoseEvent` |

Why not put everything in one table?

* **One medication can need several rules.** A patient might take a drug twice on weekdays but once on weekends:
  two schedules for one medication.
* **A rule is not an event.** A rule says what *will* happen; each real dose needs its own status (pending,
  taken, missed...), a taken-at time, a reminder history. That is why doses are separate rows (chapter 06).
* **Rules change; history must not.** If the doctor changes the times, the *rule* is edited, while past doses
  stay exactly as they were.

This chapter covers the first two levels. Chapter 06 covers how rules become doses.

## 2. The models in short

(Full field tables are in chapter 03.) The schedule's docstring states the most important design decision:

*From `scheduling/models.py`, `Schedule`:*

```python
class Schedule(models.Model):
    """When a medication should be taken, in the patient's LOCAL time.

    ``times_of_day`` are naive wall-clock times. They are deliberately not
    converted to UTC here: converting at dose-generation time, with the
    patient's IANA zone, is what keeps 08:00 meaning 08:00 across DST changes.
    """
```

Key points:

* `Medication`: `name`, `dosage` (free text), `instructions`, `start_date`, `end_date` (nullable),
  `is_active`, owned by a patient.
* `Schedule`: `times_of_day` (array of local times), `days_of_week` (array of `0..6`, Monday is 0, matching
  Python's `date.weekday()`), `start_date`, `end_date`, `is_active`, belongs to a medication.
* Both have a database `CHECK` that an `end_date` is never before the `start_date`
  (`medication_end_not_before_start`, `schedule_end_not_before_start`).

## 3. The API

| Method and URL | What it does | Who |
|---|---|---|
| `GET /api/medications/` | List my medications (`?active=true` or `false` to filter) | Patient |
| `POST /api/medications/` | Create one | Patient |
| `GET /api/medications/<id>/` | Read one | Patient (own only) |
| `PATCH /api/medications/<id>/` | Edit (name, dosage, instructions, dates) | Patient (own only) |
| `POST /api/medications/<id>/deactivate/` | Stop it, keep the history | Patient (own only) |
| `DELETE /api/medications/<id>/` | **Not allowed: 405** | |
| `GET /api/medications/<id>/schedules/` | List its schedules | Patient (own only) |
| `POST /api/medications/<id>/schedules/` | Add a schedule | Patient (own only) |
| `GET / PATCH / DELETE /api/medications/<id>/schedules/<sid>/` | Read, edit, delete one schedule | Patient (own only) |

The routes are declared in `medications/urls.py`. The medication routes come from a DRF **router**; the
schedule routes are written by hand because they are *nested* under a medication id:

*From `medications/urls.py`:*

```python
router = DefaultRouter()
router.register("medications", MedicationViewSet, basename="medication")

urlpatterns = [
    path("", include(router.urls)),
    path(
        "medications/<int:medication_pk>/schedules/",
        ScheduleViewSet.as_view({"get": "list", "post": "create"}),
        name="schedule-list",
    ),
    path(
        "medications/<int:medication_pk>/schedules/<int:pk>/",
        ScheduleViewSet.as_view({"get": "retrieve", "patch": "partial_update", "delete": "destroy"}),
        name="schedule-detail",
    ),
]
```

## 4. The medication view, line by line

*From `medications/views.py`, `MedicationViewSet`:*

```python
    serializer_class = MedicationSerializer
    permission_classes = [IsPatient]
    http_method_names = ["get", "post", "patch", "head", "options"]
```

* `ModelViewSet` normally gives list, create, retrieve, update, partial update and **delete**. Restricting
  `http_method_names` removes `put` and `delete`. I verified `DELETE /api/medications/<id>/` returns **405**.
* **Why no delete?** Doses reference the medication (`on_delete=RESTRICT`), and deleting would erase the
  patient's adherence history. Stopping a medication is a different, safer action:

*From `medications/views.py`, `MedicationViewSet`:*

```python
    def perform_create(self, serializer):
        serializer.save(patient=self.request.user)

    @extend_schema(request=None, responses=MedicationSerializer)
    @action(detail=True, methods=["post"])
    def deactivate(self, request, pk=None):
        """Stop a medication (no new reminders); history is preserved."""
        medication = self.get_object()
        medication.is_active = False
        medication.save(update_fields=["is_active", "updated_at"])
        return Response(self.get_serializer(medication).data, status=status.HTTP_200_OK)
```

* `perform_create` is where the **owner is set from the logged-in user**, never from the request body. I
  verified that a client sending `"patient": 999` and `"is_active": false` is ignored:
  `stored is_active: True (read-only fields ignored)`.
* `deactivate` flips `is_active` and saves. That `save()` triggers a Django `post_save` signal
  (`medication_saved` in `scheduling/signals.py`), which re-syncs each of the medication's schedules and
  **deletes its future pending doses** (chapter 06). Past and already-handled doses are kept.
* `self.get_object()` uses the scoped queryset from chapter 04, so another patient's id is a 404.
* `is_active` is read-only in the serializer: there is **no API to reactivate** a medication (add it again as a
  new one). That is an intentional, documented limitation.

## 5. The schedule view: nested and scoped

*From `scheduling/views.py`, `ScheduleViewSet`:*

```python
    def get_medication(self):
        # Scoped to the requesting patient, so someone else's id is a 404.
        return get_object_or_404(
            Medication, pk=self.kwargs["medication_pk"], patient=self.request.user
        )

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Schedule.objects.none()
        return Schedule.objects.filter(medication=self.get_medication())

    def perform_create(self, serializer):
        serializer.save(medication=self.get_medication())
```

Read it as a chain of trust: first find the medication **that belongs to this patient** (otherwise 404), then
only that medication's schedules are visible. A schedule id from another medication, even your own other one,
is not reachable through the wrong parent (`test_schedule_not_reachable_through_wrong_medication`).

## 6. Validation rules

Validation happens in **serializers** (`medications/serializers.py`, `scheduling/serializers.py`). DRF runs
them in a fixed order: field type checks, then `validate_<field>` methods, then the object-level `validate`.
Errors are collected and returned as `400` with a message per field.

### Medication rules

| Rule | Where | Message I got |
|---|---|---|
| `name` and `dosage` required | model fields | `{'name': ['This field is required.']}` |
| `start_date` required | model field | standard "required" error |
| `end_date` cannot be in the past (in the **patient's** local today) | `validate_end_date` | `End date cannot be in the past.` |
| `end_date` cannot be before `start_date` | `validate` | `End date cannot be before start date.` |
| `id`, `is_active`, `created_at`, `updated_at` are read-only | `read_only_fields` | silently ignored on input |
| An unchanged `end_date` is allowed on update | `validate_end_date` | so an expired medication can still be edited |

*From `medications/serializers.py`, `MedicationSerializer`:*

```python
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
```

Three details worth knowing:

1. **"Today" is the patient's today.** `patient_today` uses the patient's own timezone:

*From `medications/utils.py`, `patient_today`:*

```python
def patient_today(user) -> date:
    """Today's date in the patient's own timezone."""
    return datetime.now(patient_timezone(user)).date()
```

   Example: at 20:00 UTC on 25 November it is already 01:30 on **26 November** in Kolkata (UTC+5:30). A
   Kolkata patient entering "end date 25 November" is entering a date in the past; a patient in New York
   (still 15:00 on the 25th) is not.
2. **Field-level rules run before object-level rules.** I tested "end before start" with an end date in the
   past and got `End date cannot be in the past.` (the field rule fired first). With both dates in the future
   I got `End date cannot be before start date.`
3. **`validate` reads from `self.instance` for partial updates.** On a `PATCH` that only changes one date, the
   other comes from the saved object, so the comparison still works
   (`getattr(self.instance, "start_date", None)`).

### Schedule rules

*From `scheduling/serializers.py`, `ScheduleSerializer`:*

```python
    times_of_day = serializers.ListField(
        child=serializers.TimeField(format="%H:%M", input_formats=["%H:%M"]),
        help_text="Local times as HH:MM, e.g. ['08:00', '20:00'].",
    )
    days_of_week = serializers.ListField(
        child=serializers.IntegerField(min_value=0, max_value=6),
        required=False,
        help_text="0=Monday .. 6=Sunday. Omit for every day.",
    )
```

```python
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
```

Real results of sending bad data (each line is a different request):

```text
ok, unsorted times -> 201 {'times_of_day': ['08:00', '20:00'], 'days_of_week': [0, 1, 2, 3, 4, 5, 6], ...}
empty times        -> 400 {'times_of_day': ['Provide at least one time of day.']}
duplicate times    -> 400 {'times_of_day': ['Duplicate times are not allowed.']}
08:00:00 format    -> 400 {'times_of_day': {'0': ['Time has wrong format. Use one of these formats instead: hh:mm.']}}
25:00              -> 400 {'times_of_day': {'0': ['Time has wrong format. Use one of these formats instead: hh:mm.']}}
day 7              -> 400 {'days_of_week': {'0': ['Ensure this value is less than or equal to 6.']}}
dup days           -> 400 {'days_of_week': ['Duplicate days are not allowed.']}
```

Observations:

* **Only `HH:MM`** is accepted (`input_formats=["%H:%M"]`); `08:00:00` is rejected. A strict, single format
  keeps the API predictable.
* **Normalised output:** times and days are **sorted** on the way in (`return sorted(value)`), so `["20:00",
  "08:00"]` is stored and returned as `["08:00", "20:00"]`.
* **`days_of_week` defaults to every day** when omitted (`default_days_of_week` in the model).
* **Errors on list items are nested** (`{'0': [...]}` means "item at index 0"). The frontend flattens this
  shape (`firstMessage` in `frontend/src/api/client.ts`).
* The `end_date` and `start_date` rules for schedules mirror the medication ones (`validate_end_date`,
  `validate`).

The tests that pin these down are in `scheduling/tests/test_schedules_api.py` (for example
`test_duplicate_times_rejected`, `test_malformed_time_rejected`, `test_invalid_days_rejected`,
`test_past_end_date_rejected`) and `medications/tests/test_medications_api.py`.

## 7. Why schedule times are stored as local clock times

This is the most important design decision in the project and the most likely interview question.

### Two different ideas of "time"

* An **instant** is one precise moment in the universe ("2026-03-08T12:00:00Z"). It is the same for everybody.
* A **wall-clock time** is what a clock on the wall shows ("08:00"). It only makes sense together with a place
  (a time zone) and a date, because what offset applies changes during the year.

A patient who says "take it at 8" means the **wall-clock** idea: 08:00 on *their* clock, every day.

### What goes wrong if you store UTC

Suppose a New York patient creates the schedule on 7 March 2026 (winter, Eastern Standard Time, UTC-5), and
the system converts 08:00 once and stores it as 13:00 UTC:

| Date | 13:00 UTC is... in New York |
|---|---|
| Sat 7 March (before the clocks change) | 08:00 (correct) |
| Sun 8 March onwards (daylight time, UTC-4) | **09:00** (an hour late, for the whole summer) |

That is a medication reminder an hour late, caused by a storage decision. Real daylight saving changes happen
twice a year in New York.

### What the project does instead

Store the **wall-clock** time (`08:00`, a naive time with no zone) in `Schedule.times_of_day`, and convert to
UTC **separately for each date**, using the patient's IANA zone, at the moment doses are generated. I ran this
for the same patient (full details in chapter 06):

```text
New York 08:00 on 2026-03-07 -> 2026-03-07T13:00:00+00:00   (winter: 08:00 is 13:00 UTC)
New York 08:00 on 2026-03-08 -> 2026-03-08T12:00:00+00:00   (summer: 08:00 is 12:00 UTC)
New York 08:00 on 2026-03-09 -> 2026-03-09T12:00:00+00:00
```

The wall clock stays at 08:00 and the UTC instant moves by an hour. That is exactly what we want.

### Other consequences of this choice

* **Moving to another timezone** moves *future* doses and leaves history alone. I ran it: a daily 08:00
  schedule for a patient in `Asia/Kolkata` produced doses at `02:30Z`; after changing the profile to
  `America/New_York` and re-syncing, the future doses were at `13:00Z`. The `post_save` signal on
  `PatientProfile` does this automatically when the profile is saved through the API (`profile_saved` in
  `scheduling/signals.py`, covered by `test_changing_patient_timezone_moves_future_doses`). My script changed
  the column with `update()`, which skips signals, and then called `sync_schedule_events` by hand.
* **`start_date` and `end_date` are local dates**, not instants. "Until 31 December" means the end of
  31 December on the patient's clock, wherever that falls in UTC.
* **The database column type shows the intent:** `times_of_day` is `time[]` (`time without time zone`), while
  `DoseEvent.scheduled_at` is `timestamp with time zone`.
* **The two forms appear at different layers.** Rules (what the user means) are local. Events (what the system
  schedules and records) are UTC instants.

## 8. What happens when you save a schedule (a preview of chapter 06)

When `POST /api/medications/<id>/schedules/` succeeds, Django saves the `Schedule`, which fires the
`post_save` signal:

*From `scheduling/signals.py`:*

```python
@receiver(post_save, sender=Schedule)
def schedule_saved(sender, instance, **kwargs):
    sync_schedule_events(instance.pk)
```

`sync_schedule_events` creates the dose rows for the next 7 days right away, so the patient sees upcoming
doses immediately. Beat's daily job later tops up the window. Signals (rather than code inside the view) were
chosen so that edits made in the admin or a shell are covered too (the docstring at the top of
`scheduling/signals.py` says so). Editing or deleting a schedule, or deactivating the medication, uses the
same machinery: the same signals re-sync the doses.

## 9. Try it yourself

1. Start the server (`python manage.py runserver`) and open `http://localhost:8000/api/docs/`.
2. Register a patient with timezone `Asia/Kolkata`, log in, and click "Authorize" in Swagger with the access
   token.
3. `POST /api/medications/` with `{"name": "Metformin", "dosage": "500 mg", "start_date": "2026-11-20"}`.
4. `POST /api/medications/<id>/schedules/` with `{"times_of_day": ["20:00", "08:00"], "start_date":
   "2026-11-20"}`. Note the times come back sorted.
5. `GET /api/doses/upcoming/`. The doses already exist.
6. Try the invalid inputs from section 6 and read each message.
7. `POST /api/medications/<id>/deactivate/`, then `GET /api/doses/upcoming/` again: the future pending doses
   are gone.

## Interview questions on this chapter

1. **Q: Why separate Medication, Schedule and DoseEvent?**
   **A:** They answer different questions. A medication is *what*, a schedule is a repeating *rule*, a dose is
   one *occurrence* with its own status and history. One medication can have several schedules, and rules can
   change without touching the history of past doses.

2. **Q: Why are schedule times stored as local wall-clock times instead of UTC?**
   **A:** "8 am" means 8 on the patient's clock. If I stored the UTC value computed in winter, a New York
   patient's reminder would arrive at 9 am after the clocks change. So I store the naive local time
   (`time without time zone`) and convert to UTC per date, with the patient's IANA zone, when generating doses.

3. **Q: Why can't a medication be deleted?**
   **A:** Doses reference it with `on_delete=RESTRICT` and the viewset disallows `DELETE`, because deleting
   would destroy adherence history. Instead there is a `deactivate` action that stops reminders (by deleting
   only future pending doses) and keeps everything else.

4. **Q: How do you stop a patient creating a schedule on someone else's medication?**
   **A:** `ScheduleViewSet.get_medication` fetches the medication with `patient=request.user` via
   `get_object_or_404`. If it is not yours you get 404, and the schedule queryset is filtered by that
   medication, so there is no way to reach another patient's rows.

5. **Q: Why does a client sending `is_active: false` or `patient: 999` on create have no effect?**
   **A:** Those fields are `read_only_fields` in the serializer, so DRF ignores them on input.
   `perform_create` sets the owner from `request.user`. Never trust ownership from the request body.

6. **Q: A user in Kolkata sets `end_date` to "today" on the evening of the 25th UTC. Is that valid?**
   **A:** It depends on their local date. `patient_today` uses the patient's timezone. At 20:00 UTC it is
   already the 26th in Kolkata, so a 25 November end date is "in the past" there and is rejected; a New York
   patient at the same instant is still on the 25th and is accepted.

7. **Q: What does `validate_end_date` do on update, and why the `unchanged` check?**
   **A:** It rejects end dates in the past, but if the value equals the stored end date it is allowed, so a
   medication that has already expired can still have its name or instructions edited without the validator
   complaining about the old date.

8. **Q: Why sort the times and reject duplicates in validation?**
   **A:** Normalised data is easier to compare and display, and duplicates would be meaningless (the unique
   dose constraint would collapse them anyway). Rejecting early gives a clear error instead of silent merging.

9. **Q: What triggers dose generation when a schedule is saved?**
   **A:** A `post_save` signal receiver (`schedule_saved`) calls `sync_schedule_events`. Using a signal rather
   than view code covers admin and shell edits. Beat's daily `generate_upcoming_doses` job also runs it, and
   it is idempotent.

10. **Q: Why does `times_of_day` use `HH:MM` only?**
    **A:** A single strict input format keeps the API predictable and avoids ambiguity. Seconds make no sense
    for a medication time, so `08:00:00` is rejected with a clear message.

## Common mistakes to avoid

* **Storing the converted UTC time in the schedule.** It will drift by an hour across daylight saving changes.
* **Using the server's date for "today".** "Today" is the patient's local date; use `patient_today`.
* **Trusting ownership fields from the client.** Set the owner from `request.user`.
* **Adding a DELETE for convenience.** It would erase history and conflict with `RESTRICT`.
* **Forgetting that `PATCH` is partial.** Object-level validation must read missing fields from
  `self.instance`, as `validate` does.
* **Confusing field-level and object-level validation order.** `validate_<field>` runs before `validate`, so a
  message from the first can hide the second.
* **Treating `days_of_week` as 1 to 7 or Sunday-first.** It is `0 = Monday ... 6 = Sunday`, matching
  `date.weekday()`.
* **Assuming doses only appear after Beat's nightly job runs.** Doses for the next 7 days are created
  immediately when a schedule is saved; the daily job only tops them up.
