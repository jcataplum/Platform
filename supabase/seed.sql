-- =========================================================
-- Campus HDI — cuentas y datos de demostración
-- Ejecutar después de la migración. Es idempotente para las cuentas;
-- los exámenes/intentos/certificados se reemplazan por los de demo.
--
--   admin@hdi.com       / admin123       (Administrador HDI)
--   estudiante@hdi.com  / estudiante123  (Laura Gómez)
--
-- Contraseñas débiles solo para demostración: cámbialas en producción.
-- =========================================================

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'admin@hdi.com',
   extensions.crypt('admin123', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Administrador HDI"}',
   now() - interval '30 days', now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'estudiante@hdi.com',
   extensions.crypt('estudiante123', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Laura Gómez"}',
   now() - interval '10 days', now(), '', '', '', '')
on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       'email', now(), u.created_at, now()
from auth.users u
where u.id in ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')
on conflict (provider_id, provider) do nothing;

-- El trigger crea ambos perfiles como 'student'; se promueve al admin aquí.
update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-000000000001';

select private.seed_demo();
