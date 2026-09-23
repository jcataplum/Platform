-- =========================================================
-- Campus HDI — esquema inicial en Supabase
--
-- Modelo de acceso: las tablas NO se exponen al cliente (sin GRANT a
-- anon/authenticated y RLS activo sin políticas). Todo pasa por funciones
-- RPC `security definer` que aplican las reglas de negocio en el servidor:
--   · máximo 3 intentos por examen (MAX_ATTEMPTS)
--   · aprobación con 90 % o más (PASS_PERCENT) y certificado automático
--   · respuestas confirmadas que no pueden modificarse
--   · las respuestas correctas solo se revelan al estudiante cuando
--     obtiene su certificado o agota sus intentos
-- La gestión de cuentas (crear/editar/eliminar usuarios) vive en la
-- Edge Function `admin-users`, porque requiere la API admin de Auth.
-- =========================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

/* ---------------------------------------------------------
   Tablas
   --------------------------------------------------------- */
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 120),
  email      text not null,
  role       text not null default 'student' check (role in ('admin', 'student')),
  created_at timestamptz not null default now()
);

create table public.exams (
  id          text primary key default 'exam_' || replace(gen_random_uuid()::text, '-', ''),
  title       text not null check (char_length(title) between 1 and 200),
  description text not null default '',
  published   boolean not null default false,
  -- [{ id, text, type: 'single'|'multiple', options: [{id, text}], correct: [optionId] }]
  questions   jsonb not null default '[]' check (jsonb_typeof(questions) = 'array'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- exam_id no tiene FK a propósito: al eliminar un examen se conservan
-- los intentos y certificados históricos (igual que la versión local).
create table public.attempts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  exam_id            text not null,
  exam_title         text not null,
  number             smallint not null check (number between 1 and 3),
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  questions_snapshot jsonb not null,
  answers            jsonb not null default '{}',
  current_index      int not null default 0,
  correct_count      int not null default 0,
  total              int not null,
  percentage         int not null default 0,
  status             text not null default 'in_progress' check (status in ('in_progress', 'finished')),
  unique (user_id, exam_id, number)
);
create unique index attempts_one_in_progress
  on public.attempts (user_id, exam_id) where status = 'in_progress';
create index attempts_exam_idx on public.attempts (exam_id);

create table public.certificates (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  user_name  text not null,
  exam_id    text not null,
  exam_title text not null,
  attempt_id uuid not null references public.attempts (id) on delete cascade,
  percentage int not null,
  issued_at  timestamptz not null default now(),
  unique (user_id, exam_id)
);
create index certificates_attempt_idx on public.certificates (attempt_id);

alter table public.profiles     enable row level security;
alter table public.exams        enable row level security;
alter table public.attempts     enable row level security;
alter table public.certificates enable row level security;

revoke all on public.profiles, public.exams, public.attempts, public.certificates from anon, authenticated;

/* ---------------------------------------------------------
   Sincronización con auth.users
   --------------------------------------------------------- */
-- El rol SIEMPRE nace como 'student': user_metadata lo controla el usuario
-- al registrarse, así que nunca se usa para decidir privilegios.
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name, email, role, created_at)
  values (
    new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1)), 120),
    lower(new.email),
    'student',
    new.created_at
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create function private.handle_user_email_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set email = lower(new.email) where id = new.id;
  return new;
end $$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function private.handle_user_email_change();

-- Mantiene el nombre de los certificados sincronizado con el perfil
create function private.handle_profile_rename() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.certificates set user_name = new.name where user_id = new.id;
  return new;
end $$;

create trigger on_profile_renamed
  after update of name on public.profiles
  for each row when (old.name is distinct from new.name)
  execute function private.handle_profile_rename();

/* ---------------------------------------------------------
   Utilidades privadas
   --------------------------------------------------------- */
create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create function private.require_user() returns uuid
language plpgsql stable set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión.' using errcode = '28000';
  end if;
  return auth.uid();
end $$;

create function private.require_admin() returns void
language plpgsql stable set search_path = '' as $$
begin
  perform private.require_user();
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden realizar esta acción.' using errcode = '42501';
  end if;
