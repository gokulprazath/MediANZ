-- =====================================================================
-- SAMPLE DATA for service discovery, insurance evidence and research.
-- Run after 20261027020000_service_discovery.sql and 01_sample_data.sql.
--
-- Fictional data only. Root-canal clinics are added so the dental journey
-- can be demonstrated end to end.
-- =====================================================================
begin;

select set_config('request.jwt.claims', '{"app_metadata":{"role":"admin"}}', true);

-- ---------------------------------------------------------------------
-- 1. Services and problem-text aliases
-- ---------------------------------------------------------------------
insert into public.service_catalog
  (id, code, name, category, insurance_category, required_specialty, default_duration_minutes) values
 ('70000000-0000-4000-8000-000000000001','gp_standard','Standard GP consultation','gp','gp','General Practice',15),
 ('70000000-0000-4000-8000-000000000002','gp_long','Long GP consultation','gp','gp','General Practice',30),
 ('70000000-0000-4000-8000-000000000003','dental_check','Dental check-up and clean','dental','general_dental','Dentistry',30),
 ('70000000-0000-4000-8000-000000000004','root_canal','Root canal treatment','dental','major_dental','Dentistry',60),
 ('70000000-0000-4000-8000-000000000005','emergency_dental','Emergency dental visit','dental','general_dental','Dentistry',30),
 ('70000000-0000-4000-8000-000000000006','vaccination','Vaccination','preventive','gp',null,15),
 ('70000000-0000-4000-8000-000000000007','skin_check','Skin check','specialist','specialist','Dermatology',30);

insert into public.service_aliases (alias, service_id) values
 ('root canal',       '70000000-0000-4000-8000-000000000004'),
 ('root canal treatment','70000000-0000-4000-8000-000000000004'),
 ('endodontic',       '70000000-0000-4000-8000-000000000004'),
 ('tooth ache',       '70000000-0000-4000-8000-000000000005'),
 ('toothache',        '70000000-0000-4000-8000-000000000005'),
 ('tooth pain',       '70000000-0000-4000-8000-000000000005'),
 ('broken tooth',     '70000000-0000-4000-8000-000000000005'),
 ('dental emergency', '70000000-0000-4000-8000-000000000005'),
 ('dental check',     '70000000-0000-4000-8000-000000000003'),
 ('check up and clean','70000000-0000-4000-8000-000000000003'),
 ('dentist',          '70000000-0000-4000-8000-000000000003'),
 ('gp',               '70000000-0000-4000-8000-000000000001'),
 ('doctor',           '70000000-0000-4000-8000-000000000001'),
 ('general practitioner','70000000-0000-4000-8000-000000000001'),
 ('flu shot',         '70000000-0000-4000-8000-000000000006'),
 ('vaccination',      '70000000-0000-4000-8000-000000000006'),
 ('skin check',       '70000000-0000-4000-8000-000000000007'),
 ('mole check',       '70000000-0000-4000-8000-000000000007');

-- ---------------------------------------------------------------------
-- 2. Clinic descriptions and dental clinics
-- ---------------------------------------------------------------------
update public.facilities set
  description = 'A family general practice in South Brisbane with same-week appointments and mixed billing.',
  website = 'https://southbank-fm.example.com'
 where id = '30000000-0000-4000-8000-000000000001';
update public.facilities set
  description = 'A community GP clinic in Paddington offering preventive care and chronic disease management.',
  website = 'https://paddington-gp.example.com'
 where id = '30000000-0000-4000-8000-000000000002';
update public.facilities set
  description = 'A private hospital campus in Chermside with specialist consulting rooms.',
  website = 'https://kvph.example.com'
 where id = '30000000-0000-4000-8000-000000000003';
update public.facilities set
  description = 'A GP clinic in Parramatta serving Western Sydney families.',
  website = 'https://riverside-med.example.com'
 where id = '30000000-0000-4000-8000-000000000004';

