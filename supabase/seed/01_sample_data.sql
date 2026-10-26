-- =====================================================================
-- SAMPLE DATA for the health booking schema
-- Run ONCE in the Supabase SQL Editor, after:
--   20261026000000_health_booking_schema.sql
--   20261026010000_security_advisor_fixes.sql
--
-- All dates are relative to today, so the data always looks current.
-- Everything is fictional (names, Medicare numbers, ABNs, phone numbers
-- use the ACMA fictitious 5550 range, emails use example.com).
--
-- The script runs as one transaction: if anything fails, nothing is saved.
-- =====================================================================
begin;

-- Act as an admin for this transaction, so staff-only rules (e.g. rating
-- moderation) accept the sample data.
select set_config('request.jwt.claims', '{"app_metadata":{"role":"admin"}}', true);

-- ---------------------------------------------------------------------
-- 1. Residency statuses
-- ---------------------------------------------------------------------
insert into public.residency_statuses (id, code, category, visa_subclass, name, medicare_eligible) values
 ('10000000-0000-4000-8000-000000000001','AU_CITIZEN','citizen',            null, 'Australian citizen',                 true),
 ('10000000-0000-4000-8000-000000000002','PR_189',    'permanent_resident', '189','Skilled Independent visa',            true),
 ('10000000-0000-4000-8000-000000000003','NZ_444',    'temporary_visa',     '444','Special Category visa (NZ citizen)',  true),
 ('10000000-0000-4000-8000-000000000004','VISA_500',  'temporary_visa',     '500','Student visa',                        false),
 ('10000000-0000-4000-8000-000000000005','VISA_482',  'temporary_visa',     '482','Skills in Demand visa',               false),
 ('10000000-0000-4000-8000-000000000006','VISA_600',  'visitor',            '600','Visitor visa',                        false),
 ('10000000-0000-4000-8000-000000000007','VISA_820',  'temporary_visa',     '820','Partner visa (temporary)',            true),
 ('10000000-0000-4000-8000-000000000008','VISA_485',  'temporary_visa',     '485','Temporary Graduate visa',             false);

-- ---------------------------------------------------------------------
-- 2. Insurance providers and plans (fictional funds)
-- ---------------------------------------------------------------------
insert into public.insurance_providers (id, name, phone, website) values
 ('20000000-0000-4000-8000-000000000001','Sunstate Health Fund',  '07 5550 0201','https://sunstate.example.com'),
 ('20000000-0000-4000-8000-000000000002','Harbourside Health',    '02 5550 0202','https://harbourside.example.com'),
 ('20000000-0000-4000-8000-000000000003','Campus Cover OSHC',     '07 5550 0203','https://campuscover.example.com'),
 ('20000000-0000-4000-8000-000000000004','Wanderer Visitor Cover','07 5550 0204','https://wanderer.example.com');

insert into public.insurance_plans (id, provider_id, plan_name, cover_type, tier) values
 ('21000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Gold Hospital',        'hospital','gold'),
 ('21000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','Silver Plus Combined', 'combined','silver'),
 ('21000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000002','Bronze Hospital',      'hospital','bronze'),
 ('21000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000002','Basic Extras',         'extras',  'basic'),
 ('21000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000003','OSHC Essentials',      'combined', null),
 ('21000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000004','Visitor Standard',     'combined', null);

-- ---------------------------------------------------------------------
-- 3. Facilities (3 in Brisbane, 1 in Sydney to show timezone handling)
-- ---------------------------------------------------------------------
insert into public.facilities (id, name, facility_type, abn, phone, email, address_line1, suburb, state, postcode, timezone, latitude, longitude) values
 ('30000000-0000-4000-8000-000000000001','Southbank Family Medical','gp_clinic','51824753556','07 5550 0101','reception@southbank-fm.example.com','123 Grey Street','South Brisbane','QLD','4101','Australia/Brisbane',-27.477500,153.020800),
 ('30000000-0000-4000-8000-000000000002','Paddington GP Clinic',    'gp_clinic','62835984177','07 5550 0102','hello@paddington-gp.example.com',   '45 Given Terrace','Paddington','QLD','4064','Australia/Brisbane',-27.460400,153.003300),
 ('30000000-0000-4000-8000-000000000003','Kedron Valley Private Hospital','hospital','73846195288','07 5550 0103','admissions@kvph.example.com','200 Gympie Road','Chermside','QLD','4032','Australia/Brisbane',-27.385600,153.031200),
 ('30000000-0000-4000-8000-000000000004','Riverside Medical Parramatta','gp_clinic','84857206399','02 5550 0104','frontdesk@riverside-med.example.com','10 Church Street','Parramatta','NSW','2150','Australia/Sydney',-33.815000,151.003500);

-- Billing history: Southbank stopped bulk billing everyone 6 months ago.
insert into public.facility_billing_policies (facility_id, billing_policy, notes, valid_from, valid_to) values
 ('30000000-0000-4000-8000-000000000001','bulk_billed','Bulk billing for all patients', '2022-01-01', current_date - 180),
 ('30000000-0000-4000-8000-000000000001','mixed','Bulk billing for concession card holders and under 16s only', current_date - 180, null),
 ('30000000-0000-4000-8000-000000000002','mixed',       null, '2021-01-01', null),
 ('30000000-0000-4000-8000-000000000003','private_only',null, '2020-01-01', null),
 ('30000000-0000-4000-8000-000000000004','bulk_billed', null, '2023-01-01', null);

