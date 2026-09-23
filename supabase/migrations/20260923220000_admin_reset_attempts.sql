-- =========================================================
-- Reinicio de intentos por parte de un administrador
--
-- Los intentos no se borran: se anulan (voided_at / voided_by) para
-- conservar el historial. Los intentos anulados no cuentan para el
-- máximo de 3, no se muestran en la aplicación y no afectan qué
-- respuestas se revelan. Los certificados ya emitidos se conservan.
-- =========================================================

alter table public.attempts
  add column voided_at timestamptz,
  add column voided_by uuid references public.profiles (id) on delete set null;

-- La numeración 1..3 y el "un intento en curso" aplican solo a intentos vigentes
alter table public.attempts drop constraint attempts_user_id_exam_id_number_key;
create unique index attempts_active_number
  on public.attempts (user_id, exam_id, number) where voided_at is null;

drop index public.attempts_one_in_progress;
create unique index attempts_one_in_progress
  on public.attempts (user_id, exam_id) where status = 'in_progress' and voided_at is null;

create index attempts_voided_by_idx on public.attempts (voided_by);

/* ---------- Funciones existentes: ignoran intentos anulados ---------- */
create or replace function private.reveal_mode(a public.attempts, adm boolean) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when adm then 'full'
    when a.status = 'in_progress' then 'hidden'
    when exists (select 1 from public.certificates c where c.user_id = a.user_id and c.exam_id = a.exam_id)
      or (select count(*) from public.attempts x
          where x.user_id = a.user_id and x.exam_id = a.exam_id and x.voided_at is null) >= 3
      then 'full'
    else 'graded'
  end;
$$;

create or replace function public.get_state() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_me  jsonb;
  v_adm boolean;
begin
  if v_uid is null then return null; end if;
  select private.profile_json(p) into v_me from public.profiles p where p.id = v_uid;
  if v_me is null then return null; end if;
  v_adm := (v_me ->> 'role') = 'admin';

  return jsonb_build_object(
    'me', v_me,
    'users', case when v_adm
      then (select coalesce(jsonb_agg(private.profile_json(p) order by p.created_at), '[]') from public.profiles p)
      else jsonb_build_array(v_me) end,
    'exams', (select coalesce(jsonb_agg(private.exam_json(e, v_adm) order by e.created_at), '[]')
              from public.exams e where v_adm or e.published),
    'attempts', (select coalesce(jsonb_agg(private.attempt_json(a, private.reveal_mode(a, v_adm)) order by a.started_at), '[]')
                 from public.attempts a where a.voided_at is null and (v_adm or a.user_id = v_uid)),
    'certificates', (select coalesce(jsonb_agg(private.cert_json(c) order by c.issued_at), '[]')
                     from public.certificates c where v_adm or c.user_id = v_uid)
  );
end $$;

create or replace function public.start_attempt(p_exam_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := private.require_user();
  v_exam public.exams;
  v_att  public.attempts;
  v_used int;
begin
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_exam_id, 0));

  select * into v_exam from public.exams where id = p_exam_id;
  if not found or not v_exam.published then
    raise exception 'El examen no está disponible.';
  end if;
  if jsonb_array_length(v_exam.questions) = 0 then
    raise exception 'El examen no tiene preguntas.';
  end if;

  select * into v_att from public.attempts
  where user_id = v_uid and exam_id = p_exam_id and status = 'in_progress' and voided_at is null;
  if found then return private.attempt_json(v_att, 'hidden'); end if;

  select count(*) into v_used from public.attempts
  where user_id = v_uid and exam_id = p_exam_id and voided_at is null;
  if v_used >= 3 then
    raise exception 'Has alcanzado el máximo de 3 intentos.';
  end if;

  insert into public.attempts (user_id, exam_id, exam_title, number, questions_snapshot, total)
  values (v_uid, v_exam.id, v_exam.title, v_used + 1, v_exam.questions, jsonb_array_length(v_exam.questions))
  returning * into v_att;

  return private.attempt_json(v_att, 'hidden');
end $$;