end $$;

-- ¿Contienen a y b (arreglos JSON de ids) los mismos elementos?
create function private.same_set(a jsonb, b jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce((select array_agg(x order by x) from jsonb_array_elements_text(coalesce(a, '[]')) t(x)), '{}'::text[])
       = coalesce((select array_agg(x order by x) from jsonb_array_elements_text(coalesce(b, '[]')) t(x)), '{}'::text[]);
$$;

create function private.grade(questions jsonb, answers jsonb) returns int
language sql immutable set search_path = '' as $$
  select count(*)::int
  from jsonb_array_elements(questions) t(q)
  where private.same_set(answers -> (q ->> 'id'), q -> 'correct');
$$;

-- mode: 'full' (con respuestas correctas), 'hidden' (sin ellas) o
-- 'graded' (sin ellas, pero con `ok` indicando si la respuesta fue correcta)
create function private.public_questions(questions jsonb, answers jsonb, mode text) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(
    case mode
      when 'full'   then q
      when 'graded' then (q - 'correct') || jsonb_build_object('ok', private.same_set(answers -> (q ->> 'id'), q -> 'correct'))
      else q - 'correct'
    end order by n), '[]'::jsonb)
  from jsonb_array_elements(questions) with ordinality t(q, n);
$$;

create function private.new_cert_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- 32 símbolos: byte % 32 no tiene sesgo
  b bytea;
  s text;
begin
  loop
    b := extensions.gen_random_bytes(8);
    s := '';
    for i in 0..7 loop
      s := s || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
    end loop;
    s := 'HDI-' || substr(s, 1, 4) || '-' || substr(s, 5, 4);
    exit when not exists (select 1 from public.certificates where code = s);
  end loop;
  return s;
end $$;

/* ---------- Serialización (camelCase, compatible con app.js) ---------- */
create function private.profile_json(p public.profiles) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'name', p.name, 'email', p.email, 'role', p.role, 'createdAt', p.created_at);
$$;

create function private.exam_json(e public.exams, p_full boolean) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', e.id, 'title', e.title, 'description', e.description, 'published', e.published,
    'questions', case when p_full then e.questions else private.public_questions(e.questions, '{}', 'hidden') end,
    'createdAt', e.created_at, 'updatedAt', e.updated_at);
$$;

create function private.attempt_json(a public.attempts, mode text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', a.id, 'userId', a.user_id, 'examId', a.exam_id, 'examTitle', a.exam_title,
    'number', a.number, 'startedAt', a.started_at, 'finishedAt', a.finished_at,
    'questionsSnapshot', private.public_questions(a.questions_snapshot, a.answers, mode),
    'answers', a.answers, 'currentIndex', a.current_index,
    'correctCount', a.correct_count, 'total', a.total, 'percentage', a.percentage,
    'status', a.status);
$$;

create function private.cert_json(c public.certificates) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'code', c.code, 'userId', c.user_id, 'userName', c.user_name,
    'examId', c.exam_id, 'examTitle', c.exam_title, 'attemptId', c.attempt_id,
    'percentage', c.percentage, 'issuedAt', c.issued_at);
$$;

-- Qué tanto del intento puede ver quien consulta (misma regla que viewResult)
create function private.reveal_mode(a public.attempts, adm boolean) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when adm then 'full'
    when a.status = 'in_progress' then 'hidden'
    when exists (select 1 from public.certificates c where c.user_id = a.user_id and c.exam_id = a.exam_id)
      or (select count(*) from public.attempts x where x.user_id = a.user_id and x.exam_id = a.exam_id) >= 3
      then 'full'
    else 'graded'
  end;
$$;

/* ---------------------------------------------------------
   RPC: lectura
   --------------------------------------------------------- */
-- Devuelve todo lo que la sesión actual puede ver, en una sola llamada.
create function public.get_state() returns jsonb
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
                 from public.attempts a where v_adm or a.user_id = v_uid),
    'certificates', (select coalesce(jsonb_agg(private.cert_json(c) order by c.issued_at), '[]')
                     from public.certificates c where v_adm or c.user_id = v_uid)
  );