-- ---------------------------------------------------------------------
-- 4. Clinicians, qualifications, registrations, affiliations
-- ---------------------------------------------------------------------
insert into public.clinicians (id, first_name, last_name, sex, email, phone, clinician_type, specialty, ahpra_registration_number) values
 ('40000000-0000-4000-8000-000000000001','Asha',  'Rao',     'female','asha.rao@example.com',      '0491 570 101','gp',        'General Practice','MED0001100001'),
 ('40000000-0000-4000-8000-000000000002','Liam',  'Nguyen',  'male',  'liam.nguyen@example.com',   '0491 570 102','gp',        'General Practice','MED0001100002'),
 ('40000000-0000-4000-8000-000000000003','Sophie','Williams','female','sophie.williams@example.com','0491 570 103','gp',       'General Practice','MED0001100003'),
 ('40000000-0000-4000-8000-000000000004','Mateo', 'Garcia',  'male',  'mateo.garcia@example.com',  '0491 570 104','specialist','Dermatology',     'MED0001100004'),
 ('40000000-0000-4000-8000-000000000005','Hannah','Kim',     'female','hannah.kim@example.com',    '0491 570 105','gp',        'General Practice','MED0001100005'),
 ('40000000-0000-4000-8000-000000000006','Grace', 'O''Connor','female','grace.oconnor@example.com','0491 570 106','nurse',     'Practice Nursing','NMW0001100006');

insert into public.clinician_qualifications (clinician_id, qualification, institution, year_awarded) values
 ('40000000-0000-4000-8000-000000000001','MBBS',   'University of Queensland', 2009),
 ('40000000-0000-4000-8000-000000000001','FRACGP', 'Royal Australian College of General Practitioners', 2014),
 ('40000000-0000-4000-8000-000000000002','MD',     'Griffith University', 2012),
 ('40000000-0000-4000-8000-000000000002','FRACGP', 'Royal Australian College of General Practitioners', 2017),
 ('40000000-0000-4000-8000-000000000003','MBBS',   'James Cook University', 2006),
 ('40000000-0000-4000-8000-000000000003','FRACGP', 'Royal Australian College of General Practitioners', 2011),
 ('40000000-0000-4000-8000-000000000004','MBBS',   'University of Sydney', 2004),
 ('40000000-0000-4000-8000-000000000004','FACD',   'Australasian College of Dermatologists', 2012),
 ('40000000-0000-4000-8000-000000000005','MD',     'University of New South Wales', 2015),
 ('40000000-0000-4000-8000-000000000005','FRACGP', 'Royal Australian College of General Practitioners', 2020),
 ('40000000-0000-4000-8000-000000000006','BNurs',  'Queensland University of Technology', 2013);

-- Registration history: Dr Williams practised with conditions until mid-2024.
insert into public.clinician_registrations (clinician_id, status, conditions, valid_from, valid_to) values
 ('40000000-0000-4000-8000-000000000001','registered', null, '2010-01-01', null),
 ('40000000-0000-4000-8000-000000000002','registered', null, '2013-01-01', null),
 ('40000000-0000-4000-8000-000000000003','registered_with_conditions','Must practise under supervision for 12 months','2023-07-01','2024-07-01'),
 ('40000000-0000-4000-8000-000000000003','registered', null, '2024-07-01', null),
 ('40000000-0000-4000-8000-000000000004','registered', null, '2005-01-01', null),
 ('40000000-0000-4000-8000-000000000005','registered', null, '2016-01-01', null),
 ('40000000-0000-4000-8000-000000000006','registered', null, '2014-01-01', null);

-- Affiliation history: Dr Rao moved from Paddington to Southbank 90 days ago.
-- Dr Nguyen works at two clinics at the same time.
insert into public.clinician_affiliations (clinician_id, facility_id, role, medicare_provider_number, valid_from, valid_to) values
 ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','GP',          '2451101J','2019-01-01', current_date - 90),
 ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','GP',          '2451102K', current_date - 90, null),
 ('40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001','GP',          '2451201A','2022-02-01', null),
 ('40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002','GP',          '2451202B','2022-02-01', null),
 ('40000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000002','GP',          '2451301C','2018-03-01', null),
 ('40000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000003','VMO',         '2451401D','2016-05-01', null),
 ('40000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000004','GP',          '2451501E','2020-08-01', null),
 ('40000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000001','Practice nurse', null,  '2021-04-01', null);

-- ---------------------------------------------------------------------
-- 5. Weekly schedules (weekday 1 = Monday ... 7 = Sunday)
-- ---------------------------------------------------------------------
insert into public.clinician_schedules (clinician_id, facility_id, weekday, start_time, end_time, slot_minutes, valid_from, valid_to)
select '40000000-0000-4000-8000-000000000001'::uuid,'30000000-0000-4000-8000-000000000002'::uuid, d, '08:30'::time,'12:30'::time,15, '2024-01-01'::date, current_date - 90 from generate_series(1,5) d   -- Dr Rao, old clinic
union all
select '40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001', d, '08:30','12:30',15, current_date - 90, null from generate_series(1,5) d    -- Dr Rao, new clinic
union all
select '40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001', d, '13:00','17:00',15, '2024-01-01', null from unnest(array[1,3,5]) d       -- Dr Nguyen, Southbank M/W/F
union all
select '40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002', d, '09:00','13:00',15, '2024-01-01', null from unnest(array[2,4]) d         -- Dr Nguyen, Paddington Tu/Th
union all
select '40000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000002', d, '09:00','12:00',20, '2024-01-01', null from generate_series(1,5) d       -- Dr Williams, 20-min slots
union all
select '40000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000003', d, '09:00','12:00',30, '2024-01-01', null from unnest(array[2,4]) d         -- Dr Garcia, specialist
union all
select '40000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000004', d, '09:00','12:00',15, '2024-01-01', null from generate_series(1,5) d       -- Dr Kim, Sydney time
union all
select '40000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000001', d, '09:00','11:00',30, '2024-01-01', null from generate_series(1,5) d;      -- Nurse O'Connor

