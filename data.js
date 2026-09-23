/* =========================================================
   data.js — Capa de datos sobre Supabase
   Requiere supabase-js v2 cargado antes (window.supabase).

   · Lecturas síncronas: Store.users/exams/attempts/certificates()
     devuelven copias de una caché en memoria que se carga con
     init() / refresh() desde la RPC `get_state`.
   · Escrituras asíncronas: Auth.* y Api.* llaman a las RPC (reglas de
     negocio en el servidor) y actualizan la caché.
   · Gestión de usuarios: Edge Function `admin-users`.
   ========================================================= */
(function (global) {
  'use strict';

  // Valores públicos del proyecto (la publishable key está pensada para el navegador).
  const SUPABASE_URL = 'https://ppxtrcpdsspdzxydcfli.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_IAe8rHSC2nhdKHw1l29stA_flkvc8Cv';

  // Solo para mostrar en la interfaz: la regla real se aplica en la base de datos.
  const MAX_ATTEMPTS = 3;
  const PASS_PERCENT = 90;
  const MIN_PASSWORD_LENGTH = 8; // igual a "Minimum password length" de Supabase Auth

  const client = global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  /* ---------- Utilidades ---------- */
  // Ids de preguntas y opciones en el editor de exámenes
  function uid(prefix) {
    const rnd = new Uint32Array(2);
    global.crypto.getRandomValues(rnd);
    return (prefix || 'id') + '_' + Date.now().toString(36) + rnd[0].toString(36) + rnd[1].toString(36).slice(0, 4);
  }

  function clone(v) {
    return v == null ? v : JSON.parse(JSON.stringify(v));
  }

  async function rpc(fn, args) {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data;
  }

  async function invokeAdminUsers(body) {
    const { data, error } = await client.functions.invoke('admin-users', { body });
    if (error) {
      let message = error.message;
      try { message = (await error.context.json()).error || message; } catch (e) { /* respuesta sin JSON */ }
      throw new Error(message);
    }
    return data;
  }

  /* ---------- Caché ---------- */
  function emptyCache() {
    return { me: null, users: [], exams: [], attempts: [], certificates: [] };
  }
  let cache = emptyCache();

  function put(collection, item) {
    const list = cache[collection];
    const idx = list.findIndex(x => x.id === item.id);
    if (idx === -1) list.push(item); else list[idx] = item;
  }

  /** Recarga todo lo visible para la sesión actual. Devuelve el usuario o null. */
  async function refresh() {
    // Las RPC solo aceptan usuarios autenticados; sin sesión no hay nada que cargar.
    const { data: { session } } = await client.auth.getSession();
    if (!session) {
      cache = emptyCache();
      return null;
    }
    const state = await rpc('get_state');
    cache = state ? {
      me: state.me,
      users: state.users || [],
      exams: state.exams || [],
      attempts: state.attempts || [],
      certificates: state.certificates || []
    } : emptyCache();
    return clone(cache.me);
  }

  const Store = {
    users() { return clone(cache.users); },
    exams() { return clone(cache.exams); },
    attempts() { return clone(cache.attempts); },
    certificates() { return clone(cache.certificates); }
  };

  /* ---------- Sesión ---------- */
  const listeners = new Set();
  let localAuthOp = false; // login/registro/salida iniciados en esta pestaña

  async function ownAuthOp(task) {
    localAuthOp = true;
    try { return await task(); } finally { localAuthOp = false; }
  }

  /** Carga la sesión guardada y los datos. Llamar una vez antes del primer render. */
  async function init() {
    await refresh();
    // Solo notifica cambios externos (otra pestaña, sesión expirada).
    // No se debe esperar a otras llamadas de supabase dentro de este callback.
    client.auth.onAuthStateChange((event, session) => {
      if (localAuthOp) return;
      if (event === 'SIGNED_OUT' && cache.me) {
        cache = emptyCache();
        listeners.forEach(cb => cb(event));
      } else if (event === 'SIGNED_IN' && session && (!cache.me || cache.me.id !== session.user.id)) {
        setTimeout(() => refresh().then(() => listeners.forEach(cb => cb(event)), () => {}), 0);
      }
    });
  }

  function onAuthChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  const Auth = {
    current() { return clone(cache.me); },

    /** Devuelve el usuario, o null si las credenciales no son válidas. */
    login(email, password) {
      return ownAuthOp(async () => {
        const { error } = await client.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
        if (error) {
          if (error.code === 'invalid_credentials' || error.status === 400) return null;
          throw new Error(error.message);
        }
        return refresh();
      });
    },

    register(name, email, password) {
      return ownAuthOp(() => signUp(name, email, password));
    },

    logout() {
      return ownAuthOp(async () => {
        cache = emptyCache();
        await client.auth.signOut();
      });
    }
  };

  async function signUp(name, email, password) {
    const { data, error } = await client.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: { data: { name: name.trim() } }
    });
    if (error) {
      if (error.code === 'user_already_exists' || /already registered/i.test(error.message)) {
        throw new Error('Ya existe una cuenta con ese correo.');
      }
      throw new Error(error.message);
    }
    // Con confirmación de correo activa, Supabase no abre sesión hasta confirmar.
    if (!data.session) throw new Error('Te enviamos un correo para confirmar tu cuenta. Confírmala y luego inicia sesión.');
    return refresh();
  }

  /* ---------- Operaciones ---------- */
  const Api = {
    /** Crea un nuevo intento o reanuda el que está en curso. */
    async startAttempt(examId) {
      const att = await rpc('start_attempt', { p_exam_id: examId });
      put('attempts', att);
      return clone(att);
    },

    async saveAnswer(attemptId, questionId, optionIds) {
      const att = await rpc('save_answer', { p_attempt_id: attemptId, p_question_id: questionId, p_option_ids: optionIds });
      put('attempts', att);
      return clone(att);
    },

    async setAttemptIndex(attemptId, index) {
      const att = await rpc('set_attempt_index', { p_attempt_id: attemptId, p_index: index });
      put('attempts', att);
      return clone(att);
    },

    /** Califica en el servidor. Devuelve { attempt, certificate }. */
    async finishAttempt(attemptId) {
      const result = await rpc('finish_attempt', { p_attempt_id: attemptId });
      // Recarga todo: terminar puede revelar las respuestas de otros intentos del mismo examen.
      await refresh();
      return clone(result);
    },

    async saveExam(exam) {
      const saved = await rpc('admin_save_exam', { p_exam: exam });
      put('exams', saved);
      return clone(saved);
    },

    async setExamPublished(examId, published) {
      const saved = await rpc('admin_set_exam_published', { p_exam_id: examId, p_published: published });
      put('exams', saved);
      return clone(saved);
    },

    async deleteExam(examId) {
      await rpc('admin_delete_exam', { p_exam_id: examId });
      cache.exams = cache.exams.filter(e => e.id !== examId);
    },

    /** Crea (sin id) o actualiza (con id) una cuenta. password vacío = no cambiar. */
    async saveUser({ id, name, email, role, password }) {
      await invokeAdminUsers({ action: id ? 'update' : 'create', id, name, email, role, password });
      await refresh();
    },

    async deleteUser(id) {
      await invokeAdminUsers({ action: 'delete', id });
      await refresh();
    },

    async resetDemo() {
      await rpc('admin_reset_demo');
      await refresh();
    }
  };

  /* ---------- Calificación local ---------- */
  // Solo para mostrar el detalle de un intento. Si el servidor ocultó las
  // respuestas correctas, la pregunta trae `ok` con el resultado ya calculado.
  function isCorrect(question, selected) {
    if (!question.correct) return !!question.ok;
    const s = (selected || []).slice().sort();
    const c = question.correct.slice().sort();
    return s.length === c.length && s.every((v, i) => v === c[i]);
  }

  global.HDIData = {
    MAX_ATTEMPTS, PASS_PERCENT, MIN_PASSWORD_LENGTH,
    client, init, refresh, onAuthChange,
    Store, Auth, Api, uid, isCorrect
  };
})(window);
