"""Database access for discovery, insurance and booking."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Protocol, cast
from uuid import UUID

from healthmcp.discovery.errors import NotFound, QuoteChanged, SlotUnavailable
from healthmcp.discovery.models import (
    AcceptanceRule,
    AppointmentSummary,
    AvailabilitySlot,
    BookingSlot,
    CandidateRow,
    ClaimMode,
    CoverageRule,
    CoverageStatus,
    InsuranceDocument,
    PatientPreferences,
    PolicyContext,
    Service,
    SourceType,
    VerificationLevel,
)
from healthmcp.shared.context import Context
from healthmcp.shared.db import Database


class DiscoveryRepository(Protocol):
    async def list_services(self, ctx: Context) -> list[Service]: ...

    async def resolve_service(
        self, ctx: Context, service_code: str | None, problem_text: str | None
    ) -> tuple[Service | None, list[Service]]: ...

    async def fetch_candidates(
        self,
        ctx: Context,
        *,
        service: Service,
        latitude: float,
        longitude: float,
        radius_km: float,
        date_from: date,
        date_to: date,
        max_candidates: int,
    ) -> list[CandidateRow]: ...

    async def fetch_policy(self, ctx: Context, on_date: date) -> PolicyContext | None: ...

    async def fetch_coverage_rules(
        self,
        ctx: Context,
        *,
        policy: PolicyContext,
        service: Service,
        on_date: date,
        through: date | None = None,
    ) -> tuple[CoverageRule, ...]: ...

    async def fetch_acceptances(
        self,
        ctx: Context,
        *,
        facility_ids: Sequence[UUID],
        policy: PolicyContext,
        service: Service,
        on_date: date,
        through: date | None = None,
    ) -> dict[UUID, tuple[AcceptanceRule, ...]]: ...

    async def fetch_preferences(self, ctx: Context) -> PatientPreferences: ...

    async def service_fee(
        self,
        ctx: Context,
        *,
        facility_id: UUID,
        service: Service,
        on_date: date,
        clinician_id: UUID | None = None,
    ) -> tuple[Decimal | None, Decimal | None]: ...

    async def get_slot(self, ctx: Context, slot_id: UUID) -> BookingSlot | None: ...

    async def facility_exists(self, ctx: Context, facility_id: UUID) -> bool: ...

    async def fetch_availability(
        self,
        ctx: Context,
        *,
        on_date: date,
        facility_id: UUID | None,
        clinician_id: UUID | None,
    ) -> list[AvailabilitySlot]: ...

    async def hold_slot(self, ctx: Context, slot_id: UUID) -> datetime: ...

    async def book_slot(
        self,
        ctx: Context,
        *,
        slot_id: UUID,
        service: Service,
        reason: str | None,
        idempotency_key: str,
        expected_fee: Decimal | None,
        expected_gap: Decimal | None,
        quoted_medicare_rebate: Decimal | None,
        quoted_insurance_benefit: Decimal | None,
        coverage_status: CoverageStatus,
        claim_mode: ClaimMode,
        verification_level: VerificationLevel | None,
    ) -> UUID: ...

    async def get_appointment(self, ctx: Context, appointment_id: UUID) -> AppointmentSummary: ...

    async def list_appointments(self, ctx: Context) -> list[AppointmentSummary]: ...

    async def cancel_appointment(
        self, ctx: Context, appointment_id: UUID, reason: str | None
    ) -> None: ...

    async def reschedule_appointment(
        self, ctx: Context, appointment_id: UUID, new_slot_id: UUID
    ) -> UUID: ...

    async def register_insurance_document(
        self, ctx: Context, *, plan_id: UUID | None, storage_path: str, file_name: str
    ) -> InsuranceDocument: ...


def _service(row: Mapping[str, Any]) -> Service:
    return Service(
        id=row["id"],
        code=row["code"],
        name=row["name"],
        category=row["category"],
        insurance_category=row["insurance_category"],
        required_specialty=row["required_specialty"],
        default_duration_minutes=row["default_duration_minutes"],
    )


def _coverage(row: Mapping[str, Any]) -> CoverageRule:
    return CoverageRule(
        id=row["id"],
        plan_id=row["plan_id"],
        service_id=row["service_id"],
        insurance_category=row["insurance_category"],
        coverage_status=CoverageStatus(row["coverage_status"]),
        benefit_type=row["benefit_type"],
        benefit_value=row["benefit_value"],
        annual_limit=row["annual_limit"],
        waiting_period_days=row["waiting_period_days"],
        requires_preauth=row["requires_preauth"],
        verification_level=VerificationLevel(row["verification_level"]),
        source_type=SourceType(row["source_type"]),
        source_url=row["source_url"],
        source_quote=row["source_quote"],
        retrieved_at=row["retrieved_at"],
        valid_from=row["valid_from"],
        valid_to=row["valid_to"],
    )


def _acceptance(row: Mapping[str, Any]) -> AcceptanceRule:
    return AcceptanceRule(
        id=row["id"],
        facility_id=row["facility_id"],
        insurer_provider_id=row["insurer_provider_id"],
        plan_id=row["plan_id"],
        service_id=row["service_id"],
        insurance_category=row["insurance_category"],
        accepted=row["accepted"],
        claim_mode=ClaimMode(row["claim_mode"]),
        verification_level=VerificationLevel(row["verification_level"]),
        source_type=SourceType(row["source_type"]),
        source_url=row["source_url"],
        source_quote=row["source_quote"],
        retrieved_at=row["retrieved_at"],
        valid_from=row["valid_from"],
        valid_to=row["valid_to"],
    )


def _candidate(row: Mapping[str, Any]) -> CandidateRow:
    return CandidateRow(
        facility_id=row["facility_id"],
        facility_name=row["facility_name"],
        facility_description=row["facility_description"],
        facility_website=row["facility_website"],
        address_line1=row["address_line1"],
        suburb=row["suburb"],
        state=row["state"],
        postcode=row["postcode"],
        timezone=row["timezone"],
        latitude=row["latitude"],
        longitude=row["longitude"],
        distance_km=row["distance_km"],
        rating=row["rating"],
        review_count=row["review_count"] or 0,
        clinician_id=row["clinician_id"],
        clinician_name=row["clinician_name"],
        clinician_type=row["clinician_type"],
        clinician_sex=row["clinician_sex"],
        specialty=row["specialty"],
        languages=tuple(row["languages"] or ()),
        offers_telehealth=row["offers_telehealth"],
        accepting_new_patients=row["accepting_new_patients"],
        service_id=row["service_id"],
        service_code=row["service_code"],
        fee=row["fee"],
        medicare_rebate=row["medicare_rebate"],
        price_checked_at=row["price_checked_at"],
        next_slot_id=row["next_slot_id"],
        next_slot_start=row["next_slot_start"],
        next_slot_local=row["next_slot_local"],
    )


def _appointment(row: Mapping[str, Any]) -> AppointmentSummary:
    return AppointmentSummary(
        appointment_id=row["appointment_id"],
        status=row["status"],
        scheduled_start=row["scheduled_start"],
        scheduled_end=row["scheduled_end"],
        facility_id=row["facility_id"],
        facility_name=row["facility_name"],
        clinician_id=row["clinician_id"],
        clinician_name=row["clinician_name"],
        service_code=row["service_code"],
        reason=row["reason"],
        quoted_fee=row["quoted_fee"],
        quoted_gap=row["quoted_gap"],
        coverage_status=row["coverage_status"],
        claim_mode=row["claim_mode"],
    )


class PgDiscoveryRepository:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def list_services(self, ctx: Context) -> list[Service]:
        async with self._db.user_tx(ctx) as sc:
            rows = await sc.fetch_all(
                """
                select id, code, name, category, insurance_category, required_specialty,
                       default_duration_minutes
                  from public.service_catalog
                 where active
                 order by category, name
                """,
                reference=True,
            )
        return [_service(row) for row in rows]

    async def resolve_service(
        self, ctx: Context, service_code: str | None, problem_text: str | None
    ) -> tuple[Service | None, list[Service]]:
        async with self._db.user_tx(ctx) as sc:
            if service_code:
                row = await sc.fetch_one(
                    """
                    select id, code, name, category, insurance_category, required_specialty,
                           default_duration_minutes
                      from public.service_catalog
                     where active and code = %(code)s
                    """,
                    {"code": service_code.strip().lower()},
                    reference=True,
                )
                return (_service(row), []) if row else (None, [])
            if not problem_text:
                return None, []
            rows = await sc.fetch_all(
                """
                select distinct s.id, s.code, s.name, s.category, s.insurance_category,
                       s.required_specialty, s.default_duration_minutes,
                       max(char_length(a.alias)) over (partition by s.id) as alias_length
                  from public.service_catalog s
                  join public.service_aliases a on a.service_id = s.id
                 where s.active
                   and (lower(%(text)s) like '%%' || lower(a.alias) || '%%'
                        or lower(%(text)s) like '%%' || lower(s.name) || '%%')
                 order by alias_length desc, s.name
                 limit 8
                """,
                {"text": problem_text.strip()},
                reference=True,
            )
        return None, [_service(row) for row in rows]

    async def fetch_candidates(
        self,
        ctx: Context,
        *,
        service: Service,
        latitude: float,
        longitude: float,
        radius_km: float,
        date_from: date,
        date_to: date,
        max_candidates: int,
    ) -> list[CandidateRow]:
        sql = """
        with base as (
          select f.id as facility_id, f.name as facility_name,
                 f.description as facility_description, f.website as facility_website,
                 f.address_line1, f.suburb, f.state, f.postcode,
                 f.timezone, f.latitude::float8 as latitude, f.longitude::float8 as longitude,
                 round((2 * 6371 * asin(sqrt(
                   power(sin(radians((f.latitude - %(lat)s)::float8) / 2), 2)
                   + cos(radians(%(lat)s::float8)) * cos(radians(f.latitude::float8))
                     * power(sin(radians((f.longitude - %(lng)s)::float8) / 2), 2)
                 )))::numeric, 2)::float8 as distance_km,
                 frs.rating::float8 as rating, frs.review_count,
                 c.id as clinician_id, c.first_name || ' ' || c.last_name as clinician_name,
                 c.clinician_type::text as clinician_type, c.sex as clinician_sex,
                 c.specialty, c.languages, c.offers_telehealth, c.accepting_new_patients
            from public.service_catalog s
            join public.clinician_services cs on cs.service_id = s.id and cs.active
            join public.clinicians c on c.id = cs.clinician_id and c.is_active
            join public.clinician_affiliations ca on ca.clinician_id = c.id
            join public.facilities f on f.id = ca.facility_id and f.is_active
             and (cs.facility_id is null or cs.facility_id = f.id)
            left join public.facility_review_summaries frs
                   on frs.facility_id = f.id and frs.source = 'google_places'
           where s.id = %(service_id)s
             and f.latitude is not null and f.longitude is not null
             and daterange(ca.valid_from, ca.valid_to, '[)')
                 && daterange(%(date_from)s, %(date_to)s, '[]')
             and (c.accepting_new_patients
                  or exists (select 1 from public.appointments a
                              where a.clinician_id = c.id
                                and a.patient_id = public.current_patient_id()
                                and a.status = 'completed'))
             and (2 * 6371 * asin(sqrt(
                   power(sin(radians((f.latitude - %(lat)s)::float8) / 2), 2)
                   + cos(radians(%(lat)s::float8)) * cos(radians(f.latitude::float8))
                     * power(sin(radians((f.longitude - %(lng)s)::float8) / 2), 2)
                 ))) <= %(radius_km)s
        )
        select b.*, s.id as service_id, s.code as service_code,
               price.fee, price.medicare_rebate, price.checked_at as price_checked_at,
               sl.id as next_slot_id, sl.starts_at as next_slot_start,
               (sl.starts_at at time zone b.timezone) as next_slot_local
          from base b
          cross join public.service_catalog s
          cross join lateral (
            select sl.id, sl.starts_at
              from public.appointment_slots sl
             where sl.clinician_id = b.clinician_id
               and sl.facility_id = b.facility_id
               and (sl.status = 'available' or (sl.status = 'held' and sl.held_until < now()))
               and sl.starts_at > now()
               and sl.ends_at - sl.starts_at >= make_interval(mins => s.default_duration_minutes)
               and (sl.starts_at at time zone b.timezone)::date
                   between %(date_from)s and %(date_to)s
               and public.affiliation_on(b.clinician_id, b.facility_id,
                                         (sl.starts_at at time zone b.timezone)::date) is not null
             order by sl.starts_at
             limit 1
          ) sl
          left join lateral (
            select sp.fee, sp.medicare_rebate, sp.updated_at as checked_at
              from public.service_prices sp
             where sp.facility_id = b.facility_id
               and sp.service_id = s.id
               and (sp.clinician_id = b.clinician_id or sp.clinician_id is null)
               and daterange(sp.valid_from, sp.valid_to, '[)')
                   @> (sl.starts_at at time zone b.timezone)::date
             order by sp.clinician_id nulls last, sp.valid_from desc
             limit 1
          ) price on true
         where s.id = %(service_id)s
         order by next_slot_start, b.distance_km, b.clinician_name
         limit %(max_candidates)s
        """
        async with self._db.user_tx(ctx) as sc:
            rows = await sc.fetch_all(
                sql,
                {
                    "service_id": service.id,
                    "lat": latitude,
                    "lng": longitude,
                    "radius_km": radius_km,
                    "date_from": date_from,
                    "date_to": date_to,
                    "max_candidates": max_candidates,
                },
            )
        return [_candidate(row) for row in rows]

    async def fetch_policy(self, ctx: Context, on_date: date) -> PolicyContext | None:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(
                """
                select pip.id as policy_id, pip.plan_id, ip.provider_id as insurer_provider_id,
                       pip.valid_from
                  from public.patient_insurance_policies pip
                  join public.insurance_plans ip on ip.id = pip.plan_id
                 where pip.id = public.policy_on(public.current_patient_id(), %(on_date)s)
                """,
                {"on_date": on_date},
            )
        return PolicyContext(**row) if row else None

    async def fetch_coverage_rules(
        self,
        ctx: Context,
        *,
        policy: PolicyContext,
        service: Service,
        on_date: date,
        through: date | None = None,
    ) -> tuple[CoverageRule, ...]:
        async with self._db.user_tx(ctx) as sc:
            rows = await sc.fetch_all(
                """
                select id, plan_id, service_id, insurance_category, coverage_status,
                       benefit_type, benefit_value, annual_limit, waiting_period_days,
                       requires_preauth, verification_level, source_type, source_url,
                       source_quote, retrieved_at, valid_from, valid_to
                  from public.insurance_service_rules
                 where plan_id = %(plan_id)s
                   and active
                   and (service_id = %(service_id)s
                        or insurance_category = %(category)s)
                   and valid_from <= coalesce(%(through)s, %(on_date)s)
                   and (valid_to is null or valid_to > %(on_date)s)
                """,
                {
                    "plan_id": policy.plan_id,
                    "service_id": service.id,
                    "category": service.insurance_category,
                    "on_date": on_date,
                    "through": through,
                },
                reference=True,
            )
        return tuple(_coverage(row) for row in rows)

    async def fetch_acceptances(
        self,
        ctx: Context,
        *,
        facility_ids: Sequence[UUID],
        policy: PolicyContext,
        service: Service,
        on_date: date,
        through: date | None = None,
    ) -> dict[UUID, tuple[AcceptanceRule, ...]]:
        if not facility_ids:
            return {}
        async with self._db.user_tx(ctx) as sc:
            rows = await sc.fetch_all(
                """
                select id, facility_id, insurer_provider_id, plan_id, service_id,
                       insurance_category, accepted, claim_mode, verification_level,
                       source_type, source_url, source_quote, retrieved_at,
                       valid_from, valid_to
                  from public.facility_insurance_acceptances
                 where facility_id = any(%(facility_ids)s::uuid[])
                   and insurer_provider_id = %(insurer)s
                   and active
                   and (plan_id is null or plan_id = %(plan_id)s)
                   and (service_id = %(service_id)s
                        or insurance_category = %(category)s
                        or (service_id is null and insurance_category is null))
                   and valid_from <= coalesce(%(through)s, %(on_date)s)
                   and (valid_to is null or valid_to > %(on_date)s)
                """,
                {
                    "facility_ids": list(facility_ids),
                    "insurer": policy.insurer_provider_id,
                    "plan_id": policy.plan_id,
                    "service_id": service.id,
                    "category": service.insurance_category,
                    "on_date": on_date,
                    "through": through,
                },
                reference=True,
            )
        grouped: dict[UUID, list[AcceptanceRule]] = defaultdict(list)
        for row in rows:
            grouped[row["facility_id"]].append(_acceptance(row))
        return {facility_id: tuple(rules) for facility_id, rules in grouped.items()}

    async def fetch_preferences(self, ctx: Context) -> PatientPreferences:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(
                """
                select preferred_languages, preferred_clinician_sex, preferred_facility_ids,
                       telehealth_ok, max_distance_km
                  from public.patient_gp_preferences
                 where patient_id = public.current_patient_id()
                """
            )
        if not row:
            return PatientPreferences()
        return PatientPreferences(
            preferred_languages=tuple(row["preferred_languages"] or ()),
            preferred_clinician_sex=row["preferred_clinician_sex"],
            preferred_facility_ids=frozenset(row["preferred_facility_ids"] or ()),
            telehealth_ok=row["telehealth_ok"],
            max_distance_km=row["max_distance_km"],
        )

    async def service_fee(
        self,
        ctx: Context,
        *,
        facility_id: UUID,
        service: Service,
        on_date: date,
        clinician_id: UUID | None = None,
    ) -> tuple[Decimal | None, Decimal | None]:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(
                """
                select fee, medicare_rebate
                  from public.service_prices
                 where facility_id = %(facility_id)s
                   and service_id = %(service_id)s
                   and (clinician_id = %(clinician_id)s or clinician_id is null)
                   and daterange(valid_from, valid_to, '[)') @> %(on_date)s
                 order by clinician_id nulls last, valid_from desc
                 limit 1
                """,
                {
                    "facility_id": facility_id,
                    "service_id": service.id,
                    "on_date": on_date,
                    "clinician_id": clinician_id,
                },
            )
        return (row["fee"], row["medicare_rebate"]) if row else (None, None)

    async def get_slot(self, ctx: Context, slot_id: UUID) -> BookingSlot | None:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(
                """
                select s.id as slot_id, s.facility_id, s.clinician_id, s.starts_at, s.ends_at,
                       (s.starts_at at time zone f.timezone) as local_start, f.timezone
                  from public.appointment_slots s
                  join public.facilities f on f.id = s.facility_id
                 where s.id = %(slot_id)s
                """,
                {"slot_id": slot_id},
            )
        if not row:
            return None
        return BookingSlot(
            slot_id=row["slot_id"],
            facility_id=row["facility_id"],
            clinician_id=row["clinician_id"],
            starts_at=row["starts_at"],
            ends_at=row["ends_at"],
            local_start=row["local_start"],
            local_date=row["local_start"].date(),
            timezone=row["timezone"],
        )

    async def facility_exists(self, ctx: Context, facility_id: UUID) -> bool:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(
                "select 1 as found from public.facilities where id = %(id)s and is_active",
                {"id": facility_id},
            )
        return row is not None

    async def fetch_availability(
        self,
        ctx: Context,
        *,
        on_date: date,
        facility_id: UUID | None,
        clinician_id: UUID | None,
    ) -> list[AvailabilitySlot]:
        async with self._db.user_tx(ctx) as sc:
            rows = await sc.fetch_all(
                """
                select s.id as slot_id, s.facility_id, f.name as facility_name,
                       s.clinician_id, c.first_name || ' ' || c.last_name as clinician_name,
                       s.starts_at, s.ends_at,
                       (s.starts_at at time zone f.timezone) as local_start, f.timezone
                  from public.appointment_slots s
                  join public.facilities f on f.id = s.facility_id
                  join public.clinicians c on c.id = s.clinician_id
                 where (s.status = 'available' or (s.status = 'held' and s.held_until < now()))
                   and s.starts_at > now()
                   and (s.starts_at at time zone f.timezone)::date = %(on_date)s
                   and (%(facility_id)s::uuid is null or s.facility_id = %(facility_id)s)
                   and (%(clinician_id)s::uuid is null or s.clinician_id = %(clinician_id)s)
                 order by s.starts_at
                """,
                {"on_date": on_date, "facility_id": facility_id, "clinician_id": clinician_id},
            )
        return [
            AvailabilitySlot(
                slot_id=row["slot_id"],
                facility_id=row["facility_id"],
                facility_name=row["facility_name"],
                clinician_id=row["clinician_id"],
                clinician_name=row["clinician_name"],
                starts_at=row["starts_at"],
                ends_at=row["ends_at"],
                local_start=row["local_start"],
                timezone=row["timezone"],
            )
            for row in rows
        ]

    async def hold_slot(self, ctx: Context, slot_id: UUID) -> datetime:
        async with self._db.user_tx(ctx) as sc:
            try:
                row = await sc.fetch_one(
                    "select public.hold_slot(%(slot_id)s) as held_until",
                    {"slot_id": slot_id},
                )
            except Exception as exc:
                if "no longer available" in str(exc).lower():
                    raise SlotUnavailable() from exc
                raise
        if not row:
            raise SlotUnavailable()
        return cast(datetime, row["held_until"])

    async def book_slot(
        self,
        ctx: Context,
        *,
        slot_id: UUID,
        service: Service,
        reason: str | None,
        idempotency_key: str,
        expected_fee: Decimal | None,
        expected_gap: Decimal | None,
        quoted_medicare_rebate: Decimal | None,
        quoted_insurance_benefit: Decimal | None,
        coverage_status: CoverageStatus,
        claim_mode: ClaimMode,
        verification_level: VerificationLevel | None,
    ) -> UUID:
        async with self._db.user_tx(ctx) as sc:
            try:
                row = await sc.fetch_one(
                    """
                    select public.book_service_slot(
                      %(slot_id)s, %(service_id)s, %(reason)s, %(key)s,
                      %(expected_fee)s, %(expected_gap)s, %(rebate)s,
                      %(benefit)s, %(coverage)s, %(claim_mode)s, %(verification)s
                    ) as appointment_id
                    """,
                    {
                        "slot_id": slot_id,
                        "service_id": service.id,
                        "reason": reason,
                        "key": idempotency_key,
                        "expected_fee": expected_fee,
                        "expected_gap": expected_gap,
                        "rebate": quoted_medicare_rebate,
                        "benefit": quoted_insurance_benefit,
                        "coverage": coverage_status.value,
                        "claim_mode": claim_mode.value,
                        "verification": verification_level.value if verification_level else None,
                    },
                )
            except Exception as exc:
                text = str(exc).lower()
                if "no longer available" in text or ("slot" in text and "taken" in text):
                    raise SlotUnavailable() from exc
                if "quote has changed" in text:
                    raise QuoteChanged(expected_gap, None) from exc
                raise
        if not row:
            raise SlotUnavailable()
        return cast(UUID, row["appointment_id"])

    async def list_appointments(self, ctx: Context) -> list[AppointmentSummary]:
        async with self._db.user_tx(ctx) as sc:
            rows = await sc.fetch_all(
                """
                select a.id as appointment_id, a.status::text as status,
                       a.scheduled_start, a.scheduled_end, a.facility_id,
                       f.name as facility_name, a.clinician_id,
                       c.first_name || ' ' || c.last_name as clinician_name,
                       s.code as service_code, a.reason, a.quoted_fee, a.quoted_gap,
                       a.coverage_status, a.claim_mode
                  from public.appointments a
                  join public.facilities f on f.id = a.facility_id
                  join public.clinicians c on c.id = a.clinician_id
                  left join public.service_catalog s on s.id = a.service_id
                 where a.patient_id = public.current_patient_id()
                 order by a.scheduled_start desc
                """
            )
        return [_appointment(row) for row in rows]

    async def get_appointment(self, ctx: Context, appointment_id: UUID) -> AppointmentSummary:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(
                """
                select a.id as appointment_id, a.status::text as status,
                       a.scheduled_start, a.scheduled_end, a.facility_id,
                       f.name as facility_name, a.clinician_id,
                       c.first_name || ' ' || c.last_name as clinician_name,
                       s.code as service_code, a.reason, a.quoted_fee, a.quoted_gap,
                       a.coverage_status, a.claim_mode
                  from public.appointments a
                  join public.facilities f on f.id = a.facility_id
                  join public.clinicians c on c.id = a.clinician_id
                  left join public.service_catalog s on s.id = a.service_id
                 where a.id = %(id)s and a.patient_id = public.current_patient_id()
                """,
                {"id": appointment_id},
            )
        if not row:
            raise NotFound()
        return _appointment(row)

    async def cancel_appointment(
        self, ctx: Context, appointment_id: UUID, reason: str | None
    ) -> None:
        async with self._db.user_tx(ctx) as sc:
            await sc.fetch_one(
                "select public.cancel_appointment(%(appointment_id)s, %(reason)s)",
                {"appointment_id": appointment_id, "reason": reason},
            )

    async def reschedule_appointment(
        self, ctx: Context, appointment_id: UUID, new_slot_id: UUID
    ) -> UUID:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(
                "select public.reschedule_appointment(%(old_id)s, %(new_id)s) as appointment_id",
                {"old_id": appointment_id, "new_id": new_slot_id},
            )
        if not row:
            raise NotFound()
        return cast(UUID, row["appointment_id"])

    async def register_insurance_document(
        self, ctx: Context, *, plan_id: UUID | None, storage_path: str, file_name: str
    ) -> InsuranceDocument:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(
                """
                insert into public.patient_insurance_documents
                  (patient_id, plan_id, storage_path, file_name)
                values (public.current_patient_id(), %(plan_id)s, %(path)s, %(name)s)
                returning id, patient_id, plan_id, storage_path, file_name, status,
                          uploaded_at, expires_at
                """,
                {"plan_id": plan_id, "path": storage_path, "name": file_name},
            )
        if not row:
            from healthmcp.discovery.errors import Forbidden

            raise Forbidden()
        return InsuranceDocument(**row)