-- ---------------------------------------------------------------------
-- 6. Patients and their history
-- ---------------------------------------------------------------------
insert into public.patients (id, first_name, last_name, preferred_name, date_of_birth, sex, email, phone, blood_type,
                             medicare_number, medicare_irn, medicare_expiry, ihi_number,
                             emergency_contact_name, emergency_contact_phone, emergency_contact_relationship) values
 ('50000000-0000-4000-8000-000000000001','Olivia','Brown',  'Liv', '1988-03-14','female','olivia.brown@example.com', '0491 570 201','O+', '2953176541',1,'2029-06-30','8003608166690503','James Brown','0491 570 211','Husband'),
 ('50000000-0000-4000-8000-000000000002','Jack',  'Wilson', null,  '1975-11-02','male',  'jack.wilson@example.com',  '0491 570 202','A-', '3164287652',1,'2028-02-28',null,'Karen Wilson','0491 570 212','Wife'),
 ('50000000-0000-4000-8000-000000000003','Priya', 'Sharma', null,  '2001-07-21','female','priya.sharma@example.com', '0491 570 203','B+', null,null,null,null,'Anil Sharma','+91 98765 43210','Father'),
 ('50000000-0000-4000-8000-000000000004','Wei',   'Chen',   null,  '1992-01-09','male',  'wei.chen@example.com',     '0491 570 204','AB+',null,null,null,null,'Lin Chen','0491 570 214','Sister'),
 ('50000000-0000-4000-8000-000000000005','Aroha', 'Ngata',  null,  '1980-05-30','female','aroha.ngata@example.com',  '0491 570 205','O-', '4275398763',2,'2027-11-30',null,'Rawiri Ngata','0491 570 215','Brother'),
 ('50000000-0000-4000-8000-000000000006','Lukas', 'Becker', null,  '1995-09-17','male',  'lukas.becker@example.com', '0491 570 206','A+', null,null,null,null,'Anna Becker','+49 151 23456789','Mother'),
 ('50000000-0000-4000-8000-000000000007','Mia',   'Brown',  null,  '2017-08-03','female','olivia.brown+mia@example.com',null,'O+','2953176541',2,'2029-06-30',null,'Olivia Brown','0491 570 201','Mother'),
 ('50000000-0000-4000-8000-000000000008','Ahmed', 'Hassan', null,  '1968-12-25','male',  'ahmed.hassan@example.com', '0491 570 208','B-', '5386409874',1,'2028-09-30',null,'Fatima Hassan','0491 570 218','Wife');

-- Address history: Olivia (and Mia) moved house 200 days ago.
insert into public.patient_addresses (patient_id, address_type, address_line1, suburb, state, postcode, valid_from, valid_to) values
 ('50000000-0000-4000-8000-000000000001','residential','8 Latrobe Terrace',     'Paddington',     'QLD','4064','2018-01-01', current_date - 200),
 ('50000000-0000-4000-8000-000000000001','residential','27 Vulture Street',     'West End',       'QLD','4101', current_date - 200, null),
 ('50000000-0000-4000-8000-000000000007','residential','8 Latrobe Terrace',     'Paddington',     'QLD','4064','2018-01-01', current_date - 200),
 ('50000000-0000-4000-8000-000000000007','residential','27 Vulture Street',     'West End',       'QLD','4101', current_date - 200, null),
 ('50000000-0000-4000-8000-000000000002','residential','14 Kedron Brook Road',  'Wilston',        'QLD','4051','2015-06-01', null),
 ('50000000-0000-4000-8000-000000000002','postal',     'PO Box 552',            'Wilston',        'QLD','4051','2015-06-01', null),
 ('50000000-0000-4000-8000-000000000003','residential','Unit 12, 30 Hope Street','South Brisbane','QLD','4101','2021-02-01', null),
 ('50000000-0000-4000-8000-000000000004','residential','5 Baroona Road',        'Milton',         'QLD','4064','2024-03-01', null),
 ('50000000-0000-4000-8000-000000000005','residential','62 Ellena Street',      'Paddington',     'QLD','4064','2019-09-01', null),
 ('50000000-0000-4000-8000-000000000006','residential','Room 4, 99 Melbourne Street','South Brisbane','QLD','4101', current_date - 60, null),
 ('50000000-0000-4000-8000-000000000008','residential','17 Marsden Street',     'Parramatta',     'NSW','2150','2012-01-01', null);

-- Residency history: Priya went from a student visa to a graduate visa 120 days ago.
insert into public.patient_residency (patient_id, residency_status_id, visa_grant_number, valid_from, valid_to) values
 ('50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001', null,           '1988-03-14', null),
 ('50000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001', null,           '1975-11-02', null),
 ('50000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004','VGN-500-118203','2021-02-01', current_date - 120),
 ('50000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000008','VGN-485-220417', current_date - 120, null),
 ('50000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000005','VGN-482-330561','2024-03-01', null),
 ('50000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000003', null,           '2019-09-01', null),
 ('50000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000006','VGN-600-441298', current_date - 60, current_date + 30),
 ('50000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000001', null,           '2017-08-03', null),
 ('50000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000002','VGN-189-552634','2012-01-01', null);