insert into public.facilities
  (id, name, facility_type, abn, phone, email, description, website,
   address_line1, suburb, state, postcode, timezone, latitude, longitude) values
 ('30000000-0000-4000-8000-000000000005','West End Dental Studio','specialist_clinic','11111111111','07 5550 0501','hello@westend-dental.example.com','A modern dental practice near the West End river precinct, with emergency and endodontic care.','https://westend-dental.example.com','88 Boundary Street','West End','QLD','4101','Australia/Brisbane',-27.482700,153.010900),
 ('30000000-0000-4000-8000-000000000006','Paddington Dental Care','specialist_clinic','11111111112','07 5550 0502','care@paddington-dental.example.com','A quiet suburban dental clinic focused on family and restorative dentistry.','https://paddington-dental.example.com','120 Latrobe Terrace','Paddington','QLD','4064','Australia/Brisbane',-27.459700,153.000800),
 ('30000000-0000-4000-8000-000000000007','Southbank Endodontics','specialist_clinic','11111111113','07 5550 0503','reception@southbank-endo.example.com','Specialist endodontic practice for root canal treatment and complex dental pain.','https://southbank-endo.example.com','15 Cordelia Street','South Brisbane','QLD','4101','Australia/Brisbane',-27.480400,153.016600),
 ('30000000-0000-4000-8000-000000000008','Kedron Dental Group','specialist_clinic','11111111114','07 5550 0504','hello@kedron-dental.example.com','A larger dental group with extended weekday hours and direct billing for selected funds.','https://kedron-dental.example.com','345 Gympie Road','Kedron','QLD','4031','Australia/Brisbane',-27.407100,153.029700),
 ('30000000-0000-4000-8000-000000000009','Toowong Dental Lounge','specialist_clinic','11111111115','07 5550 0505','smile@toowong-dental.example.com','A boutique dental practice near Toowong Village offering gentle restorative care.','https://toowong-dental.example.com','7 Sherwood Road','Toowong','QLD','4066','Australia/Brisbane',-27.485800,152.989400),
 ('30000000-0000-4000-8000-000000000010','Carindale Dental Centre','specialist_clinic','11111111116','07 5550 0506','hello@carindale-dental.example.com','A family dental centre with accessible parking and Saturday appointments.','https://carindale-dental.example.com','1151 Creek Road','Carindale','QLD','4152','Australia/Brisbane',-27.505300,153.101500);

insert into public.clinicians
  (id, first_name, last_name, sex, email, phone, clinician_type, specialty,
   ahpra_registration_number, languages, offers_telehealth) values
 ('40000000-0000-4000-8000-000000000007','Nadia','Haddad','female','nadia.haddad@example.com','0491 570 107','specialist','Dentistry','DEN0001100007','{en,ar}',true),
 ('40000000-0000-4000-8000-000000000008','Owen','Patel','male','owen.patel@example.com','0491 570 108','specialist','Dentistry','DEN0001100008','{en,hi}',false),
 ('40000000-0000-4000-8000-000000000009','Mei','Tan','female','mei.tan@example.com','0491 570 109','specialist','Dentistry','DEN0001100009','{en,zh}',true),
 ('40000000-0000-4000-8000-000000000010','Daniel','Okafor','male','daniel.okafor@example.com','0491 570 110','specialist','Dentistry','DEN0001100010','{en}',false),
 ('40000000-0000-4000-8000-000000000011','Priya','Menon','female','priya.menon@example.com','0491 570 111','specialist','Dentistry','DEN0001100011','{en,ml}',true),
 ('40000000-0000-4000-8000-000000000012','Ethan','Brooks','male','ethan.brooks@example.com','0491 570 112','specialist','Dentistry','DEN0001100012','{en}',false);

insert into public.clinician_affiliations
  (clinician_id, facility_id, role, valid_from) values
 ('40000000-0000-4000-8000-000000000007','30000000-0000-4000-8000-000000000005','Dentist','2024-01-01'),
 ('40000000-0000-4000-8000-000000000008','30000000-0000-4000-8000-000000000006','Dentist','2024-01-01'),
 ('40000000-0000-4000-8000-000000000009','30000000-0000-4000-8000-000000000007','Endodontist','2024-01-01'),
 ('40000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000008','Dentist','2024-01-01'),
 ('40000000-0000-4000-8000-000000000011','30000000-0000-4000-8000-000000000009','Dentist','2024-01-01'),
 ('40000000-0000-4000-8000-000000000012','30000000-0000-4000-8000-000000000010','Dentist','2024-01-01');

