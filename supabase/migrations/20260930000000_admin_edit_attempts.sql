-- =========================================================
-- Registro y edición de intentos por parte de un administrador
--
-- Permite cargar evaluaciones que un estudiante presentó por otro medio
-- (intento "manual") y corregir las respuestas de intentos finalizados.
-- La calificación y el certificado se recalculan en el servidor con las
-- mismas reglas que un intento normal. Cada cambio queda registrado
-- (edited_at / edited_by).
-- =========================================================

alter table public.attempts
  add column manual    boolean not null default false,
  add column edited_at timestamptz,
  add column edited_by uuid references public.profiles (id) on delete set null;

create index attempts_edited_by_idx on public.attempts (edited_by);

create or replace function private.attempt_json(a public.attempts, mode text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', a.id, 'userId', a.user_id, 'examId', a.exam_id, 'examTitle', a.exam_title,
    'number', a.number, 'startedAt', a.started_at, 'finishedAt', a.finished_at,
    'questionsSnapshot', private.public_questions(a.questions_snapshot, a.answers, mode),
    'answers', a.answers, 'currentIndex', a.current_index,
    'correctCount', a.correct_count, 'total', a.total, 'percentage', a.percentage,
    'status', a.status, 'manual', a.manual, 'editedAt', a.edited_at);
$$;