-- Insurance history (one policy at a time):
--   Olivia and Mia upgraded from Silver Plus to Gold Hospital 30 days ago.
--   Priya switched from OSHC to visitor cover when her visa changed.
--   Aroha has no private insurance.
insert into public.patient_insurance_policies (id, patient_id, plan_id, membership_number, is_primary_holder, valid_from, valid_to) values
 ('51000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000002','SHF-448210', true, '2019-01-01', current_date - 30),
 ('51000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','SHF-448210', true,  current_date - 30, null),
 ('51000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000007','21000000-0000-4000-8000-000000000002','SHF-448210', false,'2019-01-01', current_date - 30),
 ('51000000-0000-4000-8000-000000000004','50000000-0000-4000-8000-000000000007','21000000-0000-4000-8000-000000000001','SHF-448210', false, current_date - 30, null),
 ('51000000-0000-4000-8000-000000000005','50000000-0000-4000-8000-000000000002','21000000-0000-4000-8000-000000000003','HH-7781203', true, '2016-07-01', null),
 ('51000000-0000-4000-8000-000000000006','50000000-0000-4000-8000-000000000003','21000000-0000-4000-8000-000000000005','CC-2021-0457',true,'2021-02-01', current_date - 120),
 ('51000000-0000-4000-8000-000000000007','50000000-0000-4000-8000-000000000003','21000000-0000-4000-8000-000000000006','WVC-889014', true,  current_date - 120, null),
 ('51000000-0000-4000-8000-000000000008','50000000-0000-4000-8000-000000000004','21000000-0000-4000-8000-000000000006','WVC-771392', true, '2024-03-01', null),
 ('51000000-0000-4000-8000-000000000009','50000000-0000-4000-8000-000000000006','21000000-0000-4000-8000-000000000006','WVC-990215', true,  current_date - 60, current_date + 30),
 ('51000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000008','21000000-0000-4000-8000-000000000001','SHF-302991', true, '2012-02-01', null);

-- ---------------------------------------------------------------------
-- 7. Past appointments (completed, no-show, cancelled, rescheduled)
--    Inserted directly with realistic timestamps; status history is
--    written by hand below, so the automatic history trigger is paused.
-- ---------------------------------------------------------------------
alter table public.appointments disable trigger appointments_after_write;

do $$
declare
  r          record;
  v_tz       text;
  v_day      date;
  v_start    timestamptz;
  v_end      timestamptz;
  v_booked   timestamptz;
  v_checkin  timestamptz;
  v_cstart   timestamptz;
  v_cend     timestamptz;
  v_reminder timestamptz;