insert into public.clinician_schedules
  (clinician_id, facility_id, weekday, start_time, end_time, slot_minutes, valid_from)
select c.id, a.facility_id, d, '08:30'::time, '17:00'::time, 60, '2024-01-01'
  from public.clinicians c
  join public.clinician_affiliations a on a.clinician_id = c.id
  join public.facilities f on f.id = a.facility_id
  cross join generate_series(1, 5) d
 where f.id between '30000000-0000-4000-8000-000000000005'
               and '30000000-0000-4000-8000-000000000010';

-- ---------------------------------------------------------------------
-- 3. Who offers what
-- ---------------------------------------------------------------------
insert into public.clinician_services (clinician_id, service_id)
select c.id, s.id
  from public.clinicians c
  cross join public.service_catalog s
 where (c.clinician_type = 'gp'
        and s.code in ('gp_standard','gp_long'))
    or (c.clinician_type = 'nurse' and s.code = 'vaccination')
    or (c.specialty = 'Dermatology' and s.code = 'skin_check')
    or (c.specialty = 'Dentistry'
        and s.code in ('dental_check','root_canal','emergency_dental'));

-- ---------------------------------------------------------------------
-- 4. Effective-dated prices
-- ---------------------------------------------------------------------
insert into public.service_prices
  (facility_id, clinician_id, service_id, mbs_item, fee, medicare_rebate, valid_from) values
 ('30000000-0000-4000-8000-000000000001',null,'70000000-0000-4000-8000-000000000001','23',85.00,43.90,current_date - 365),
 ('30000000-0000-4000-8000-000000000002',null,'70000000-0000-4000-8000-000000000001','23',85.00,43.90,current_date - 365),
 ('30000000-0000-4000-8000-000000000004',null,'70000000-0000-4000-8000-000000000001','23',75.00,43.90,current_date - 365),
 ('30000000-0000-4000-8000-000000000001',null,'70000000-0000-4000-8000-000000000002','36',140.00,76.50,current_date - 365),
 ('30000000-0000-4000-8000-000000000001',null,'70000000-0000-4000-8000-000000000006',null,0.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000003',null,'70000000-0000-4000-8000-000000000007',null,250.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000005',null,'70000000-0000-4000-8000-000000000003',null,180.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000005',null,'70000000-0000-4000-8000-000000000004',null,1200.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000005',null,'70000000-0000-4000-8000-000000000005',null,220.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000006',null,'70000000-0000-4000-8000-000000000003',null,165.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000006',null,'70000000-0000-4000-8000-000000000004',null,1100.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000006',null,'70000000-0000-4000-8000-000000000005',null,200.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000007',null,'70000000-0000-4000-8000-000000000004',null,1450.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000007',null,'70000000-0000-4000-8000-000000000005',null,250.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000008',null,'70000000-0000-4000-8000-000000000003',null,150.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000008',null,'70000000-0000-4000-8000-000000000004',null,980.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000008',null,'70000000-0000-4000-8000-000000000005',null,190.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000009',null,'70000000-0000-4000-8000-000000000003',null,175.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000009',null,'70000000-0000-4000-8000-000000000004',null,1250.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000009',null,'70000000-0000-4000-8000-000000000005',null,210.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000010',null,'70000000-0000-4000-8000-000000000003',null,160.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000010',null,'70000000-0000-4000-8000-000000000004',null,1050.00,0.00,current_date - 365),
 ('30000000-0000-4000-8000-000000000010',null,'70000000-0000-4000-8000-000000000005',null,205.00,0.00,current_date - 365);

-- ---------------------------------------------------------------------
-- 5. Insurance coverage evidence (seed is staff-entered and verified)
-- ---------------------------------------------------------------------
insert into public.insurance_service_rules
  (plan_id, service_id, insurance_category, coverage_status, benefit_type, benefit_value,
   annual_limit, waiting_period_days, requires_preauth, verification_level, source_type,
   source_url, source_quote, retrieved_at, valid_from, verified_at) values
 ('21000000-0000-4000-8000-000000000001',null,'major_dental','not_covered','none',null,null,0,false,'verified','staff','https://sunstate.example.com/gold-hospital','Hospital cover does not include general or major dental.',now(),current_date - 30,now()),
 ('21000000-0000-4000-8000-000000000002',null,'major_dental','partially_covered','percent',60,null,365,true,'verified','staff','https://sunstate.example.com/silver-plus','Major dental is covered at 60% after a 12-month wait, subject to annual limits.',now(),current_date - 30,now()),
 ('21000000-0000-4000-8000-000000000003',null,'major_dental','not_covered','none',null,null,0,false,'verified','staff','https://harbourside.example.com/bronze-hospital','Bronze hospital cover excludes major dental.',now(),current_date - 30,now()),
 ('21000000-0000-4000-8000-000000000004',null,'major_dental','partially_covered','percent',50,800,365,false,'verified','staff','https://harbourside.example.com/basic-extras','Major dental has a 12-month waiting period and a $800 annual limit.',now(),current_date - 30,now()),
 ('21000000-0000-4000-8000-000000000005',null,'major_dental','partially_covered','percent',60,1200,0,true,'verified','staff','https://campuscover.example.com/oshc-essentials','OSHC extras provide 60% for major dental after pre-authorisation.',now(),current_date - 30,now()),
 ('21000000-0000-4000-8000-000000000006',null,'major_dental','partially_covered','percent',50,600,365,false,'verified','staff','https://wanderer.example.com/visitor-standard','Visitor cover has a 12-month waiting period for major dental.',now(),current_date - 30,now()),
 ('21000000-0000-4000-8000-000000000005',null,'gp','covered','mbs_percent',100,null,0,false,'verified','staff','https://campuscover.example.com/oshc-essentials','GP consultations are covered at the MBS schedule fee.',now(),current_date - 30,now()),
 ('21000000-0000-4000-8000-000000000006',null,'gp','covered','mbs_percent',100,null,0,false,'verified','staff','https://wanderer.example.com/visitor-standard','GP consultations are covered at the MBS schedule fee.',now(),current_date - 30,now()),
 ('21000000-0000-4000-8000-000000000002',null,'general_dental','covered','percent',100,500,0,false,'verified','staff','https://sunstate.example.com/silver-plus','General dental is covered at 100% up to the annual limit.',now(),current_date - 30,now()),
 ('21000000-0000-4000-8000-000000000004',null,'general_dental','covered','percent',80,400,180,false,'verified','staff','https://harbourside.example.com/basic-extras','General dental is covered at 80% after a 6-month wait.',now(),current_date - 30,now());

insert into public.facility_insurance_acceptances
  (facility_id, insurer_provider_id, service_id, insurance_category, accepted, claim_mode,
   verification_level, source_type, source_url, source_quote, retrieved_at, valid_from,
   verified_at) values
 ('30000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000001',null,'major_dental',true,'direct','verified','staff','https://westend-dental.example.com/insurance','We offer HICAPS direct claiming for major dental.',now(),current_date - 30,now()),
 ('30000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000002',null,'major_dental',true,'manual','verified','staff','https://westend-dental.example.com/insurance','Harbourside patients pay upfront and claim with their fund.',now(),current_date - 30,now()),
 ('30000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000001',null,'major_dental',true,'direct','verified','staff','https://paddington-dental.example.com/insurance','Direct claiming is available for Sunstate Health Fund.',now(),current_date - 30,now()),
 ('30000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000002',null,'major_dental',true,'manual','verified','staff','https://paddington-dental.example.com/insurance','Harbourside claims are submitted by the patient.',now(),current_date - 30,now()),
 ('30000000-0000-4000-8000-000000000007','20000000-0000-4000-8000-000000000001',null,'major_dental',true,'manual','verified','staff','https://southbank-endo.example.com/fees','Payment is required on the day; we provide itemised receipts for claims.',now(),current_date - 30,now()),
 ('30000000-0000-4000-8000-000000000007','20000000-0000-4000-8000-000000000005',null,'major_dental',true,'manual','verified','staff','https://southbank-endo.example.com/fees','OSHC patients pay on the day and claim from their fund.',now(),current_date - 30,now()),
 ('30000000-0000-4000-8000-000000000008','20000000-0000-4000-8000-000000000001',null,'major_dental',true,'direct','verified','staff','https://kedron-dental.example.com/insurance','We direct bill Sunstate Health Fund for major dental.',now(),current_date - 30,now()),
 ('30000000-0000-4000-8000-000000000008','20000000-0000-4000-8000-000000000004',null,'major_dental',false,'not_supported','verified','staff','https://kedron-dental.example.com/insurance','Wanderer Visitor Cover is not accepted at this clinic.',now(),current_date - 30,now()),
 ('30000000-0000-4000-8000-000000000009','20000000-0000-4000-8000-000000000002',null,'major_dental',true,'direct','verified','staff','https://toowong-dental.example.com/insurance','HICAPS direct claiming is available.',now(),current_date - 30,now()),
 ('30000000-0000-4000-8000-000000000009','20000000-0000-4000-8000-000000000005',null,'major_dental',true,'manual','verified','staff','https://toowong-dental.example.com/insurance','OSHC claims are paid upfront and claimed by the patient.',now(),current_date - 30,now()),
 ('30000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000001',null,'major_dental',true,'direct','verified','staff','https://carindale-dental.example.com/insurance','Direct billing is available for selected Sunstate extras.',now(),current_date - 30,now()),
 ('30000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000002',null,'major_dental',true,'manual','verified','staff','https://carindale-dental.example.com/insurance','Harbourside patients pay and claim.',now(),current_date - 30,now());

-- General dental (check-ups and emergency visits) follows the same clinic
-- acceptance and claim-mode as major dental at these practices.
insert into public.facility_insurance_acceptances
  (facility_id, insurer_provider_id, service_id, insurance_category, accepted, claim_mode,
   verification_level, source_type, source_url, source_quote, retrieved_at, valid_from,
   verified_at)
select facility_id, insurer_provider_id, null, 'general_dental', accepted, claim_mode,
       verification_level, source_type, source_url, source_quote, retrieved_at, valid_from,
       verified_at
  from public.facility_insurance_acceptances
 where insurance_category = 'major_dental'
   and facility_id between '30000000-0000-4000-8000-000000000005'
                       and '30000000-0000-4000-8000-000000000010';

insert into public.facility_insurance_acceptances
  (facility_id, insurer_provider_id, service_id, insurance_category, accepted, claim_mode,
   verification_level, source_type, source_url, source_quote, retrieved_at, valid_from,
   verified_at)
select f.id, p.id, null, 'gp', true, 'direct', 'verified', 'staff',
       'https://clinic.example.com/insurance', 'The clinic accepts this fund for GP visits.',
       now(), current_date - 30, now()
  from public.facilities f
  cross join public.insurance_providers p
 where f.id in ('30000000-0000-4000-8000-000000000001',
                '30000000-0000-4000-8000-000000000002',
                '30000000-0000-4000-8000-000000000004')
   and p.id <> '20000000-0000-4000-8000-000000000004';

insert into public.patient_gp_preferences
  (patient_id, preferred_languages, preferred_clinician_sex, telehealth_ok) values
 ('50000000-0000-4000-8000-000000000001','{en}',null,true),
 ('50000000-0000-4000-8000-000000000003','{en}',null,true)
on conflict (patient_id) do nothing;

-- ---------------------------------------------------------------------
-- 6. Scheduled research targets (not run on the patient request path)
-- ---------------------------------------------------------------------
insert into public.research_targets
  (target_type, plan_id, service_id, insurance_category, source_type, url, priority, next_run_at)
select 'plan_coverage', p.id, null, c.category, 'privatehealth',
       'https://www.privatehealth.gov.au/', 100, now() + interval '1 day'
  from public.insurance_plans p
  cross join (values ('major_dental'), ('general_dental'), ('gp')) as c(category)
 where p.cover_type in ('combined','extras');

insert into public.research_targets
  (target_type, facility_id, insurer_provider_id, service_id, insurance_category,
   source_type, url, priority, next_run_at)
select 'facility_acceptance', f.id, p.id, null, 'major_dental', 'provider_directory',
       'https://www.privatehealth.gov.au/', 80, now() + interval '1 day'
  from public.facilities f
  cross join public.insurance_providers p
 where f.id between '30000000-0000-4000-8000-000000000005'
               and '30000000-0000-4000-8000-000000000010';

select public.generate_slots(current_date, current_date + 56);

commit;