create or replace function public.save_answer(p_attempt_id uuid, p_question_id text, p_option_ids text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_att public.attempts;
  v_q   jsonb;
begin
  select * into v_att from public.attempts
  where id = p_attempt_id and user_id = v_uid and voided_at is null for update;
  if not found then raise exception 'Intento no encontrado.'; end if;
  if v_att.status <> 'in_progress' then raise exception 'El intento ya fue finalizado.'; end if;

  select q into v_q from jsonb_array_elements(v_att.questions_snapshot) t(q) where q ->> 'id' = p_question_id;
  if v_q is null then raise exception 'La pregunta no pertenece a este intento.'; end if;
  if v_att.answers ? p_question_id then
    raise exception 'Esta respuesta ya fue confirmada y no puede modificarse.';
  end if;

  p_option_ids := array(select distinct o from unnest(p_option_ids) o where o is not null);
  if cardinality(p_option_ids) = 0 then raise exception 'Selecciona al menos una opción.'; end if;
  if v_q ->> 'type' = 'single' and cardinality(p_option_ids) <> 1 then
    raise exception 'Selecciona una única opción.';
  end if;
  if exists (
    select 1 from unnest(p_option_ids) o
    where not exists (select 1 from jsonb_array_elements(v_q -> 'options') t(x) where x ->> 'id' = o)
  ) then
    raise exception 'Opción no válida.';
  end if;

  update public.attempts
  set answers = answers || jsonb_build_object(p_question_id, to_jsonb(p_option_ids))
  where id = v_att.id
  returning * into v_att;

  return private.attempt_json(v_att, 'hidden');
end $$;

create or replace function public.set_attempt_index(p_attempt_id uuid, p_index int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_att public.attempts;
begin
  update public.attempts
  set current_index = greatest(0, least(p_index, total - 1))
  where id = p_attempt_id and user_id = v_uid and status = 'in_progress' and voided_at is null
  returning * into v_att;
  if not found then raise exception 'Intento no encontrado o ya finalizado.'; end if;
  return private.attempt_json(v_att, 'hidden');
end $$;

create or replace function public.finish_attempt(p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := private.require_user();
  v_att     public.attempts;
  v_cert    public.certificates;
  v_correct int;
begin
  select * into v_att from public.attempts
  where id = p_attempt_id and user_id = v_uid and voided_at is null for update;
  if not found then raise exception 'Intento no encontrado.'; end if;

  if v_att.status = 'in_progress' then
    v_correct := private.grade(v_att.questions_snapshot, v_att.answers);
    update public.attempts set
      correct_count = v_correct,
      total         = jsonb_array_length(questions_snapshot),
      percentage    = case when jsonb_array_length(questions_snapshot) > 0
                        then round(v_correct * 100.0 / jsonb_array_length(questions_snapshot)) else 0 end,
      finished_at   = now(),
      status        = 'finished'
    where id = v_att.id
    returning * into v_att;

    if v_att.percentage >= 90 then
      insert into public.certificates (code, user_id, user_name, exam_id, exam_title, attempt_id, percentage, issued_at)
      select private.new_cert_code(), v_att.user_id, p.name, v_att.exam_id, v_att.exam_title,
             v_att.id, v_att.percentage, v_att.finished_at
      from public.profiles p where p.id = v_att.user_id
      on conflict (user_id, exam_id) do nothing;
    end if;
  end if;

  select * into v_cert from public.certificates where user_id = v_att.user_id and exam_id = v_att.exam_id;

  return jsonb_build_object(
    'attempt', private.attempt_json(v_att, private.reveal_mode(v_att, false)),
    'certificate', case when v_cert.id is null then null else private.cert_json(v_cert) end
  );
end $$;

/* ---------- Nueva RPC ---------- */
-- Anula los intentos vigentes de un estudiante en un examen.
-- Devuelve cuántos intentos se anularon.
create function public.admin_reset_attempts(p_user_id uuid, p_exam_id text) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  perform private.require_admin();
  -- misma llave que start_attempt: evita cruzarse con un intento que se está creando
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_exam_id, 0));

  update public.attempts
  set voided_at = now(), voided_by = auth.uid()
  where user_id = p_user_id and exam_id = p_exam_id and voided_at is null;
  get diagnostics v_count = row_count;

  if v_count = 0 then
    raise exception 'El estudiante no tiene intentos en este examen.';
  end if;
  return v_count;
end $$;

revoke execute on function public.admin_reset_attempts(uuid, text) from public, anon;
grant execute on function public.admin_reset_attempts(uuid, text) to authenticated;
