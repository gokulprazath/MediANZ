-- =====================================================================
-- Link test logins to the sample people.
--
-- 1. In Authentication -> Users -> Add user -> Create new user, create
--    any of these (tick "Auto Confirm User"):
--
--    Patients:
--      olivia.brown@example.com    (has history, upcoming visit, approved transcript)
--      jack.wilson@example.com     (has a no-show and a 3-star rating)
--      priya.sharma@example.com    (visa and insurance changed; claims)
--      lukas.becker@example.com    (has a transcript WAITING for review)
--    Clinicians:
--      asha.rao@example.com        (Southbank Family Medical)
--      sophie.williams@example.com (Paddington GP Clinic)
--    Staff:
--      reception.southbank@example.com
--
-- 2. Run this script. It can be re-run any time you add more users.
-- =====================================================================

-- Patients and clinicians are matched by email.
update public.patients p
   set auth_user_id = u.id
  from auth.users u
 where lower(u.email) = lower(p.email)
   and p.auth_user_id is distinct from u.id;

update public.clinicians c
   set auth_user_id = u.id
  from auth.users u
 where lower(u.email) = lower(c.email)
   and c.auth_user_id is distinct from u.id;

-- Staff: add more emails to this list as needed.
update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"staff"}'::jsonb
 where lower(email) in ('reception.southbank@example.com');

-- Show who is linked
select 'patient' as kind, p.first_name || ' ' || p.last_name as name, p.email, p.auth_user_id is not null as linked
  from public.patients p
union all
select 'clinician', c.first_name || ' ' || c.last_name, c.email, c.auth_user_id is not null
  from public.clinicians c
union all
select 'staff', u.email, u.email, true
  from auth.users u
 where u.raw_app_meta_data ->> 'role' in ('staff', 'admin')
order by 1, 2;