-- Valida las respuestas contra las preguntas del intento y las normaliza
-- ({ questionId: [optionId] }). Una pregunta sin opciones queda sin responder.
create function private.clean_answers(p_questions jsonb, p_answers jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_q   jsonb;
  v_n   int := 0;
  v_sel text[];
  v_out jsonb := '{}';
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception 'Formato de respuestas no válido.';
  end if;

  for v_q in select q from jsonb_array_elements(p_questions) with ordinality t(q, n) order by n loop
    v_n := v_n + 1;
    continue when not (p_answers ? (v_q ->> 'id'));
    if jsonb_typeof(p_answers -> (v_q ->> 'id')) <> 'array' then
      raise exception 'Pregunta %: formato de respuesta no válido.', v_n;
    end if;

    select coalesce(array_agg(distinct o), '{}') into v_sel
    from jsonb_array_elements_text(p_answers -> (v_q ->> 'id')) t(o)
    where o is not null;
    continue when cardinality(v_sel) = 0;

    if exists (
      select 1 from unnest(v_sel) o
      where not exists (select 1 from jsonb_array_elements(v_q -> 'options') t(x) where x ->> 'id' = o)
    ) then
      raise exception 'Pregunta %: opción no válida.', v_n;
    end if;
    if v_q ->> 'type' = 'single' and cardinality(v_sel) > 1 then
      raise exception 'Pregunta %: selecciona una única opción.', v_n;
    end if;

    v_out := v_out || jsonb_build_object(v_q ->> 'id', to_jsonb(v_sel));
  end loop;
  return v_out;
end $$;

-- Ajusta el certificado de un estudiante en un examen tras editar intentos:
--  · si el intento que lo respalda sigue en 90 % o más, actualiza el puntaje;
--  · si bajó de 90 %, lo retira y lo emite de nuevo desde otro intento
--    vigente aprobado (si existe);
--  · si no había certificado y hay un intento vigente aprobado, lo emite.
-- Un certificado respaldado por un intento anulado no se toca.
create function private.sync_certificate(p_user_id uuid, p_exam_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_cert public.certificates;
  v_att  public.attempts;
begin
  select * into v_cert from public.certificates
  where user_id = p_user_id and exam_id = p_exam_id for update;

  if found then
    select * into v_att from public.attempts where id = v_cert.attempt_id;
    if v_att.voided_at is not null then return; end if;
    if v_att.status = 'finished' and v_att.percentage >= 90 then
      update public.certificates set percentage = v_att.percentage where id = v_cert.id;
      return;
    end if;
    delete from public.certificates where id = v_cert.id;
  end if;

  select * into v_att from public.attempts
  where user_id = p_user_id and exam_id = p_exam_id and voided_at is null
    and status = 'finished' and percentage >= 90
  order by finished_at, number
  limit 1;

  if found then
    insert into public.certificates (code, user_id, user_name, exam_id, exam_title, attempt_id, percentage, issued_at)
    select private.new_cert_code(), v_att.user_id, p.name, v_att.exam_id, v_att.exam_title,
           v_att.id, v_att.percentage, v_att.finished_at
    from public.profiles p where p.id = v_att.user_id;
  end if;
end $$;

/* ---------- Nueva RPC ---------- */
-- Con p_attempt_id: reemplaza las respuestas de un intento finalizado.
-- Sin p_attempt_id: registra un intento finalizado nuevo (p_user_id, p_exam_id)
-- con las preguntas actuales del examen; cuenta para el máximo de 3.
-- p_taken_at: fecha de presentación (null = conservar / ahora).
-- Devuelve el intento con las respuestas correctas.
create function public.admin_save_attempt(
  p_attempt_id uuid, p_user_id uuid, p_exam_id text, p_answers jsonb, p_taken_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_att     public.attempts;
  v_exam    public.exams;
  v_used    int;
  v_answers jsonb;
  v_correct int;
  v_total   int;
begin
  perform private.require_admin();
  if p_taken_at > now() + interval '5 minutes' then
    raise exception 'La fecha de presentación no puede estar en el futuro.';
  end if;

  if p_attempt_id is not null then
    select * into v_att from public.attempts
    where id = p_attempt_id and voided_at is null for update;
    if not found then raise exception 'Intento no encontrado.'; end if;
    if v_att.status <> 'finished' then
      raise exception 'El estudiante tiene este intento en curso; podrás editarlo cuando lo finalice.';
    end if;

    v_answers := private.clean_answers(v_att.questions_snapshot, p_answers);
    v_total   := jsonb_array_length(v_att.questions_snapshot);
    v_correct := private.grade(v_att.questions_snapshot, v_answers);

    update public.attempts set
      answers       = v_answers,
      correct_count = v_correct,
      total         = v_total,
      percentage    = case when v_total > 0 then round(v_correct * 100.0 / v_total) else 0 end,
      finished_at   = coalesce(p_taken_at, finished_at),
      started_at    = least(started_at, coalesce(p_taken_at, finished_at)),
      edited_at     = now(),
      edited_by     = auth.uid()
    where id = v_att.id
    returning * into v_att;
  else
    if p_user_id is null or coalesce(p_exam_id, '') = '' then
      raise exception 'Selecciona el estudiante y el examen.';
    end if;
    if not exists (select 1 from public.profiles where id = p_user_id) then
      raise exception 'Estudiante no encontrado.';
    end if;
    -- misma llave que start_attempt: evita cruzarse con un intento que se está creando
    perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_exam_id, 0));

    select * into v_exam from public.exams where id = p_exam_id;
    if not found then raise exception 'Examen no encontrado.'; end if;
    v_total := jsonb_array_length(v_exam.questions);
    if v_total = 0 then raise exception 'El examen no tiene preguntas.'; end if;

    select count(*) into v_used from public.attempts
    where user_id = p_user_id and exam_id = p_exam_id and voided_at is null;
    if v_used >= 3 then
      raise exception 'El estudiante ya tiene 3 intentos en este examen. Edita uno de ellos o reinicia sus intentos.';
    end if;

    v_answers := private.clean_answers(v_exam.questions, p_answers);
    v_correct := private.grade(v_exam.questions, v_answers);

    insert into public.attempts (user_id, exam_id, exam_title, number, started_at, finished_at,
                                 questions_snapshot, answers, current_index, correct_count, total,
                                 percentage, status, manual, edited_at, edited_by)
    values (p_user_id, v_exam.id, v_exam.title, v_used + 1,
            coalesce(p_taken_at, now()), coalesce(p_taken_at, now()),
            v_exam.questions, v_answers, 0, v_correct, v_total,
            round(v_correct * 100.0 / v_total), 'finished', true, now(), auth.uid())
    returning * into v_att;
  end if;

  perform private.sync_certificate(v_att.user_id, v_att.exam_id);
  return private.attempt_json(v_att, 'full');
end $$;

revoke execute on function public.admin_save_attempt(uuid, uuid, text, jsonb, timestamptz) from public, anon;
grant execute on function public.admin_save_attempt(uuid, uuid, text, jsonb, timestamptz) to authenticated;