end $$;

/* ---------------------------------------------------------
   RPC: intentos (estudiante)
   --------------------------------------------------------- */
-- Crea un nuevo intento o reanuda el que está en curso.
create function public.start_attempt(p_exam_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := private.require_user();
  v_exam public.exams;
  v_att  public.attempts;
  v_used int;
begin
  -- serializa inicios concurrentes del mismo usuario sobre el mismo examen
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_exam_id, 0));

  select * into v_exam from public.exams where id = p_exam_id;
  if not found or not v_exam.published then
    raise exception 'El examen no está disponible.';
  end if;
  if jsonb_array_length(v_exam.questions) = 0 then
    raise exception 'El examen no tiene preguntas.';
  end if;

  select * into v_att from public.attempts
  where user_id = v_uid and exam_id = p_exam_id and status = 'in_progress';
  if found then return private.attempt_json(v_att, 'hidden'); end if;

  select count(*) into v_used from public.attempts where user_id = v_uid and exam_id = p_exam_id;
  if v_used >= 3 then
    raise exception 'Has alcanzado el máximo de 3 intentos.';
  end if;

  insert into public.attempts (user_id, exam_id, exam_title, number, questions_snapshot, total)
  values (v_uid, v_exam.id, v_exam.title, v_used + 1, v_exam.questions, jsonb_array_length(v_exam.questions))
  returning * into v_att;

  return private.attempt_json(v_att, 'hidden');
end $$;

