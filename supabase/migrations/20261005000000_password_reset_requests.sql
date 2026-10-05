-- =========================================================
-- Recuperación de contraseña sin correo
--
-- Quien olvidó su contraseña la solicita en la pantalla de la plataforma;
-- el administrador ve la solicitud en Usuarios y asigna una contraseña
-- temporal (Edge Function `admin-users`), que marca la cuenta para que la
-- persona cree una nueva al entrar.
-- =========================================================

alter table public.profiles
  add column reset_requested_at   timestamptz,
  add column must_change_password boolean not null default false;

create or replace function private.profile_json(p public.profiles) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'name', p.name, 'email', p.email, 'role', p.role, 'createdAt', p.created_at,
    'resetRequestedAt', p.reset_requested_at, 'mustChangePassword', p.must_change_password);
$$;

-- Pública (sin sesión). No revela si el correo existe: siempre termina sin error.
-- Conserva la fecha de la primera solicitud pendiente.
create function public.request_password_reset(p_email text) returns void
language sql security definer set search_path = '' as $$
  update public.profiles set reset_requested_at = now()
  where email = lower(btrim(p_email)) and reset_requested_at is null;
$$;

-- La persona ya fijó su nueva contraseña (con supabase.auth.updateUser).
create function public.complete_password_change() returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_user();
begin
  update public.profiles set must_change_password = false, reset_requested_at = null where id = v_uid;
end $$;

create function public.admin_dismiss_reset_request(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden hacer esto.' using errcode = '42501';
  end if;
  update public.profiles set reset_requested_at = null where id = p_user_id;
end $$;

revoke execute on function public.request_password_reset(text) from public;
grant execute on function public.request_password_reset(text) to anon, authenticated;
revoke execute on function public.complete_password_change() from public, anon;
grant execute on function public.complete_password_change() to authenticated;
revoke execute on function public.admin_dismiss_reset_request(uuid) from public, anon;
grant execute on function public.admin_dismiss_reset_request(uuid) to authenticated;