begin
  for r in
    select v.id::uuid as id, v.slot_id::uuid as slot_id, v.patient_id::uuid as patient_id,
           v.clinician_id::uuid as clinician_id, v.facility_id::uuid as facility_id,
           v.day_off::int as day_off, v.start_time::time as start_time, v.mins::int as mins,
           v.status::public.appointment_status as status,
           v.late_min::int as late_min, v.wait_min::int as wait_min, v.consult_min::int as consult_min,
           v.reason, v.visit_type, v.fee::numeric as fee, v.rebate::numeric as rebate, v.gap::numeric as gap,
           v.notes, v.cancel_reason, v.booked_days_before::int as booked_days_before,
           v.channel::public.booking_channel as channel
    from (values
      -- id, slot, patient, clinician, facility, day offset, start, minutes, status,
      -- arrival (min vs start), consult start (min vs start), consult length,
      -- reason, visit type, fee, rebate, gap, notes, cancel reason, booked N days before, channel
      ('60000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002',
        -120,'09:00',15,'completed', -5, 4, 12, 'Annual health check','standard', 85, 43.90, 41.10,
        'Routine check. BP 118/76. Ordered fasting bloods.', null, 6, 'web'),
      ('60000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',
        -10,'09:30',15,'completed', -8, 2, 14, 'Discuss blood test results','standard', 85, 43.90, 41.10,
        'Mildly low iron. Started oral iron supplement, repeat bloods in 3 months.', null, 3, 'mobile'),
      ('60000000-0000-4000-8000-000000000003','61000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001',
        -45,'13:00',15,'completed', 3, 35, 10, 'Lower back pain','standard', 85, 43.90, 41.10,
        'Mechanical back pain. Advised physio and simple analgesia.', null, 1, 'phone'),
      ('60000000-0000-4000-8000-000000000004','61000000-0000-4000-8000-000000000004','50000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001',
        -5,'13:30',15,'no_show', null, null, null, 'Follow-up back pain','standard', null, null, null,
        null, null, 7, 'web'),
      ('60000000-0000-4000-8000-000000000005','61000000-0000-4000-8000-000000000005','50000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000002',
        -150,'10:00',20,'completed', -2, 5, 15, 'Sore throat and fever','standard', 85, 0, 85,
        'Viral pharyngitis. Supportive care, medical certificate 2 days.', null, 0, 'mobile'),
      ('60000000-0000-4000-8000-000000000006','61000000-0000-4000-8000-000000000006','50000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000002',
        -20,'10:20',20,'completed', 0, 6, 16, 'Skin rash on arms','standard', 85, 0, 85,
        'Contact dermatitis. Topical steroid prescribed.', null, 2, 'web'),
      ('60000000-0000-4000-8000-000000000007','61000000-0000-4000-8000-000000000007','50000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002',
        -15,'09:15',15,'cancelled', null, null, null, 'Work medical certificate','standard', null, null, null,
        null, 'Feeling better, no longer needed', 4, 'web'),
      ('60000000-0000-4000-8000-000000000008','61000000-0000-4000-8000-000000000008','50000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000003',
        -8,'09:30',30,'completed', -10, 15, 25, 'Skin check - changing mole','long', 250, 0, 250,
        'Full skin check. Mole on left shoulder benign on dermoscopy; review in 12 months.', null, 21, 'phone'),
      ('60000000-0000-4000-8000-000000000009','61000000-0000-4000-8000-000000000009','50000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000001',
        -30,'09:00',30,'completed', 1, 3, 10, 'Flu vaccination','vaccination', 0, 0, 0,
        'Influenza vaccine administered, left deltoid. No immediate reaction.', null, 5, 'web'),
      ('60000000-0000-4000-8000-000000000010','61000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000007','40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',
        -3,'10:00',15,'completed', -4, 1, 11, 'Ear pain (child)','standard', 43.90, 43.90, 0,
        'Otitis media, left ear. Amoxicillin 5 days. Bulk billed (under 16).', null, 1, 'mobile'),
      ('60000000-0000-4000-8000-000000000011','61000000-0000-4000-8000-000000000011','50000000-0000-4000-8000-000000000008','40000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000004',
        -12,'09:00',15,'completed', -6, 0, 13, 'Repeat prescription - blood pressure','standard', 43.90, 43.90, 0,
        'BP well controlled on current dose. 6-month script issued.', null, 10, 'web'),
      ('60000000-0000-4000-8000-000000000012','61000000-0000-4000-8000-000000000012','50000000-0000-4000-8000-000000000006','40000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000002',
        -2,'11:00',20,'completed', 2, 4, 18, 'Sprained ankle','standard', 95, 0, 95,
        'Lateral ankle sprain, Ottawa rules negative. RICE, review if not improving in 1 week.', null, 0, 'mobile'),
      ('60000000-0000-4000-8000-000000000013','61000000-0000-4000-8000-000000000013','50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000001',
        -60,'09:30',30,'completed', -1, 2, 20, 'Cervical screening test','standard', 85, 43.90, 41.10,
        'Cervical screening collected. Results to be sent by SMS.', null, 14, 'web'),
      -- Rescheduled pair: 14 was moved to 15
      ('60000000-0000-4000-8000-000000000015','61000000-0000-4000-8000-000000000015','50000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001',
        -24,'15:00',15,'completed', -3, 5, 9, 'Medication review','standard', 85, 43.90, 41.10,
        'Reviewed asthma preventer technique. No changes.', null, 6, 'web'),
      ('60000000-0000-4000-8000-000000000014','61000000-0000-4000-8000-000000000014','50000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001',
        -25,'14:00',15,'rescheduled', null, null, null, 'Medication review','standard', null, null, null,
        null, null, 8, 'web')
    ) as v(id, slot_id, patient_id, clinician_id, facility_id, day_off, start_time, mins, status,
           late_min, wait_min, consult_min, reason, visit_type, fee, rebate, gap, notes, cancel_reason,
           booked_days_before, channel)
  loop
    select timezone into v_tz from public.facilities where id = r.facility_id;

    -- keep past visits on weekdays
    v_day := current_date + r.day_off;
    v_day := v_day - greatest(extract(isodow from v_day)::int - 5, 0);

    v_start    := (v_day + r.start_time) at time zone v_tz;
    v_end      := v_start + make_interval(mins => r.mins);
    v_booked   := v_start - make_interval(days => r.booked_days_before) - interval '3 hours';
    v_reminder := v_start - interval '1 day';
    v_checkin  := case when r.late_min    is not null then v_start + make_interval(mins => r.late_min) end;
    v_cstart   := case when r.wait_min    is not null then v_start + make_interval(mins => r.wait_min) end;
    v_cend     := case when r.consult_min is not null then v_cstart + make_interval(mins => r.consult_min) end;

    insert into public.appointment_slots (id, clinician_id, facility_id, starts_at, ends_at, status, created_at)
    values (r.slot_id, r.clinician_id, r.facility_id, v_start, v_end,
            (case when r.status in ('cancelled', 'rescheduled') then 'available' else 'booked' end)::public.slot_status,
            v_start - interval '60 days');

    insert into public.appointments (
      id, slot_id, patient_id, clinician_id, facility_id,
      clinician_affiliation_id, patient_insurance_policy_id,
      scheduled_start, scheduled_end, status, visit_type, reason,
      booking_channel, booked_at, confirmed_at, reminder_sent_at,
      checked_in_at, consult_started_at, consult_ended_at, no_show_marked_at,
      cancelled_at, cancellation_reason,
      clinical_notes, fee_charged, medicare_rebate, gap_amount, created_at)
    values (
      r.id, r.slot_id, r.patient_id, r.clinician_id, r.facility_id,
      public.affiliation_on(r.clinician_id, r.facility_id, v_day),
      public.policy_on(r.patient_id, v_day),
      v_start, v_end, r.status, r.visit_type, r.reason,
      r.channel, v_booked,
      case when r.status in ('completed', 'no_show') then v_reminder + interval '2 hours' end,
      case when r.status in ('completed', 'no_show') then v_reminder end,
      v_checkin, v_cstart, v_cend,
      case when r.status = 'no_show' then v_start + interval '30 minutes' end,
      case when r.status = 'cancelled' then v_start - interval '2 days' end,
      r.cancel_reason,
      r.notes, r.fee, r.rebate, r.gap, v_booked);

    -- status history
    insert into public.appointment_status_history (appointment_id, from_status, to_status, changed_at, changed_by)
    values (r.id, null, 'booked', v_booked, null);

    if r.status in ('completed', 'no_show') then
      insert into public.appointment_status_history (appointment_id, from_status, to_status, changed_at, changed_by)
      values (r.id, 'booked', 'confirmed', v_reminder + interval '2 hours', null);
    end if;

    if r.status = 'completed' then
      insert into public.appointment_status_history (appointment_id, from_status, to_status, changed_at, changed_by) values
        (r.id, 'confirmed',       'checked_in',      v_checkin, null),
        (r.id, 'checked_in',      'in_consultation', v_cstart,  null),
        (r.id, 'in_consultation', 'completed',       v_cend,    null);
    elsif r.status = 'no_show' then
      insert into public.appointment_status_history (appointment_id, from_status, to_status, changed_at, changed_by)
      values (r.id, 'confirmed', 'no_show', v_start + interval '30 minutes', null);
    elsif r.status = 'cancelled' then
      insert into public.appointment_status_history (appointment_id, from_status, to_status, changed_at, changed_by)
      values (r.id, 'booked', 'cancelled', v_start - interval '2 days', null);
    elsif r.status = 'rescheduled' then
      insert into public.appointment_status_history (appointment_id, from_status, to_status, changed_at, changed_by)
      values (r.id, 'booked', 'rescheduled', v_start - interval '1 day', null);
    end if;
  end loop;

  update public.appointments
     set rescheduled_to_appointment_id = '60000000-0000-4000-8000-000000000015'
   where id = '60000000-0000-4000-8000-000000000014';