create function public.save_answer(p_attempt_id uuid, p_question_id text, p_option_ids text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_att public.attempts;
  v_q   jsonb;
begin
  select * into v_att from public.attempts where id = p_attempt_id and user_id = v_uid for update;
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

create function public.set_attempt_index(p_attempt_id uuid, p_index int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_att public.attempts;
begin
  update public.attempts
  set current_index = greatest(0, least(p_index, total - 1))
  where id = p_attempt_id and user_id = v_uid and status = 'in_progress'
  returning * into v_att;
  if not found then raise exception 'Intento no encontrado o ya finalizado.'; end if;
  return private.attempt_json(v_att, 'hidden');
end $$;

-- Califica en el servidor y emite el certificado si corresponde.
-- Devuelve { attempt, certificate } (certificate es null si no hay).
create function public.finish_attempt(p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := private.require_user();
  v_att     public.attempts;
  v_cert    public.certificates;
  v_correct int;
begin
  select * into v_att from public.attempts where id = p_attempt_id and user_id = v_uid for update;
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

/* ---------------------------------------------------------
   RPC: administración de exámenes
   --------------------------------------------------------- */
-- Crea o actualiza un examen validando su estructura.
create function public.admin_save_exam(p_exam jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id        text := nullif(btrim(coalesce(p_exam ->> 'id', '')), '');
  v_title     text := btrim(coalesce(p_exam ->> 'title', ''));
  v_published boolean := coalesce((p_exam ->> 'published')::boolean, false);
  v_q         jsonb;
  v_n         int := 0;
  v_opts      jsonb;
  v_opt_ids   text[];
  v_correct   text[];
  v_ids       text[] := '{}';
  v_clean     jsonb := '[]';
  v_exam      public.exams;
begin
  perform private.require_admin();

  if v_title = '' then raise exception 'Escribe el título del examen.'; end if;
  if jsonb_typeof(coalesce(p_exam -> 'questions', '[]')) <> 'array' then
    raise exception 'Formato de preguntas no válido.';
  end if;

  for v_q in select q from jsonb_array_elements(coalesce(p_exam -> 'questions', '[]')) t(q) loop
    v_n := v_n + 1;
    if coalesce(v_q ->> 'id', '') = '' or (v_q ->> 'id') = any(v_ids) then
      raise exception 'Pregunta %: identificador no válido o repetido.', v_n;
    end if;
    v_ids := v_ids || (v_q ->> 'id');
    if btrim(coalesce(v_q ->> 'text', '')) = '' then
      raise exception 'Pregunta %: escribe el enunciado.', v_n;
    end if;
    if coalesce(v_q ->> 'type', '') not in ('single', 'multiple') then
      raise exception 'Pregunta %: tipo de pregunta no válido.', v_n;
    end if;
    if jsonb_typeof(coalesce(v_q -> 'options', '[]')) <> 'array' then
      raise exception 'Pregunta %: formato de opciones no válido.', v_n;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('id', o ->> 'id', 'text', btrim(o ->> 'text')) order by k), '[]'),
           array_agg(o ->> 'id' order by k)
      into v_opts, v_opt_ids
    from jsonb_array_elements(coalesce(v_q -> 'options', '[]')) with ordinality t(o, k)
    where coalesce(o ->> 'id', '') <> '' and btrim(coalesce(o ->> 'text', '')) <> '';

    if coalesce(cardinality(v_opt_ids), 0) < 2 then
      raise exception 'Pregunta %: agrega al menos 2 opciones.', v_n;
    end if;
    if cardinality(v_opt_ids) <> (select count(distinct x) from unnest(v_opt_ids) x) then
      raise exception 'Pregunta %: hay opciones repetidas.', v_n;
    end if;

    select coalesce(array_agg(distinct c), '{}') into v_correct
    from jsonb_array_elements_text(coalesce(v_q -> 'correct', '[]')) t(c)
    where c = any (v_opt_ids);

    if v_q ->> 'type' = 'single' and cardinality(v_correct) <> 1 then
      raise exception 'Pregunta %: marca una única respuesta correcta.', v_n;
    end if;
    if v_q ->> 'type' = 'multiple' and cardinality(v_correct) < 1 then
      raise exception 'Pregunta %: marca al menos una respuesta correcta.', v_n;
    end if;

    v_clean := v_clean || jsonb_build_array(jsonb_build_object(
      'id', v_q ->> 'id', 'text', btrim(v_q ->> 'text'), 'type', v_q ->> 'type',
      'options', v_opts, 'correct', to_jsonb(v_correct)));
  end loop;

  if v_published and v_n = 0 then
    raise exception 'Agrega al menos una pregunta para publicar.';
  end if;

  if v_id is null then
    v_id := 'exam_' || replace(gen_random_uuid()::text, '-', '');
  end if;

  insert into public.exams (id, title, description, published, questions)
  values (v_id, v_title, btrim(coalesce(p_exam ->> 'description', '')), v_published, v_clean)
  on conflict (id) do update set
    title       = excluded.title,
    description = excluded.description,
    published   = excluded.published,
    questions   = excluded.questions,
    updated_at  = now()
  returning * into v_exam;

  return private.exam_json(v_exam, true);
end $$;

create function public.admin_set_exam_published(p_exam_id text, p_published boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_exam public.exams;
begin
  perform private.require_admin();
  select * into v_exam from public.exams where id = p_exam_id for update;
  if not found then raise exception 'Examen no encontrado.'; end if;
  if p_published and jsonb_array_length(v_exam.questions) = 0 then
    raise exception 'Agrega al menos una pregunta antes de publicar.';
  end if;
  update public.exams set published = p_published, updated_at = now()
  where id = p_exam_id returning * into v_exam;
  return private.exam_json(v_exam, true);
end $$;

-- Los intentos y certificados históricos se conservan.
create function public.admin_delete_exam(p_exam_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  delete from public.exams where id = p_exam_id;
end $$;

/* ---------------------------------------------------------
   Datos de demostración
   --------------------------------------------------------- */
-- Pregunta demo con ids deterministas: <id>_o0, <id>_o1, …
create function private.demo_q(p_id text, p_text text, p_type text, p_options text[], p_correct int[]) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_id, 'text', p_text, 'type', p_type,
    'options', (select jsonb_agg(jsonb_build_object('id', p_id || '_o' || (k - 1), 'text', t) order by k)
                from unnest(p_options) with ordinality u(t, k)),
    'correct', (select jsonb_agg(p_id || '_o' || c order by c) from unnest(p_correct) c));
$$;

-- Reemplaza exámenes, intentos y certificados por los de demostración.
-- No toca cuentas de usuario (las crea supabase/seed.sql).
create function private.seed_demo() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_student constant uuid := '00000000-0000-4000-8000-000000000002';
  v_qs   jsonb;
  v_a1   jsonb;
  v_a2   jsonb;
  v_c    int;
  v_total int;
  v_att2 public.attempts;
begin
  -- `where true`: pg_safeupdate rechaza DELETE sin WHERE en llamadas vía API
  delete from public.certificates where true;
  delete from public.attempts where true;
  delete from public.exams where true;

  insert into public.exams (id, title, description, published, questions) values
  ('exam_fundamentos', 'Fundamentos de Seguros',
   'Conceptos esenciales del sector asegurador: riesgo, póliza, prima, deducible y coberturas.', true,
   jsonb_build_array(
     private.demo_q('q_fund_1', '¿Qué es la prima en un contrato de seguro?', 'single',
       array['El valor que paga el asegurado por la cobertura', 'La indemnización que paga la aseguradora', 'El documento que formaliza el contrato', 'El monto máximo asegurado'], array[0]),
     private.demo_q('q_fund_2', '¿Qué documento formaliza el contrato de seguro?', 'single',
       array['La factura', 'La póliza', 'El siniestro', 'El endoso'], array[1]),
     private.demo_q('q_fund_3', 'Selecciona los elementos esenciales de un contrato de seguro.', 'multiple',
       array['Interés asegurable', 'Riesgo asegurable', 'Prima', 'Descuento comercial'], array[0, 1, 2]),
     private.demo_q('q_fund_4', '¿Qué es un siniestro?', 'single',
       array['La renovación de la póliza', 'La materialización del riesgo cubierto', 'Un tipo de reaseguro', 'La cancelación del contrato'], array[1]),
     private.demo_q('q_fund_5', 'El deducible es:', 'single',
       array['La parte de la pérdida que asume el asegurado', 'Un beneficio adicional', 'El impuesto del seguro', 'La comisión del intermediario'], array[0]),
     private.demo_q('q_fund_6', '¿Cuáles de los siguientes son seguros de daños?', 'multiple',
       array['Seguro de automóviles', 'Seguro de hogar', 'Seguro de vida', 'Seguro de incendio'], array[0, 1, 3]),
     private.demo_q('q_fund_7', '¿Quién es el tomador del seguro?', 'single',
       array['Quien recibe la indemnización siempre', 'Quien contrata el seguro y paga la prima', 'El perito de la aseguradora', 'El reasegurador'], array[1]),
     private.demo_q('q_fund_8', 'El reaseguro es:', 'single',
       array['Un seguro para las aseguradoras', 'Una renovación automática', 'Un seguro obligatorio de tránsito', 'Un descuento por buen historial'], array[0])
   )),
  ('exam_servicio', 'Atención y Servicio al Cliente',
   'Buenas prácticas de servicio, comunicación efectiva y gestión de reclamaciones.', true,
   jsonb_build_array(
     private.demo_q('q_serv_1', '¿Cuál es el primer paso ante la reclamación de un cliente?', 'single',
       array['Escuchar activamente', 'Transferir la llamada', 'Ofrecer un descuento', 'Cerrar el caso'], array[0]),
     private.demo_q('q_serv_2', 'Selecciona prácticas de comunicación efectiva.', 'multiple',
       array['Usar lenguaje claro', 'Confirmar la comprensión', 'Interrumpir para ahorrar tiempo', 'Mostrar empatía'], array[0, 1, 3]),
     private.demo_q('q_serv_3', 'Un cliente satisfecho suele:', 'single',
       array['Cancelar su póliza', 'Recomendar la compañía', 'Presentar más quejas', 'Ignorar las comunicaciones'], array[1]),
     private.demo_q('q_serv_4', '¿Qué indicador mide la probabilidad de que un cliente recomiende la empresa?', 'single',
       array['ROI', 'NPS', 'KPI de ventas', 'EBITDA'], array[1]),
     private.demo_q('q_serv_5', 'Selecciona canales de atención digitales.', 'multiple',
       array['Chat en línea', 'Aplicación móvil', 'Correo electrónico', 'Oficina física'], array[0, 1, 2]),
     private.demo_q('q_serv_6', 'Ante un error de la compañía, lo correcto es:', 'single',
       array['Negarlo', 'Reconocerlo y ofrecer solución', 'Culpar al cliente', 'Esperar a que el cliente lo olvide'], array[1])
   )),
  ('exam_fraude', 'Prevención de Fraude',
   'Identificación de señales de alerta y protocolos ante posibles fraudes en seguros.', false,
   jsonb_build_array(
     private.demo_q('q_frau_1', '¿Cuál es una señal de alerta de fraude?', 'single',
       array['Reclamación presentada con documentos completos', 'Siniestro reportado poco después de contratar la póliza', 'Cliente con años de antigüedad', 'Pago puntual de primas'], array[1]),
     private.demo_q('q_frau_2', 'Selecciona acciones correctas ante una sospecha de fraude.', 'multiple',
       array['Documentar la evidencia', 'Escalar al área encargada', 'Confrontar públicamente al cliente', 'Seguir el protocolo interno'], array[0, 1, 3]),
     private.demo_q('q_frau_3', 'El fraude en seguros afecta principalmente a:', 'single',
       array['Solo a la aseguradora', 'A todos los asegurados vía mayores primas', 'A nadie', 'Solo al Estado'], array[1])
   ));

  -- Intento 1 (reprobado) y 2 (aprobado con certificado) de la estudiante demo
  if exists (select 1 from public.profiles where id = v_student) then
    select questions into v_qs from public.exams where id = 'exam_servicio';
    v_total := jsonb_array_length(v_qs);

    select jsonb_object_agg(q ->> 'id',
             case when n <= 4 then q -> 'correct' else jsonb_build_array(q -> 'options' -> -1 ->> 'id') end)
      into v_a1
    from jsonb_array_elements(v_qs) with ordinality t(q, n);

    select jsonb_object_agg(q ->> 'id', q -> 'correct') into v_a2
    from jsonb_array_elements(v_qs) t(q);

    v_c := private.grade(v_qs, v_a1);
    insert into public.attempts (user_id, exam_id, exam_title, number, started_at, finished_at,
                                 questions_snapshot, answers, current_index, correct_count, total, percentage, status)
    values (v_student, 'exam_servicio', 'Atención y Servicio al Cliente', 1,
            now() - interval '3 days 10 minutes', now() - interval '3 days',
            v_qs, v_a1, v_total - 1, v_c, v_total, round(v_c * 100.0 / v_total), 'finished');

    v_c := private.grade(v_qs, v_a2);
    insert into public.attempts (user_id, exam_id, exam_title, number, started_at, finished_at,
                                 questions_snapshot, answers, current_index, correct_count, total, percentage, status)
    values (v_student, 'exam_servicio', 'Atención y Servicio al Cliente', 2,
            now() - interval '1 day 10 minutes', now() - interval '1 day',
            v_qs, v_a2, v_total - 1, v_c, v_total, round(v_c * 100.0 / v_total), 'finished')
    returning * into v_att2;

    insert into public.certificates (code, user_id, user_name, exam_id, exam_title, attempt_id, percentage, issued_at)
    select private.new_cert_code(), v_student, p.name, v_att2.exam_id, v_att2.exam_title,
           v_att2.id, v_att2.percentage, v_att2.finished_at
    from public.profiles p where p.id = v_student;
  end if;
end $$;

-- Botón "Restablecer datos" del panel admin
create function public.admin_reset_demo() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  perform private.seed_demo();
end $$;

/* ---------------------------------------------------------
   Permisos de las RPC: solo usuarios autenticados
   (Supabase concede EXECUTE a anon por defecto en `public`)
   --------------------------------------------------------- */
do $$
declare f text;
begin
  foreach f in array array[
    'public.get_state()',
    'public.start_attempt(text)',
    'public.save_answer(uuid, text, text[])',
    'public.set_attempt_index(uuid, int)',
    'public.finish_attempt(uuid)',
    'public.admin_save_exam(jsonb)',
    'public.admin_set_exam_published(text, boolean)',
    'public.admin_delete_exam(text)',
    'public.admin_reset_demo()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