end $$;

alter table public.appointments enable trigger appointments_after_write;

-- ---------------------------------------------------------------------
-- 8. Future slots, leave and an extra Saturday session
-- ---------------------------------------------------------------------
select public.generate_slots(current_date, current_date + 56);

-- Dr Williams on annual leave next week (her slots become 'blocked').
insert into public.schedule_exceptions (clinician_id, facility_id, exception_type, starts_at, ends_at, reason)
values ('40000000-0000-4000-8000-000000000003', null, 'unavailable',
        (current_date + 7)::timestamp  at time zone 'Australia/Brisbane',
        (current_date + 12)::timestamp at time zone 'Australia/Brisbane',
        'Annual leave');

-- Dr Rao runs an extra Saturday morning clinic (creates 15-min slots).
insert into public.schedule_exceptions (clinician_id, facility_id, exception_type, starts_at, ends_at, slot_minutes, reason)
select '40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'extra_session',
       (sat + time '09:00') at time zone 'Australia/Brisbane',
       (sat + time '11:00') at time zone 'Australia/Brisbane',
       15, 'Saturday flu clinic'
from (select current_date + (case when (6 - extract(isodow from current_date)::int) <= 0
                                  then 13 - extract(isodow from current_date)::int
                                  else 6 - extract(isodow from current_date)::int end) as sat) s;

-- ---------------------------------------------------------------------
-- 9. Upcoming appointments, booked through the real booking function
-- ---------------------------------------------------------------------
create temporary table seed_future (patient_id uuid, clinician_id uuid, facility_id uuid, days_ahead int, reason text, channel public.booking_channel) on commit drop;
insert into seed_future values
 ('50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001', 2,'Repeat blood test review','mobile'),
 ('50000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001', 3,'Back pain follow-up (rebooked after missed visit)','phone'),
 ('50000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000002', 1,'Rash review','web'),
 ('50000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000003', 14,'Mole removal consult','phone'),
 ('50000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000001', 4,'COVID-19 booster','web'),
 ('50000000-0000-4000-8000-000000000006','40000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000002', 5,'Ankle review','mobile'),
 ('50000000-0000-4000-8000-000000000008','40000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000004', 2,'Blood pressure check','web'),
 ('50000000-0000-4000-8000-000000000007','40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001', 6,'Ear check after antibiotics','mobile');

do $$
declare
  f      record;
  v_slot uuid;
begin
  for f in select * from seed_future loop
    select s.id into v_slot
      from public.appointment_slots s
     where s.clinician_id = f.clinician_id
       and s.facility_id  = f.facility_id
       and s.status = 'available'
       and s.starts_at >= (current_date + f.days_ahead)::timestamp at time zone 'Australia/Brisbane'
     order by s.starts_at
     limit 1;
    if v_slot is not null then
      perform public._book_slot(v_slot, f.patient_id, f.channel, f.reason, 'standard');
    end if;
  end loop;
end $$;

-- Confirm the next few bookings (as if reminder SMS were sent and answered).
update public.appointments
   set status = 'confirmed', reminder_sent_at = now() - interval '1 hour'
 where status = 'booked'
   and scheduled_start < now() + interval '4 days'
   and scheduled_start > now();

-- One upcoming booking cancelled by the patient (its slot is freed again).
update public.appointments
   set status = 'cancelled', cancellation_reason = 'Booked another time with my usual GP'
 where id = (select id from public.appointments
              where patient_id = '50000000-0000-4000-8000-000000000006'
                and scheduled_start > now()
              order by scheduled_start limit 1);

-- ---------------------------------------------------------------------
-- 10. Recording consents, sessions and transcripts (covers every state)
-- ---------------------------------------------------------------------
-- Both parties consented on these past visits.
insert into public.recording_consents
  (appointment_id, party, patient_id, clinician_id, consent_given, consent_text_version, method, given_at, withdrawn_at, withdrawal_reason)
select a.id, 'patient'::public.consent_party, a.patient_id, null::uuid, true, 'v1', 'in_app'::public.consent_method,
       a.consult_started_at - interval '2 minutes',
       case when a.id = '60000000-0000-4000-8000-000000000006' then a.consult_started_at + interval '9 minutes' end,
       case when a.id = '60000000-0000-4000-8000-000000000006' then 'Did not want my rash discussion recorded' end
  from public.appointments a
 where a.id in ('60000000-0000-4000-8000-000000000002','60000000-0000-4000-8000-000000000006',
                '60000000-0000-4000-8000-000000000010','60000000-0000-4000-8000-000000000012',
                '60000000-0000-4000-8000-000000000013')
union all
select a.id, 'clinician', null, a.clinician_id, true, 'v1', 'in_app', a.consult_started_at - interval '1 minute', null, null
  from public.appointments a
 where a.id in ('60000000-0000-4000-8000-000000000002','60000000-0000-4000-8000-000000000006',
                '60000000-0000-4000-8000-000000000010','60000000-0000-4000-8000-000000000012',
                '60000000-0000-4000-8000-000000000013');

-- Patient consent given in advance for an upcoming visit.
insert into public.recording_consents (appointment_id, party, patient_id, consent_given, consent_text_version, method, given_at)
select a.id, 'patient', a.patient_id, true, 'v1', 'in_app', now() - interval '1 day'
  from public.appointments a
 where a.patient_id = '50000000-0000-4000-8000-000000000001'
   and a.scheduled_start > now()
   and a.status in ('booked', 'confirmed')
 order by a.scheduled_start
 limit 1;

-- Sessions. started_by holds the patient record id here because the sample
-- patients have no login yet; in the app it is the auth user id.
insert into public.recording_sessions
  (id, appointment_id, started_by, started_at, ended_at, duration_seconds, engine, engine_model, status, audio_discarded_at, error_message)
select v.id::uuid, a.id, a.patient_id,
       a.consult_started_at + interval '1 minute',
       case when v.status <> 'consent_withdrawn' then a.consult_ended_at end,
       v.secs, 'sample-stt', 'stt-medical-v2', v.status::public.recording_status,
       coalesce(a.consult_ended_at, a.consult_started_at) + interval '1 minute',
       v.err
  from (values
    ('70000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000002','approved',          780, null),
    ('70000000-0000-4000-8000-000000000002','60000000-0000-4000-8000-000000000010','rejected',          600, null),
    ('70000000-0000-4000-8000-000000000003','60000000-0000-4000-8000-000000000012','failed',            null,'Speech-to-text failed: 503 Service Unavailable'),
    ('70000000-0000-4000-8000-000000000004','60000000-0000-4000-8000-000000000012','awaiting_review',   960, null),
    ('70000000-0000-4000-8000-000000000005','60000000-0000-4000-8000-000000000013','expired',          1140, null),
    ('70000000-0000-4000-8000-000000000006','60000000-0000-4000-8000-000000000006','consent_withdrawn', null, null)
  ) as v(id, appointment_id, status, secs, err)
  join public.appointments a on a.id = v.appointment_id::uuid;

-- Approved transcript (kept permanently, visible to patient and clinician).
insert into public.consult_transcripts
  (id, recording_session_id, appointment_id, transcript_text, segments, summary_text, language, status, review_expires_at, approved_at, created_at)
select '71000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', a.id,
  'Dr Rao: Hi Olivia, I have your blood test results here. Most things look normal, but your iron levels are a bit low. '
  || 'Olivia: That would explain why I have been so tired lately. '
  || 'Dr Rao: It could. I would like you to start an iron supplement once a day, ideally with some vitamin C, and we will repeat the blood test in three months. '
  || 'Olivia: Are there any side effects? '
  || 'Dr Rao: Some people get an upset stomach or constipation. If that happens, take it with food and let me know.',
  '[{"speaker":"clinician","start_sec":0,"end_sec":11,"text":"Hi Olivia, I have your blood test results here. Most things look normal, but your iron levels are a bit low."},
    {"speaker":"patient","start_sec":11,"end_sec":15,"text":"That would explain why I have been so tired lately."},
    {"speaker":"clinician","start_sec":15,"end_sec":29,"text":"It could. I would like you to start an iron supplement once a day, ideally with some vitamin C, and we will repeat the blood test in three months."},
    {"speaker":"patient","start_sec":29,"end_sec":31,"text":"Are there any side effects?"},
    {"speaker":"clinician","start_sec":31,"end_sec":40,"text":"Some people get an upset stomach or constipation. If that happens, take it with food and let me know."}]'::jsonb,
  'Iron levels slightly low. Start daily iron supplement with vitamin C. Repeat blood test in 3 months. Report stomach upset or constipation.',
  'en-AU', 'approved', a.consult_ended_at + interval '7 days', a.consult_ended_at + interval '3 hours', a.consult_ended_at + interval '2 minutes'
from public.appointments a where a.id = '60000000-0000-4000-8000-000000000002';

-- Draft awaiting the patient's review (patient can see it; clinician cannot yet).
insert into public.consult_transcripts
  (id, recording_session_id, appointment_id, transcript_text, summary_text, language, status, review_expires_at, created_at)
select '71000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000004', a.id,
  'Dr Williams: So you rolled your ankle playing football on Saturday? '
  || 'Lukas: Yes, it swelled up straight away but I can walk on it. '
  || 'Dr Williams: Good sign. There is no tenderness over the bones, so I do not think you need an X-ray. Rest, ice, compression and elevation for the next few days, and come back if it is not improving within a week.',
  'Lateral ankle sprain, no X-ray needed. RICE for several days. Return if not improving in 1 week.',
  'en-AU', 'pending_patient_review', now() + interval '5 days', a.consult_ended_at + interval '2 minutes'
from public.appointments a where a.id = '60000000-0000-4000-8000-000000000012';

-- ---------------------------------------------------------------------
-- 11. Ratings with reasons (one hidden by staff moderation)
-- ---------------------------------------------------------------------
insert into public.clinician_ratings
  (appointment_id, patient_id, clinician_id, rating, rating_communication, rating_wait_time, would_recommend, comment, is_anonymous, moderation_status, created_at)
select a.id, a.patient_id, a.clinician_id, v.rating, v.comm, v.wait, v.rec, v.comment, v.anon, v.modr::public.moderation_status,
       a.consult_ended_at + make_interval(hours => v.hours_after)
  from (values
    ('60000000-0000-4000-8000-000000000002', 5, 5, 5, true,  'Dr Rao listened carefully and explained my blood test results in plain language.', false, 'visible', 5),
    ('60000000-0000-4000-8000-000000000003', 3, 4, 2, true,  'Good advice for my back, but I waited 35 minutes past my appointment time.',       false, 'visible', 20),
    ('60000000-0000-4000-8000-000000000006', 4, 4, 5, true,  'Thorough and friendly, though the consult felt a little rushed at the end.',         true,  'visible', 30),
    ('60000000-0000-4000-8000-000000000008', 1, 1, 3, false, 'Rude doctor, complete waste of money, avoid at all costs!!!',                         false, 'hidden',  2),
    ('60000000-0000-4000-8000-000000000011', 5, 5, 5, true,  'On time, very professional, and sorted my prescription in a few minutes.',           false, 'visible', 8),
    ('60000000-0000-4000-8000-000000000015', 4, 5, 4, true,  'Quick appointment and clear instructions on using my asthma inhaler properly.',      false, 'visible', 26)
  ) as v(appointment_id, rating, comm, wait, rec, comment, anon, modr, hours_after)
  join public.appointments a on a.id = v.appointment_id::uuid;

-- ---------------------------------------------------------------------
-- 12. Insurance claims (the policy is resolved automatically from the visit)
-- ---------------------------------------------------------------------
insert into public.insurance_claims
  (appointment_id, claim_number, amount_claimed, amount_approved, amount_paid, status, submitted_at, processed_at, rejection_reason)
select a.id, v.claim_number, v.claimed, v.approved, v.paid, v.status::public.claim_status,
       a.consult_ended_at + interval '1 hour',
       case when v.status in ('paid','rejected','approved') then a.consult_ended_at + interval '9 days' end,
       v.reason
  from (values
    -- Priya's GP visit while on a student visa: claimed on OSHC, paid
    ('60000000-0000-4000-8000-000000000005','CC-CLM-10021', 85.00, 85.00, 85.00, 'paid',      null),
    -- Priya's later GP visit on visitor cover: still being processed
    ('60000000-0000-4000-8000-000000000006','WVC-CLM-55813',85.00, null,  null,  'submitted', null),
    -- Wei's specialist skin check: rejected by visitor cover
    ('60000000-0000-4000-8000-000000000008','WVC-CLM-55790',250.00,0,     0,     'rejected',  'Pre-existing condition waiting period applies'),
    -- Lukas's ankle visit: claim drafted, not yet submitted
    ('60000000-0000-4000-8000-000000000012','WVC-CLM-56002',95.00, null,  null,  'draft',     null)
  ) as v(appointment_id, claim_number, claimed, approved, paid, status, reason)
  join public.appointments a on a.id = v.appointment_id::uuid;

update public.insurance_claims set submitted_at = null where status = 'draft';

commit;

-- ---------------------------------------------------------------------
-- Summary of what was created
-- ---------------------------------------------------------------------
select 'residency_statuses' as table_name, count(*) as rows from public.residency_statuses
union all select 'insurance_providers',        count(*) from public.insurance_providers
union all select 'insurance_plans',            count(*) from public.insurance_plans
union all select 'facilities',                 count(*) from public.facilities
union all select 'facility_billing_policies',  count(*) from public.facility_billing_policies
union all select 'clinicians',                 count(*) from public.clinicians
union all select 'clinician_qualifications',   count(*) from public.clinician_qualifications
union all select 'clinician_registrations',    count(*) from public.clinician_registrations
union all select 'clinician_affiliations',     count(*) from public.clinician_affiliations
union all select 'clinician_schedules',        count(*) from public.clinician_schedules
union all select 'schedule_exceptions',        count(*) from public.schedule_exceptions
union all select 'patients',                   count(*) from public.patients
union all select 'patient_addresses',          count(*) from public.patient_addresses
union all select 'patient_residency',          count(*) from public.patient_residency
union all select 'patient_insurance_policies', count(*) from public.patient_insurance_policies
union all select 'appointment_slots',          count(*) from public.appointment_slots
union all select 'appointments',               count(*) from public.appointments
union all select 'appointment_status_history', count(*) from public.appointment_status_history
union all select 'insurance_claims',           count(*) from public.insurance_claims
union all select 'recording_consents',         count(*) from public.recording_consents
union all select 'recording_sessions',         count(*) from public.recording_sessions
union all select 'consult_transcripts',        count(*) from public.consult_transcripts
union all select 'clinician_ratings',          count(*) from public.clinician_ratings;
