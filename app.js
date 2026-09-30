/* =========================================================
   app.js — Campus HDI: SPA de exámenes (JavaScript vanilla)
   Módulos: UI, Auth, Domain, Router, Views (auth, estudiante,
   motor de examen, resultados, certificado, administración)
   ========================================================= */
(function () {
  'use strict';

  const { Store, Api, MAX_ATTEMPTS, PASS_PERCENT, MIN_PASSWORD_LENGTH, uid, isCorrect } = window.HDIData;

  const $app = document.getElementById('app');
  const $nav = document.getElementById('mainNav');

  /* =======================================================
     UI — utilidades de interfaz
     ======================================================= */
  const UI = {
    esc(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    fmtDateTime(iso) {
      return iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
    },
    fmtDate(iso) {
      return iso ? new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
    },
    initials(name) {
      return String(name || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase();
    },
    toast(msg, type) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'toast show' + (type ? ' ' + type : '');
      clearTimeout(UI._toastTimer);
      UI._toastTimer = setTimeout(() => { t.className = 'toast'; }, 2800);
    },
    /**
     * Ejecuta una operación asíncrona bloqueando `btn` mientras dura (evita doble envío).
     * Los errores se muestran como toast; en ese caso resuelve con undefined.
     */
    async run(btn, task) {
      if (btn) { if (btn.disabled) return; btn.disabled = true; }
      try {
        return await task();
      } catch (ex) {
        UI.toast(ex.message, 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    },
    /**
     * Abre un modal. buttons: [{label, value, cls}]. onSubmit(value, form) → false (o una
     * promesa que resuelve a false) mantiene abierto. Resuelve con el value del botón pulsado
     * (o null si se cierra).
     */
    modal({ title, body, buttons, onSubmit }) {
      const dlg = document.getElementById('modal');
      const form = document.getElementById('modalForm');
      if (UI._closeModal) UI._closeModal(null); // cierra un modal previo pendiente
      document.getElementById('modalTitle').textContent = title;
      document.getElementById('modalBody').innerHTML = body;
      // "cancel" es type=button para que Enter nunca lo active por envío implícito
      document.getElementById('modalFoot').innerHTML = (buttons || []).map(b =>
        `<button type="${b.value === 'cancel' ? 'button' : 'submit'}" ${b.value === 'cancel' ? 'data-close' : ''}
          class="btn ${b.cls || 'btn-outline'}" value="${UI.esc(b.value)}">${UI.esc(b.label)}</button>`
      ).join('');

      return new Promise(resolve => {
        let done = false;
        let submitting = false;
        const finish = val => {
          if (done) return;
          done = true;
          UI._closeModal = null;
          form.removeEventListener('submit', onFormSubmit);
          dlg.removeEventListener('cancel', onCancel);
          dlg.removeEventListener('click', onClose);
          if (dlg.open) dlg.close();
          resolve(val);
        };
        const onFormSubmit = async e => {
          e.preventDefault();
          if (submitting) return;
          const def = form.querySelector('#modalFoot button[type=submit]');
          const val = e.submitter ? e.submitter.value : (def ? def.value : 'ok');
          if (val === 'cancel') return finish(null);
          if (onSubmit) {
            const btns = form.querySelectorAll('#modalFoot button[type=submit]');
            submitting = true;
            btns.forEach(b => { b.disabled = true; });
            let res;
            try { res = await onSubmit(val, form); } finally {
              submitting = false;
              btns.forEach(b => { b.disabled = false; });
            }
            if (res === false || done) return;
          }
          finish(val);
        };
        const onCancel = e => { e.preventDefault(); finish(null); };
        const onClose = e => { if (e.target.closest('[data-close]')) finish(null); };
        form.addEventListener('submit', onFormSubmit);
        dlg.addEventListener('cancel', onCancel);
        dlg.addEventListener('click', onClose);
        UI._closeModal = finish;
        dlg.showModal();
        const first = dlg.querySelector('.modal-body input, .modal-body select, .modal-body textarea');
        if (first) first.focus();
      });
    },
    confirm(message, { title = 'Confirmar', okLabel = 'Aceptar', danger = false } = {}) {
      return UI.modal({
        title,
        body: `<p>${message}</p>`,
        buttons: [
          { label: 'Cancelar', value: 'cancel', cls: 'btn-outline' },
          { label: okLabel, value: 'ok', cls: danger ? 'btn-danger' : 'btn-primary' }
        ]
      }).then(v => v === 'ok');
    },
    badgeForPercent(p) {
      if (p >= PASS_PERCENT) return `<span class="badge badge-success">Aprobado · ${p}%</span>`;
      if (p >= 60) return `<span class="badge badge-warning">${p}%</span>`;
      return `<span class="badge badge-danger">${p}%</span>`;
    },
    emailOk(email) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
    }
  };

  /* =======================================================
     Auth — sesión con Supabase Auth (ver data.js)
     ======================================================= */
  const Auth = Object.assign({}, window.HDIData.Auth, {
    home(user) {
      return user && user.role === 'admin' ? '#/admin' : '#/panel';
    }
  });

  /* =======================================================
     Domain — consultas sobre la caché. Las reglas de negocio
     (intentos, calificación, certificados) se aplican en la base
     de datos y se invocan con Api.* (ver data.js).
     ======================================================= */
  const Domain = {
    exam(id) { return Store.exams().find(e => e.id === id) || null; },

    attemptsFor(userId, examId) {
      return Store.attempts()
        .filter(a => a.userId === userId && a.examId === examId)
        .sort((a, b) => a.number - b.number);
    },

    inProgress(userId, examId) {
      return Domain.attemptsFor(userId, examId).find(a => a.status === 'in_progress') || null;
    },

    certFor(userId, examId) {
      return Store.certificates().find(c => c.userId === userId && c.examId === examId) || null;
    },

    isCorrect
  };

  /* =======================================================
     Router — enrutamiento por hash
     ======================================================= */
  let actions = {};           // acciones [data-action] de la vista actual
  let cleanup = null;         // limpieza de la vista actual

  const routes = [
    { re: /^#\/login$/, view: viewLogin, access: 'guest' },
    { re: /^#\/registro$/, view: viewRegister, access: 'guest' },
    { re: /^#\/panel$/, view: viewStudentHome, access: 'student' },
    { re: /^#\/resultados$/, view: viewStudentResults, access: 'student' },
    { re: /^#\/certificados$/, view: viewStudentCerts, access: 'student' },
    { re: /^#\/intento\/([\w-]+)$/, view: viewAttempt, access: 'student' },
    { re: /^#\/resultado\/([\w-]+)$/, view: viewResult, access: 'user' },
    { re: /^#\/certificado\/([\w-]+)(\/imprimir)?$/, view: viewCertificate, access: 'user' },
    { re: /^#\/admin$/, view: viewAdminDashboard, access: 'admin' },
    { re: /^#\/admin\/examenes$/, view: viewAdminExams, access: 'admin' },
    { re: /^#\/admin\/examen\/([\w-]+)$/, view: viewExamEditor, access: 'admin' },
    { re: /^#\/admin\/usuarios$/, view: viewAdminUsers, access: 'admin' },
    { re: /^#\/admin\/resultados$/, view: viewAdminResults, access: 'admin' },
    { re: /^#\/admin\/resultados\/([\w-]+)$/, view: viewAdminPersonResults, access: 'admin' },
    { re: /^#\/admin\/certificados\/([\w-]+)$/, view: viewAdminPersonCerts, access: 'admin' },
    { re: /^#\/admin\/intento\/([\w-]+)$/, view: viewAdminAttemptEdit, access: 'admin' },
    { re: /^#\/admin\/registrar\/([\w-]+)\/([\w-]+)$/, view: viewAdminAttemptNew, access: 'admin' }
  ];

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function render() {
    if (cleanup) { cleanup(); cleanup = null; }
    actions = {};
    const hash = location.hash || '#/';
    const user = Auth.current();

    if (hash === '#/' || hash === '#') return go(user ? Auth.home(user) : '#/login');

    const route = routes.find(r => r.re.test(hash));
    if (!route) return renderNotFound(user);

    if (route.access === 'guest' && user) return go(Auth.home(user));
    if (route.access !== 'guest' && !user) return go('#/login');
    if (route.access === 'admin' && user.role !== 'admin') return go(Auth.home(user));
    if (route.access === 'student' && user.role !== 'student') return go(Auth.home(user));

    renderNav(user, hash);
    const params = hash.match(route.re).slice(1);
    route.view(user, ...params);
    window.scrollTo(0, 0);
  }

  function renderNotFound(user) {
    renderNav(user, '');
    $app.innerHTML = `
      <section class="card" style="max-width:520px;margin:40px auto;text-align:center">
        <p class="eyebrow">Error 404</p>
        <h1>Página no encontrada</h1>
        <p class="muted">El recurso solicitado no existe o fue eliminado.</p>
        <a class="btn btn-primary" href="#/">Ir al inicio</a>
      </section>`;
  }

  function renderNav(user, hash) {
    let links;
    if (!user) {
      links = [['#/login', 'Iniciar sesión'], ['#/registro', 'Registrarse']];
    } else if (user.role === 'admin') {
      links = ADMIN_TABS;
    } else {
      links = [['#/panel', 'Mis exámenes'], ['#/resultados', 'Resultados'], ['#/certificados', 'Certificados']];
    }
    const isActive = h => hash === h || (h === '#/admin/examenes' && hash.startsWith('#/admin/examen/')) ||
      (h === '#/admin/usuarios' && /^#\/admin\/(intento|registrar)\//.test(hash)) ||
      (h === '#/admin/resultados' && /^#\/(admin\/(resultados|certificados)\/|resultado\/|certificado\/)/.test(hash));
    $nav.innerHTML = links.map(([h, l]) =>
      `<a href="${h}" class="${isActive(h) ? 'active' : ''}" ${isActive(h) ? 'aria-current="page"' : ''}>${l}</a>`
    ).join('') + (user ? `
      <div class="nav-user">
        <span class="avatar" aria-hidden="true">${UI.esc(UI.initials(user.name))}</span>
        <span>${UI.esc(user.name.split(' ')[0])}${user.role === 'admin' ? ' · <span class="badge badge-accent">Admin</span>' : ''}</span>
        <button type="button" class="btn btn-outline btn-sm" id="logoutBtn">Salir</button>
      </div>` : '');
    $nav.classList.remove('open');
    document.getElementById('navToggle').setAttribute('aria-expanded', 'false');
    const lb = document.getElementById('logoutBtn');
    if (lb) lb.addEventListener('click', async () => {
      lb.disabled = true;
      try { await Auth.logout(); } catch (ex) { /* la sesión local ya se limpió */ }
      UI.toast('Sesión cerrada');
      go('#/login');
    });
  }

  /* Delegación de clics para [data-action] */
  $app.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el || !$app.contains(el)) return;
    const fn = actions[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el, e); }
  });

  /* =======================================================
     Vistas: autenticación
     ======================================================= */
  function authHero() {
    return `
      <section class="auth-hero">
        <p class="eyebrow" style="color:var(--accent)">Campus de formación</p>
        <h1>Aprende, evalúate y certifícate con Grupo HDI</h1>
        <p>Plataforma de exámenes para fortalecer el conocimiento de nuestros equipos.</p>
        <ul>
          <li>Exámenes de selección única y múltiple</li>
          <li>Hasta ${MAX_ATTEMPTS} intentos por examen con historial completo</li>
          <li>Certificado digital al obtener ${PASS_PERCENT}% o más</li>
        </ul>
      </section>`;
  }

  function viewLogin() {
    $app.innerHTML = `
      <div class="auth-wrap">
        ${authHero()}
        <section class="card auth-card">
          <h2>Iniciar sesión</h2>
          <p class="muted">Ingresa con tu correo y contraseña.</p>
          <form class="form" id="loginForm" novalidate>
            <div class="field">
              <label for="lEmail">Correo electrónico</label>
              <input class="input" id="lEmail" name="email" type="email" autocomplete="username" required>
            </div>
            <div class="field">
              <label for="lPass">Contraseña</label>
              <input class="input" id="lPass" name="password" type="password" autocomplete="current-password" required>
            </div>
            <p class="form-error" id="lErr" role="alert"></p>
            <button class="btn btn-primary btn-block" type="submit">Ingresar</button>
            <p class="small muted" style="text-align:center;margin:0">¿No tienes cuenta? <a href="#/registro">Regístrate</a></p>
          </form>
        </section>
      </div>`;

    document.getElementById('loginForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      const err = document.getElementById('lErr');
      const btn = f.querySelector('button[type=submit]');
      if (btn.disabled) return;
      if (!f.email.value.trim() || !f.password.value) { err.textContent = 'Completa correo y contraseña.'; return; }
      err.textContent = '';
      btn.disabled = true;
      try {
        const user = await Auth.login(f.email.value, f.password.value);
        if (!user) { err.textContent = 'Correo o contraseña incorrectos.'; return; }
        UI.toast('¡Bienvenido(a), ' + user.name.split(' ')[0] + '!', 'success');
        go(Auth.home(user));
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        btn.disabled = false;
      }
    });
  }

  function viewRegister() {
    $app.innerHTML = `
      <div class="auth-wrap">
        ${authHero()}
        <section class="card auth-card">
          <h2>Crear cuenta</h2>
          <p class="muted">Regístrate para presentar los exámenes disponibles.</p>
          <form class="form" id="regForm" novalidate>
            <div class="field">
              <label for="rName">Nombre completo</label>
              <input class="input" id="rName" name="name" autocomplete="name" required>
            </div>
            <div class="field">
              <label for="rEmail">Correo electrónico</label>
              <input class="input" id="rEmail" name="email" type="email" autocomplete="email" required>
            </div>
            <div class="form-row">
              <div class="field">
                <label for="rPass">Contraseña</label>
                <input class="input" id="rPass" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
              </div>
              <div class="field">
                <label for="rPass2">Confirmar</label>
                <input class="input" id="rPass2" name="password2" type="password" autocomplete="new-password" required>
              </div>
            </div>
            <p class="form-error" id="rErr" role="alert"></p>
            <button class="btn btn-accent btn-block" type="submit">Registrarme</button>
            <p class="small muted" style="text-align:center;margin:0">¿Ya tienes cuenta? <a href="#/login">Inicia sesión</a></p>
          </form>
        </section>
      </div>`;

    document.getElementById('regForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      const err = document.getElementById('rErr');
      const btn = f.querySelector('button[type=submit]');
      if (btn.disabled) return;
      const name = f.name.value.trim(), email = f.email.value.trim();
      if (name.length < 3) { err.textContent = 'Ingresa tu nombre completo.'; return; }
      if (!UI.emailOk(email)) { err.textContent = 'Ingresa un correo válido.'; return; }
      if (f.password.value.length < MIN_PASSWORD_LENGTH) { err.textContent = `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`; return; }
      if (f.password.value !== f.password2.value) { err.textContent = 'Las contraseñas no coinciden.'; return; }
      err.textContent = '';
      btn.disabled = true;
      try {
        const user = await Auth.register(name, email, f.password.value);
        UI.toast('Cuenta creada correctamente', 'success');
        go(Auth.home(user));
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* =======================================================
     Vistas: estudiante
     ======================================================= */
  function attemptDots(used) {
    let dots = '';
    for (let i = 0; i < MAX_ATTEMPTS; i++) dots += `<i class="${i < used ? 'used' : ''}"></i>`;
    return `<div class="attempt-dots" aria-label="${used} de ${MAX_ATTEMPTS} intentos usados">${dots}
      <span>${used}/${MAX_ATTEMPTS} usados · ${Math.max(0, MAX_ATTEMPTS - used)} restantes</span></div>`;
  }

  function examCardHtml(user, exam) {
    const atts = Domain.attemptsFor(user.id, exam.id);
    const finished = atts.filter(a => a.status === 'finished');
    const current = atts.find(a => a.status === 'in_progress');
    const best = finished.length ? Math.max(...finished.map(a => a.percentage)) : null;
    const cert = Domain.certFor(user.id, exam.id);
    const used = atts.length;

    let cta;
    if (current) {
      cta = `<button class="btn btn-accent" data-action="continue" data-id="${current.id}">Continuar intento ${current.number}</button>`;
    } else if (used >= MAX_ATTEMPTS) {
      cta = `<button class="btn btn-outline" disabled>Sin intentos disponibles</button>`;
    } else {
      cta = `<button class="btn btn-primary" data-action="start" data-id="${exam.id}">${used ? 'Nuevo intento' : 'Iniciar examen'} (${used + 1}/${MAX_ATTEMPTS})</button>`;
    }

    return `
      <article class="card exam-card">
        <div class="exam-meta">
          <span class="badge badge-neutral">${exam.questions.length} preguntas</span>
          ${cert ? '<span class="badge badge-success">Certificado</span>' : ''}
          ${current ? '<span class="badge badge-accent">En curso</span>' : ''}
          ${used >= MAX_ATTEMPTS && !current ? '<span class="badge badge-danger">Bloqueado</span>' : ''}
        </div>
        <h3>${UI.esc(exam.title)}</h3>
        <p class="desc">${UI.esc(exam.description)}</p>
        ${attemptDots(used)}
        <p class="small muted" style="margin:0">Mejor resultado: <strong>${best === null ? '—' : best + '%'}</strong></p>
        <div class="btn-row">
          ${cta}
          ${cert ? `<a class="btn btn-ghost" href="#/certificado/${cert.id}">Ver certificado</a>` : ''}
        </div>
      </article>`;
  }

  /** admin: muestra "Editar" en los finalizados y no ofrece continuar los intentos en curso. */
  function historyTableHtml(atts, { showUser = false, users = [], admin = false } = {}) {
    if (!atts.length) return `<div class="table-wrap"><p class="empty">Aún no hay intentos registrados.</p></div>`;
    const userName = id => (users.find(u => u.id === id) || {}).name || 'Usuario eliminado';
    return `
      <div class="table-wrap">
        <table class="table-responsive">
          <thead><tr>
            ${showUser ? '<th>Estudiante</th>' : ''}
            <th>Examen</th><th>Intento</th><th>Fecha y hora</th><th>Correctas</th><th>Incorrectas</th><th>Resultado</th><th></th>
          </tr></thead>
          <tbody>
            ${atts.map(a => {
              const done = a.status === 'finished';
              return `<tr>
                ${showUser ? `<td data-label="Estudiante">${UI.esc(userName(a.userId))}</td>` : ''}
                <td data-label="Examen">${UI.esc(a.examTitle)}</td>
                <td data-label="Intento">#${a.number}${a.manual ? ' <span class="badge badge-neutral" title="Registrado por un administrador">Manual</span>' : ''}</td>
                <td data-label="Fecha">${UI.fmtDateTime(done ? a.finishedAt : a.startedAt)}</td>
                <td data-label="Correctas">${done ? a.correctCount : '—'}</td>
                <td data-label="Incorrectas">${done ? a.total - a.correctCount : '—'}</td>
                <td data-label="Resultado">${done ? UI.badgeForPercent(a.percentage) : '<span class="badge badge-accent">En curso</span>'}</td>
                <td data-label="">${done
                  ? `<div class="btn-row"><a class="btn btn-outline btn-sm" href="#/resultado/${a.id}">Ver detalle</a>${admin
                    ? `<a class="btn btn-ghost btn-sm" href="#/admin/intento/${a.id}">Editar</a>` : ''}</div>`
                  : (!admin ? `<a class="btn btn-accent btn-sm" href="#/intento/${a.id}">Continuar</a>` : '')}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function certListHtml(certs, emptyMsg) {
    if (!certs.length) {
      return `<div class="card"><p class="empty" style="padding:8px">${emptyMsg || `Aún no tienes certificados. Obtén ${PASS_PERCENT}% o más en un examen para recibir uno.`}</p></div>`;
    }
    return `<div class="grid grid-cards">${certs.map(c => `
      <article class="card exam-card">
        <div class="exam-meta"><span class="badge badge-success">${c.percentage}%</span><span class="badge badge-neutral">${UI.esc(c.code)}</span></div>
        <h3>${UI.esc(c.examTitle)}</h3>
        <p class="desc">Emitido el ${UI.fmtDate(c.issuedAt)}</p>
        <div class="btn-row">
          <a class="btn btn-primary btn-sm" href="#/certificado/${c.id}">Ver</a>
          <a class="btn btn-outline btn-sm" href="#/certificado/${c.id}/imprimir">Descargar PDF</a>
        </div>
      </article>`).join('')}</div>`;
  }

  function studentActions(user) {
    actions.start = async el => {
      const exam = Domain.exam(el.dataset.id);
      if (!exam) return;
      const used = Domain.attemptsFor(user.id, exam.id).length;
      const ok = await UI.confirm(
        `Vas a iniciar el <strong>intento ${used + 1} de ${MAX_ATTEMPTS}</strong> de «${UI.esc(exam.title)}».<br><br>
         Cada respuesta confirmada queda bloqueada y no puede modificarse. El intento cuenta desde este momento.`,
        { title: 'Iniciar examen', okLabel: 'Comenzar' });
      if (!ok) return;
      const att = await UI.run(el, () => Api.startAttempt(exam.id));
      if (att) go('#/intento/' + att.id);
      else render();
    };
    actions.continue = el => go('#/intento/' + el.dataset.id);
  }

  function viewStudentHome(user) {
    const exams = Store.exams().filter(e => e.published && e.questions.length);
    const myAtts = Store.attempts().filter(a => a.userId === user.id);
    const finished = myAtts.filter(a => a.status === 'finished');
    const certs = Store.certificates().filter(c => c.userId === user.id);
    const avg = finished.length ? Math.round(finished.reduce((s, a) => s + a.percentage, 0) / finished.length) : 0;

    $app.innerHTML = `
      <div class="page-head">
        <div>
          <p class="eyebrow">Panel del estudiante</p>
          <h1>Hola, ${UI.esc(user.name.split(' ')[0])}</h1>
          <p class="muted">Selecciona un examen para comenzar o continuar.</p>
        </div>
      </div>
      <div class="grid grid-kpi">
        <div class="card kpi"><div class="kpi-value">${exams.length}</div><div class="kpi-label">Exámenes disponibles</div></div>
        <div class="card kpi accent"><div class="kpi-value">${myAtts.length}</div><div class="kpi-label">Intentos realizados</div></div>
        <div class="card kpi"><div class="kpi-value">${avg}%</div><div class="kpi-label">Promedio</div></div>
        <div class="card kpi accent"><div class="kpi-value">${certs.length}</div><div class="kpi-label">Certificados</div></div>
      </div>

      <section class="section">
        <div class="section-title"><h2>Exámenes disponibles</h2></div>
        ${exams.length
          ? `<div class="grid grid-cards">${exams.map(e => examCardHtml(user, e)).join('')}</div>`
          : '<div class="card"><p class="empty">No hay exámenes publicados por el momento.</p></div>'}
      </section>

      <section class="section">
        <div class="section-title"><h2>Últimos resultados</h2><a href="#/resultados" class="btn btn-ghost btn-sm">Ver historial completo</a></div>
        ${historyTableHtml(myAtts.slice().sort((a, b) => (b.finishedAt || b.startedAt).localeCompare(a.finishedAt || a.startedAt)).slice(0, 5))}
      </section>

      <section class="section">
        <div class="section-title"><h2>Mis certificados</h2></div>
        ${certListHtml(certs)}
      </section>`;
    studentActions(user);
  }

  function viewStudentResults(user) {
    const atts = Store.attempts().filter(a => a.userId === user.id)
      .sort((a, b) => (b.finishedAt || b.startedAt).localeCompare(a.finishedAt || a.startedAt));
    $app.innerHTML = `
      <div class="page-head">
        <div><p class="eyebrow">Historial</p><h1>Mis resultados</h1>
        <p class="muted">Cada intento se conserva de forma individual.</p></div>
      </div>
      ${historyTableHtml(atts)}`;
  }

  function viewStudentCerts(user) {
    const certs = Store.certificates().filter(c => c.userId === user.id);
    $app.innerHTML = `
      <div class="page-head">
        <div><p class="eyebrow">Logros</p><h1>Mis certificados</h1>
        <p class="muted">Consulta, imprime o guarda como PDF tus certificados.</p></div>
      </div>
      ${certListHtml(certs)}`;
  }

  /* =======================================================
     Motor de examen — una pregunta a la vez
     ======================================================= */
  function viewAttempt(user, attemptId) {
    let att = Store.attempts().find(a => a.id === attemptId && a.userId === user.id);
    if (!att) return renderNotFound(user);
    if (att.status === 'finished') return go('#/resultado/' + att.id);

    const qs = att.questionsSnapshot;
    let pending = [];

    function draw() {
      const i = att.currentIndex;
      const q = qs[i];
      const saved = att.answers[q.id];
      const locked = !!saved;
      const selected = locked ? saved : pending;
      const answeredCount = qs.filter(x => att.answers[x.id]).length;
      const isLast = i === qs.length - 1;
      const inputType = q.type === 'multiple' ? 'checkbox' : 'radio';

      $app.innerHTML = `
        <div class="exam-shell">
          <div class="page-head">
            <div>
              <p class="eyebrow">Intento ${att.number} de ${MAX_ATTEMPTS}</p>
              <h1>${UI.esc(att.examTitle)}</h1>
            </div>
            <a class="btn btn-ghost btn-sm" href="#/panel">Salir y continuar después</a>
          </div>

          <section class="card">
            <div class="progress-info">
              <span>Pregunta ${i + 1} de ${qs.length}</span>
              <span class="small muted">${answeredCount} de ${qs.length} respondidas</span>
            </div>
            <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${qs.length}" aria-valuenow="${answeredCount}">
              <span style="width:${(answeredCount / qs.length) * 100}%"></span>
            </div>
            <nav class="q-nav" aria-label="Ir a pregunta">
              ${qs.map((x, k) => `<button type="button" data-action="goto" data-i="${k}"
                class="${att.answers[x.id] ? 'answered' : ''} ${k === i ? 'current' : ''}"
                aria-label="Pregunta ${k + 1}${att.answers[x.id] ? ' (respondida)' : ''}">${k + 1}</button>`).join('')}
            </nav>

            <form id="qForm">
              <p class="question-text">${UI.esc(q.text)}</p>
              <span class="badge ${q.type === 'multiple' ? 'badge-accent' : 'badge-neutral'}">
                ${q.type === 'multiple' ? 'Selección múltiple · marca todas las correctas' : 'Selección única'}
              </span>
              <fieldset class="options ${locked ? 'locked' : ''}">
                <legend class="hidden">Opciones</legend>
                ${q.options.map(o => `
                  <label class="option ${selected.includes(o.id) ? 'selected' : ''}">
                    <input type="${inputType}" name="opt" value="${o.id}"
                      ${selected.includes(o.id) ? 'checked' : ''} ${locked ? 'disabled' : ''}>
                    <span>${UI.esc(o.text)}</span>
                  </label>`).join('')}
              </fieldset>
              ${locked ? '<p class="lock-note">&#128274; Respuesta confirmada y guardada. No puede modificarse.</p>' : ''}

              <div class="exam-actions">
                <div class="btn-row">
                  <button type="button" class="btn btn-outline" data-action="prev" ${i === 0 ? 'disabled' : ''}>&larr; Anterior</button>
                  ${locked
                    ? (!isLast ? `<button type="button" class="btn btn-primary" data-action="next">Siguiente &rarr;</button>` : '')
                    : `<button type="submit" class="btn btn-primary" id="confirmBtn" ${pending.length ? '' : 'disabled'}>Confirmar respuesta</button>`}
                </div>
                <button type="button" class="btn ${answeredCount === qs.length ? 'btn-accent' : 'btn-outline'}" data-action="finish">Finalizar examen</button>
              </div>
            </form>
          </section>
        </div>`;

      const form = document.getElementById('qForm');
      form.addEventListener('change', () => {
        if (locked) return;
        pending = Array.from(form.querySelectorAll('input[name=opt]:checked')).map(x => x.value);
        form.querySelectorAll('.option').forEach(l => l.classList.toggle('selected', l.querySelector('input').checked));
        document.getElementById('confirmBtn').disabled = !pending.length;
      });
      form.addEventListener('submit', async e => {
        e.preventDefault();
        if (locked || !pending.length) return;
        const saved = await UI.run(document.getElementById('confirmBtn'), () => Api.saveAnswer(att.id, q.id, pending));
        if (!saved) return;
        att = saved;
        pending = [];
        UI.toast('Respuesta guardada', 'success');
        // Avanza automáticamente a la siguiente pregunta sin responder
        const nextIdx = qs.findIndex((x, k) => k > i && !att.answers[x.id]);
        if (nextIdx !== -1) setIndex(nextIdx);
        else draw();
      });
    }

    /** Cambia de pregunta al instante y guarda la posición en segundo plano. */
    function setIndex(i) {
      pending = [];
      att.currentIndex = i;
      draw();
      Api.setAttemptIndex(att.id, i).catch(ex => UI.toast(ex.message, 'error'));
    }

    actions.prev = () => { if (att.currentIndex > 0) setIndex(att.currentIndex - 1); };
    actions.next = () => { if (att.currentIndex < qs.length - 1) setIndex(att.currentIndex + 1); };
    actions.goto = el => setIndex(Number(el.dataset.i));
    actions.finish = async el => {
      const missing = qs.filter(x => !att.answers[x.id]).length;
      const msg = missing
        ? `Tienes <strong>${missing} pregunta(s) sin responder</strong>; se calificarán como incorrectas.<br><br>¿Deseas finalizar el examen?`
        : '¿Deseas finalizar y enviar el examen? No podrás modificar tus respuestas.';
      const ok = await UI.confirm(msg, { title: 'Finalizar examen', okLabel: 'Finalizar', danger: missing > 0 });
      if (!ok) return;
      const result = await UI.run(el, () => Api.finishAttempt(att.id));
      if (!result) return;
      const { attempt, certificate } = result;
      if (certificate && certificate.attemptId === attempt.id) UI.toast('¡Felicitaciones! Obtuviste tu certificado', 'success');
      go('#/resultado/' + attempt.id);
    };

    draw();
  }

  /* =======================================================
     Resultados de un intento
     ======================================================= */
  function viewResult(user, attemptId) {
    const att = Store.attempts().find(a => a.id === attemptId);
    if (!att || (user.role !== 'admin' && att.userId !== user.id)) return renderNotFound(user);
    if (att.status !== 'finished') return go('#/intento/' + att.id);

    const owner = Store.users().find(u => u.id === att.userId);
    const cert = Domain.certFor(att.userId, att.examId);
    const used = Domain.attemptsFor(att.userId, att.examId).length;
    const reveal = user.role === 'admin' || used >= MAX_ATTEMPTS || !!cert;
    const passed = att.percentage >= PASS_PERCENT;
    const back = user.role === 'admin' ? '#/admin/resultados/' + att.userId : '#/resultados';

    $app.innerHTML = `
      <div class="page-head">
        <div>
          <p class="eyebrow">Resultado · Intento ${att.number} de ${MAX_ATTEMPTS}</p>
          <h1>${UI.esc(att.examTitle)}</h1>
          ${user.role === 'admin' ? `<p class="muted">Estudiante: ${UI.esc(owner ? owner.name : 'Usuario eliminado')}</p>` : ''}
          ${att.manual ? '<p class="small muted">Registrado por un administrador (evaluación presentada por otro medio).</p>'
            : att.editedAt ? `<p class="small muted">Respuestas editadas por un administrador el ${UI.fmtDateTime(att.editedAt)}.</p>` : ''}
        </div>
        <div class="btn-row">
          ${user.role === 'admin' ? `<a class="btn btn-primary btn-sm" href="#/admin/intento/${att.id}">Editar respuestas</a>` : ''}
          <a class="btn btn-outline btn-sm" href="${back}">&larr; Volver</a>
        </div>
      </div>

      <section class="card result-hero">
        <div class="score-ring" style="--p:${att.percentage};--ring:${passed ? 'var(--success)' : 'var(--accent)'}">
          <div><div><strong>${att.percentage}%</strong><span>obtenido</span></div></div>
        </div>
        <div>
          ${passed
            ? `<div class="alert alert-success"><strong>¡Aprobado con certificación!</strong> Superaste el ${PASS_PERCENT}% requerido.</div>`
            : `<div class="alert alert-warning">Necesitas ${PASS_PERCENT}% o más para certificarte.
               ${user.role !== 'admin' ? (used < MAX_ATTEMPTS ? `Te quedan ${MAX_ATTEMPTS - used} intento(s).` : 'Ya no tienes intentos disponibles.') : ''}</div>`}
          <div class="stats-row">
            <div class="stat"><b style="color:var(--success)">${att.correctCount}</b><span>Correctas</span></div>
            <div class="stat"><b style="color:var(--danger)">${att.total - att.correctCount}</b><span>Incorrectas</span></div>
            <div class="stat"><b>#${att.number}</b><span>Número de intento</span></div>
            <div class="stat"><b style="font-size:1rem">${UI.fmtDateTime(att.finishedAt)}</b><span>Fecha y hora</span></div>
          </div>
          <div class="btn-row" style="margin-top:16px">
            ${cert ? `<a class="btn btn-accent" href="#/certificado/${cert.id}">Ver certificado</a>` : ''}
            ${user.role !== 'admin' ? '<a class="btn btn-outline" href="#/panel">Ir a mis exámenes</a>' : ''}
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-title"><h2>Detalle por pregunta</h2></div>
        ${!reveal ? '<p class="alert alert-info">Las respuestas correctas se mostrarán cuando obtengas tu certificado o agotes tus intentos.</p>' : ''}
        <div class="card">
          ${att.questionsSnapshot.map((q, k) => {
            const sel = att.answers[q.id] || [];
            const ok = Domain.isCorrect(q, sel);
            return `
              <div class="review-item ${ok ? '' : 'wrong'}">
                <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
                  <strong>${k + 1}. ${UI.esc(q.text)}</strong>
                  ${ok ? '<span class="badge badge-success">Correcta</span>' : `<span class="badge badge-danger">${sel.length ? 'Incorrecta' : 'Sin responder'}</span>`}
                </div>
                <ul>
                  ${q.options.map(o => {
                    const chosen = sel.includes(o.id);
                    const isC = (q.correct || []).includes(o.id); // sin `correct` si aún no se revela
                    let cls = '', tag = '';
                    if (reveal && isC) { cls = 'is-correct'; tag = ' ✓'; }
                    if (chosen && (!isC || !reveal)) { cls = reveal ? 'is-chosen-wrong' : ''; }
                    if (chosen) tag += ' <em>(tu respuesta)</em>';
                    if (!chosen && !(reveal && isC)) return '';
                    return `<li class="${cls}">${UI.esc(o.text)}${tag}</li>`;
                  }).join('') || '<li class="muted">Sin respuesta</li>'}
                </ul>
              </div>`;
          }).join('')}
        </div>
      </section>`;
  }

  /* =======================================================
     Certificado
     ======================================================= */
  function viewCertificate(user, certId, printFlag) {
    const c = Store.certificates().find(x => x.id === certId);
    if (!c || (user.role !== 'admin' && c.userId !== user.id)) return renderNotFound(user);
    const owner = Store.users().find(u => u.id === c.userId);
    const back = user.role === 'admin' ? '#/admin/certificados/' + c.userId : '#/certificados';

    $app.innerHTML = `
      <div class="cert-actions">
        <a class="btn btn-outline" href="${back}">&larr; Volver</a>
        <button class="btn btn-accent" data-action="print">Imprimir / Guardar como PDF</button>
      </div>
      <article class="certificate" aria-label="Certificado">
        <div class="cert-top">
          <img src="assets/logo.png" alt="Grupo HDI">
          <div class="cert-code">Código de verificación<br><strong>${UI.esc(c.code)}</strong></div>
        </div>
        <div class="cert-body">
          <p class="cert-title">Certificado</p>
          <p class="cert-sub">de aprobación</p>
          <p class="cert-text">Grupo HDI certifica que</p>
          <p><span class="cert-name">${UI.esc(owner ? owner.name : c.userName)}</span></p>
          <p class="cert-text">aprobó satisfactoriamente el examen</p>
          <p class="cert-exam">${UI.esc(c.examTitle)}</p>
          <p class="cert-text">con un puntaje de <strong>${c.percentage}%</strong></p>
        </div>
        <div class="cert-foot">
          <div><b>${UI.fmtDate(c.issuedAt)}</b>Fecha de emisión</div>
          <div><b>Jennifer Catalina Duque Jaramillo</b>Gerente de Proyectos</div>
        </div>
      </article>`;

    actions.print = () => window.print();
    if (printFlag) setTimeout(() => window.print(), 400);
  }

  /* =======================================================
     Administración — navegación y métricas compartidas
     ======================================================= */
  const ADMIN_TABS = [
    ['#/admin', 'Dashboard'], ['#/admin/examenes', 'Exámenes'], ['#/admin/usuarios', 'Usuarios'],
    ['#/admin/resultados', 'Resultados y Certificados']
  ];

  function adminTabs(active) {
    return `<nav class="tabs" aria-label="Secciones de administración">${ADMIN_TABS.map(([h, l]) =>
      `<a href="${h}" class="${h === active ? 'active' : ''}">${l}</a>`).join('')}</nav>`;
  }

  function attemptGrade(a) {
    return a.status === 'finished' ? a.percentage + '%' : 'En curso';
  }

  function attemptDate(a) {
    return UI.fmtDateTime(a.status === 'finished' ? a.finishedAt : a.startedAt);
  }

  /** Resultados de una persona agrupados por módulo (examen), en orden alfabético. */
  function moduleRows(userId) {
    const certs = Store.certificates();
    const examIds = Array.from(new Set(Store.attempts().filter(a => a.userId === userId).map(a => a.examId)));
    return examIds.map(id => Domain.attemptsFor(userId, id))
      .sort((a, b) => a[0].examTitle.localeCompare(b[0].examTitle, 'es'))
      .map(list => {
        const finished = list.filter(a => a.status === 'finished');
        const cert = certs.find(c => c.userId === userId && c.examId === list[0].examId) || null;
        const exhausted = list.length >= MAX_ATTEMPTS && !list.some(a => a.status === 'in_progress');
        return {
          examId: list[0].examId,
          title: list[0].examTitle,
          list,
          count: list.length,
          slots: Array.from({ length: MAX_ATTEMPTS }, (_, i) => list.find(a => a.number === i + 1) || null),
          best: finished.length ? Math.max(...finished.map(a => a.percentage)) : null,
          cert,
          state: cert ? 'passed' : (exhausted ? 'failed' : 'progress'),
          status: cert ? 'Aprobado (certificado)' : (exhausted ? 'No aprobado · sin intentos' : 'En proceso')
        };
      });
  }

  /** Una entrada por persona: estudiantes y cualquier usuario con intentos. */
  function peopleSummary() {
    const atts = Store.attempts();
    const certs = Store.certificates();
    return Store.users()
      .filter(u => u.role === 'student' || atts.some(a => a.userId === u.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
      .map(u => {
        const mine = atts.filter(a => a.userId === u.id);
        const modules = moduleRows(u.id);
        const bests = modules.map(m => m.best).filter(v => v !== null);
        const last = mine.reduce((acc, a) => {
          const d = a.finishedAt || a.startedAt;
          return d > acc ? d : acc;
        }, '');
        return {
          user: u,
          attempts: mine.length,
          modules,
          passed: modules.filter(m => m.cert).length,
          avg: bests.length ? Math.round(bests.reduce((s, v) => s + v, 0) / bests.length) : null,
          certs: certs.filter(c => c.userId === u.id),
          last: last || null
        };
      });
  }

  /**
   * Cumplimiento por módulo: promedio de la mejor calificación de cada persona
   * en el examen (solo intentos finalizados y vigentes).
   */
  function moduleCompliance() {
    const certs = Store.certificates();
    const byExam = new Map();
    Store.attempts().filter(a => a.status === 'finished').forEach(a => {
      if (!byExam.has(a.examId)) byExam.set(a.examId, { examId: a.examId, title: a.examTitle, best: new Map() });
      const g = byExam.get(a.examId);
      g.best.set(a.userId, Math.max(g.best.get(a.userId) || 0, a.percentage));
    });
    return Array.from(byExam.values()).map(g => {
      const exam = Domain.exam(g.examId);
      const values = Array.from(g.best.values());
      return {
        title: exam ? exam.title : g.title,
        people: values.length,
        certified: certs.filter(c => c.examId === g.examId).length,
        pct: Math.round(values.reduce((s, v) => s + v, 0) / values.length)
      };
    }).sort((a, b) => b.pct - a.pct || a.title.localeCompare(b.title, 'es'));
  }

  /* =======================================================
     Administración — dashboard
     ======================================================= */
  function complianceChartHtml(rows) {
    if (!rows.length) return '<div class="card"><p class="empty">Aún no hay evaluaciones finalizadas.</p></div>';
    return `
      <div class="card">
        <ul class="bar-chart" aria-label="Cumplimiento por módulo evaluado">
          ${rows.map(r => {
            const tip = `${r.title}: ${r.pct}% de cumplimiento · ${r.people} persona(s) evaluada(s) · ${r.certified} certificada(s)`;
            return `
              <li class="bar-row" title="${UI.esc(tip)}" aria-label="${UI.esc(tip)}">
                <span class="bar-label">${UI.esc(r.title)}<small>${r.people} persona(s) · ${r.certified} certificada(s)</small></span>
                <span class="bar-track" aria-hidden="true">
                  <span class="bar-fill" style="width:${r.pct}%"></span>
                  <span class="bar-goal" style="left:${PASS_PERCENT}%"></span>
                </span>
                <span class="bar-value" aria-hidden="true">${r.pct}%</span>
              </li>`;
          }).join('')}
        </ul>
        <p class="bar-note small muted"><span class="bar-goal-key" aria-hidden="true"></span>
          Meta de aprobación: ${PASS_PERCENT}%. El cumplimiento es el promedio de la mejor calificación de cada persona en el módulo.</p>
      </div>`;
  }

  function viewAdminDashboard() {
    const users = Store.users();
    const exams = Store.exams();
    const atts = Store.attempts();
    const finished = atts.filter(a => a.status === 'finished');
    const certs = Store.certificates();
    const avg = finished.length ? Math.round(finished.reduce((s, a) => s + a.percentage, 0) / finished.length) : 0;
    const passed = finished.filter(a => a.percentage >= PASS_PERCENT).length;

    const perExam = exams.map(e => {
      const f = finished.filter(a => a.examId === e.id);
      return {
        e,
        count: atts.filter(a => a.examId === e.id).length,
        avg: f.length ? Math.round(f.reduce((s, a) => s + a.percentage, 0) / f.length) : null,
        certs: certs.filter(c => c.examId === e.id).length
      };
    });

    $app.innerHTML = `
      <div class="page-head">
        <div><p class="eyebrow">Panel administrativo</p><h1>Dashboard</h1>
        <p class="muted">Resumen general de la plataforma.</p></div>
      </div>
      ${adminTabs('#/admin')}
      <div class="grid grid-kpi">
        <div class="card kpi"><div class="kpi-value">${users.length}</div><div class="kpi-label">Usuarios registrados<br><span class="small">${users.filter(u => u.role === 'student').length} estudiantes</span></div></div>
        <div class="card kpi accent"><div class="kpi-value">${exams.length}</div><div class="kpi-label">Exámenes creados<br><span class="small">${exams.filter(e => e.published).length} publicados</span></div></div>
        <div class="card kpi"><div class="kpi-value">${atts.length}</div><div class="kpi-label">Intentos realizados<br><span class="small">${finished.length} finalizados</span></div></div>
        <div class="card kpi accent"><div class="kpi-value">${avg}%</div><div class="kpi-label">Promedio de resultados<br><span class="small">${passed} aprobados (≥${PASS_PERCENT}%)</span></div></div>
        <div class="card kpi"><div class="kpi-value">${certs.length}</div><div class="kpi-label">Certificados emitidos</div></div>
      </div>

      <section class="section">
        <div class="section-title"><h2>Cumplimiento por módulo evaluado</h2></div>
        ${complianceChartHtml(moduleCompliance())}
      </section>

      <section class="section">
        <div class="section-title"><h2>Rendimiento por examen</h2></div>
        <div class="table-wrap">
          <table class="table-responsive">
            <thead><tr><th>Examen</th><th>Estado</th><th>Preguntas</th><th>Intentos</th><th>Promedio</th><th>Certificados</th></tr></thead>
            <tbody>${perExam.length ? perExam.map(p => `<tr>
              <td data-label="Examen">${UI.esc(p.e.title)}</td>
              <td data-label="Estado">${p.e.published ? '<span class="badge badge-success">Publicado</span>' : '<span class="badge badge-neutral">Inactivo</span>'}</td>
              <td data-label="Preguntas">${p.e.questions.length}</td>
              <td data-label="Intentos">${p.count}</td>
              <td data-label="Promedio">${p.avg === null ? '—' : p.avg + '%'}</td>
              <td data-label="Certificados">${p.certs}</td></tr>`).join('')
              : '<tr><td colspan="6" class="empty">No hay exámenes.</td></tr>'}</tbody>
          </table>
        </div>
      </section>`;
  }

  /* =======================================================
     Administración — resultados y certificados
     ======================================================= */
  function stateBadge(m) {
    if (m.state === 'passed') return '<span class="badge badge-success">Aprobado</span>';
    if (m.state === 'failed') return '<span class="badge badge-danger">No aprobado</span>';
    return '<span class="badge badge-accent">En proceso</span>';
  }

  /** Quita tildes y mayúsculas para buscar */
  function fold(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function viewAdminResults() {
    const people = peopleSummary();

    $app.innerHTML = `
      <div class="page-head">
        <div><p class="eyebrow">Panel administrativo</p><h1>Resultados y Certificados</h1>
        <p class="muted">Consulta los resultados y certificados de cada persona evaluada.</p></div>
        <div class="btn-row">
          <button type="button" class="btn btn-accent" data-action="xlsx">Descargar Excel</button>
          <button type="button" class="btn btn-outline" data-action="pdf">Descargar PDF</button>
        </div>
      </div>
      ${adminTabs('#/admin/resultados')}
      <div class="toolbar">
        <input class="input" id="pSearch" type="search" placeholder="Buscar por nombre o correo" aria-label="Buscar persona">
        <select class="input" id="pFilter" aria-label="Personas a mostrar">
          <option value="evaluated">Personas evaluadas</option>
          <option value="all">Todas las personas</option>
          <option value="none">Sin evaluaciones</option>
        </select>
      </div>
      <div id="pTable"></div>
      <p class="small muted">El Excel trae tres hojas: resumen por persona, resultados por módulo y detalle de respuestas.</p>`;

    const draw = () => {
      const q = fold(document.getElementById('pSearch').value.trim());
      const f = document.getElementById('pFilter').value;
      const list = people.filter(p =>
        (f === 'all' || (f === 'evaluated' ? p.attempts > 0 : p.attempts === 0)) &&
        (!q || fold(p.user.name).includes(q) || fold(p.user.email).includes(q)));

      document.getElementById('pTable').innerHTML = `
        <div class="table-wrap">
          <table class="table-responsive">
            <thead><tr><th>Nombre</th><th>Correo</th><th>Módulos evaluados</th><th>Intentos</th><th>Promedio</th><th>Certificados</th><th>Acciones</th></tr></thead>
            <tbody>${list.length ? list.map(p => `<tr>
              <td data-label="Nombre"><strong>${UI.esc(p.user.name)}</strong></td>
              <td data-label="Correo">${UI.esc(p.user.email)}</td>
              <td data-label="Módulos evaluados"><span>${p.modules.length}${p.modules.length ? ` <span class="small muted">(${p.passed} aprobado${p.passed === 1 ? '' : 's'})</span>` : ''}</span></td>
              <td data-label="Intentos">${p.attempts}</td>
              <td data-label="Promedio">${p.avg === null ? '—' : UI.badgeForPercent(p.avg)}</td>
              <td data-label="Certificados">${p.certs.length}</td>
              <td data-label="Acciones"><div class="btn-row">
                ${p.attempts
                  ? `<a class="btn btn-primary btn-sm" href="#/admin/resultados/${p.user.id}">Ver resultados</a>`
                  : '<button type="button" class="btn btn-primary btn-sm" disabled title="Sin evaluaciones">Ver resultados</button>'}
                <a class="btn btn-outline btn-sm" href="#/admin/certificados/${p.user.id}">Ver certificados</a>
              </div></td></tr>`).join('')
              : '<tr><td colspan="7" class="empty">No hay personas que coincidan.</td></tr>'}</tbody>
          </table>
        </div>`;
    };
    document.getElementById('pSearch').addEventListener('input', draw);
    document.getElementById('pFilter').addEventListener('change', draw);
    draw();

    actions.xlsx = el => UI.run(el, () => downloadResultsXlsx(null, `resultados-y-certificados-${today()}.xlsx`));
    actions.pdf = el => UI.run(el, () => downloadGradesPdf(`reporte-calificaciones-${today()}.pdf`));
  }

  function moduleTableHtml(modules) {
    if (!modules.length) return '<div class="table-wrap"><p class="empty">Esta persona aún no tiene evaluaciones.</p></div>';
    return `
      <div class="table-wrap">
        <table class="table-responsive">
          <thead><tr><th>Módulo</th><th>Intentos</th>
            ${Array.from({ length: MAX_ATTEMPTS }, (_, i) => `<th>Intento ${i + 1}</th>`).join('')}
            <th>Mejor</th><th>Estado</th><th>Certificado</th></tr></thead>
          <tbody>${modules.map(m => `<tr>
            <td data-label="Módulo"><strong>${UI.esc(m.title)}</strong></td>
            <td data-label="Intentos">${m.count}/${MAX_ATTEMPTS}</td>
            ${m.slots.map((a, i) => `<td data-label="Intento ${i + 1}">${!a ? '—'
              : a.status === 'finished'
                ? `<span><a href="#/resultado/${a.id}" title="Ver detalle">${UI.badgeForPercent(a.percentage)}</a>${a.manual ? ' <span class="small muted">manual</span>' : ''}</span>`
                : '<span class="badge badge-accent">En curso</span>'}</td>`).join('')}
            <td data-label="Mejor">${m.best === null ? '—' : `<strong>${m.best}%</strong>`}</td>
            <td data-label="Estado">${stateBadge(m)}</td>
            <td data-label="Certificado">${m.cert ? `<a class="btn btn-outline btn-sm" href="#/certificado/${m.cert.id}">${UI.esc(m.cert.code)}</a>` : '—'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`;
  }

  function viewAdminPersonResults(me, userId) {
    const u = Store.users().find(x => x.id === userId);
    if (!u) return renderNotFound(me);
    const modules = moduleRows(userId);
    const atts = Store.attempts().filter(a => a.userId === userId)
      .sort((a, b) => (b.finishedAt || b.startedAt).localeCompare(a.finishedAt || a.startedAt));
    const certCount = Store.certificates().filter(c => c.userId === userId).length;

    $app.innerHTML = `
      <div class="page-head">
        <div><p class="eyebrow">Resultados y Certificados · Resultados</p><h1>${UI.esc(u.name)}</h1>
        <p class="muted">${UI.esc(u.email)}</p></div>
        <div class="btn-row">
          <a class="btn btn-outline btn-sm" href="#/admin/certificados/${u.id}">Ver certificados (${certCount})</a>
          <button type="button" class="btn btn-accent btn-sm" data-action="xlsx" ${atts.length ? '' : 'disabled'}>Descargar Excel</button>
          <a class="btn btn-outline btn-sm" href="#/admin/resultados">&larr; Volver</a>
        </div>
      </div>
      ${adminTabs('#/admin/resultados')}
      <section class="section">
        <div class="section-title"><h2>Resultados por módulo</h2></div>
        ${moduleTableHtml(modules)}
      </section>
      <section class="section">
        <div class="section-title"><h2>Historial de intentos</h2></div>
        ${historyTableHtml(atts, { admin: true })}
      </section>`;

    actions.xlsx = el => UI.run(el, () => downloadResultsXlsx(userId, `resultados-${slug(u.name)}-${today()}.xlsx`));
  }

  function viewAdminPersonCerts(me, userId) {
    const u = Store.users().find(x => x.id === userId);
    if (!u) return renderNotFound(me);
    const certs = Store.certificates().filter(c => c.userId === userId);
    const hasAttempts = Store.attempts().some(a => a.userId === userId);

    $app.innerHTML = `
      <div class="page-head">
        <div><p class="eyebrow">Resultados y Certificados · Certificados</p><h1>${UI.esc(u.name)}</h1>
        <p class="muted">${UI.esc(u.email)}</p></div>
        <div class="btn-row">
          ${hasAttempts ? `<a class="btn btn-outline btn-sm" href="#/admin/resultados/${u.id}">Ver resultados</a>` : ''}
          <a class="btn btn-outline btn-sm" href="#/admin/resultados">&larr; Volver</a>
        </div>
      </div>
      ${adminTabs('#/admin/resultados')}
      ${certListHtml(certs, 'Esta persona aún no tiene certificados.')}`;
  }

  /* =======================================================
     Exportación: Excel (.xlsx) y PDF. Las librerías se cargan
     desde el CDN solo cuando se usan.
     ======================================================= */
  const XLSX_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  const JSPDF_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  const AUTOTABLE_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js';

  function slug(s) {
    return fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'archivo';
  }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const loadedScripts = {};
  function loadScript(src) {
    if (!loadedScripts[src]) {
      loadedScripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { delete loadedScripts[src]; s.remove(); reject(new Error('No se pudo preparar la descarga. Revisa tu conexión.')); };
        document.head.appendChild(s);
      });
    }
    return loadedScripts[src];
  }

  /** Hoja con anchos de columna y autofiltro. pctCols: columnas con 0–100 que se guardan como porcentaje. */
  function xlsxSheet(rows, widths, pctCols = []) {
    const X = window.XLSX;
    const ws = X.utils.aoa_to_sheet(rows);
    const range = X.utils.decode_range(ws['!ref']);
    for (let r = 1; r <= range.e.r; r++) {
      pctCols.forEach(c => {
        const cell = ws[X.utils.encode_cell({ r, c })];
        if (cell && cell.t === 'n') { cell.v /= 100; cell.z = '0%'; }
      });
    }
    ws['!cols'] = widths.map(wch => ({ wch }));
    ws['!autofilter'] = { ref: ws['!ref'] };
    return ws;
  }

  function summarySheetRows(people) {
    const rows = [['Nombre', 'Correo', 'Módulos evaluados', 'Módulos aprobados', 'Intentos realizados',
      'Promedio (mejor calificación por módulo)', 'Certificados', 'Códigos de certificado', 'Último intento']];
    people.forEach(p => rows.push([
      p.user.name, p.user.email, p.modules.length, p.passed, p.attempts,
      p.avg === null ? '' : p.avg, p.certs.length, p.certs.map(c => c.code).join(', '),
      p.last ? UI.fmtDateTime(p.last) : 'Sin evaluaciones'
    ]));
    return rows;
  }

  function moduleSheetRows(people) {
    const rows = [[
      'Nombre', 'Correo', 'Módulo', 'Intentos realizados',
      ...Array.from({ length: MAX_ATTEMPTS }, (_, i) => [`Calificación intento ${i + 1}`, `Fecha intento ${i + 1}`]).flat(),
      'Mejor calificación', 'Estado', 'Código certificado', 'Observaciones'
    ]];
    people.forEach(p => {
      if (!p.modules.length) {
        rows.push([p.user.name, p.user.email, 'Sin evaluaciones', 0, ...Array(MAX_ATTEMPTS * 2).fill(''), '', '', '', '']);
        return;
      }
      p.modules.forEach(m => rows.push([
        p.user.name, p.user.email, m.title, m.count,
        ...m.slots.flatMap(a => a ? [a.status === 'finished' ? a.percentage : 'En curso', attemptDate(a)] : ['', '']),
        m.best === null ? '' : m.best, m.status, m.cert ? m.cert.code : '',
        m.list.filter(a => a.manual || a.editedAt)
          .map(a => `Intento ${a.number} ${a.manual ? 'registrado' : 'editado'} por administrador`).join('; ')
      ]));
    });
    return rows;
  }

  /** Una fila por pregunta de cada intento, con el resumen del intento repetido para filtrar. */
  function answerSheetRows(atts) {
    const users = Store.users();
    const certs = Store.certificates();
    const userName = id => (users.find(u => u.id === id) || {}).name || '';
    const optText = (q, ids) => (ids || []).map(id => (q.options.find(o => o.id === id) || {}).text || id).join(' | ');
    const rows = [[
      'Nombre', 'Correo', 'Módulo', 'Intento', 'Estado', 'Origen', 'Fecha inicio', 'Fecha finalización',
      'Correctas', 'Total preguntas', 'Calificación', 'Certificado', 'N° pregunta', 'Pregunta', 'Tipo',
      'Respuesta de la persona', 'Respuesta correcta', 'Resultado'
    ]];
    atts.slice()
      .sort((a, b) => userName(a.userId).localeCompare(userName(b.userId), 'es') ||
        a.examTitle.localeCompare(b.examTitle, 'es') || a.number - b.number)
      .forEach(a => {
        const u = users.find(x => x.id === a.userId);
        const done = a.status === 'finished';
        const cert = certs.find(c => c.attemptId === a.id);
        const head = [
          u ? u.name : 'Usuario eliminado', u ? u.email : '', a.examTitle, a.number,
          done ? 'Finalizado' : 'En curso',
          a.manual ? 'Registrado por administrador' : (a.editedAt ? 'Plataforma (editado)' : 'Plataforma'),
          UI.fmtDateTime(a.startedAt), done ? UI.fmtDateTime(a.finishedAt) : '',
          done ? a.correctCount : '', a.total, done ? a.percentage : '', cert ? cert.code : ''
        ];
        a.questionsSnapshot.forEach((q, k) => {
          const sel = a.answers[q.id] || [];
          rows.push(head.concat([
            k + 1, q.text, q.type === 'multiple' ? 'Selección múltiple' : 'Selección única',
            sel.length ? optText(q, sel) : 'Sin responder', optText(q, q.correct),
            !done && !sel.length ? '' : (Domain.isCorrect(q, sel) ? 'Correcta' : 'Incorrecta')
          ]));
        });
      });
    return rows;
  }

  /** Libro de Excel con resumen por persona, resultados por módulo y detalle. userId = null → todas. */
  async function downloadResultsXlsx(userId, filename) {
    await loadScript(XLSX_SRC);
    const X = window.XLSX;
    const people = peopleSummary().filter(p => !userId || p.user.id === userId);
    const atts = Store.attempts().filter(a => !userId || a.userId === userId);
    const attemptPct = Array.from({ length: MAX_ATTEMPTS }, (_, i) => 4 + i * 2);

    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, xlsxSheet(summarySheetRows(people), [30, 32, 12, 12, 12, 16, 12, 28, 22], [5]),
      'Resumen por persona');
    X.utils.book_append_sheet(wb, xlsxSheet(moduleSheetRows(people),
      [30, 32, 32, 12, ...attemptPct.flatMap(() => [14, 22]), 14, 26, 18, 40], [...attemptPct, 4 + MAX_ATTEMPTS * 2]),
      'Resultados por módulo');
    X.utils.book_append_sheet(wb, xlsxSheet(answerSheetRows(atts),
      [30, 32, 32, 9, 12, 26, 22, 22, 10, 10, 12, 18, 10, 60, 18, 40, 40, 12], [10]),
      'Detalle de respuestas');
    X.writeFile(wb, filename);
  }

  function imageDataUrl(src) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        resolve({ data: c.toDataURL('image/png'), w: img.naturalWidth, h: img.naturalHeight });
      };
      img.onerror = () => resolve(null); // el reporte sale sin logo
      img.src = src;
    });
  }

  async function downloadGradesPdf(filename) {
    await loadScript(JSPDF_SRC);
    await loadScript(AUTOTABLE_SRC);
    const logo = await imageDataUrl('assets/logo.png');
    const people = peopleSummary();
    const BRAND = [15, 43, 51], ACCENT = [255, 130, 0], MUTED = [100, 116, 122];
    // Las fuentes estándar de PDF no tienen los espacios finos que usa toLocaleString ("9:10 a. m.")
    const txt = s => String(s).replace(/[   ]/g, ' ');

    const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const M = 36;

    // Encabezado (solo en la primera página)
    let y = M;
    if (logo) {
      const h = 34, w = h * logo.w / logo.h;
      doc.addImage(logo.data, 'PNG', M, y, w, h);
    }
    doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(...BRAND);
    doc.text('Reporte de calificaciones', pageW - M, y + 14, { align: 'right' });
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...MUTED);
    doc.text(txt('Campus HDI · Generado el ' + UI.fmtDateTime(new Date().toISOString())), pageW - M, y + 30, { align: 'right' });
    y += 46;
    doc.setFillColor(...BRAND).rect(M, y, (pageW - 2 * M) * 0.7, 3, 'F');
    doc.setFillColor(...ACCENT).rect(M + (pageW - 2 * M) * 0.7, y, (pageW - 2 * M) * 0.3, 3, 'F');
    y += 16;

    doc.setFontSize(9.5).setTextColor(...BRAND);
    doc.text(`${people.length} persona(s) · ${people.filter(p => p.attempts).length} evaluada(s) · ` +
      `${people.reduce((s, p) => s + p.attempts, 0)} intento(s) · ${people.reduce((s, p) => s + p.passed, 0)} certificado(s)`, M, y);
    y += 10;

    const body = [];
    people.forEach(p => {
      const who = p.user.name + '\n' + p.user.email;
      if (!p.modules.length) {
        body.push([who, 'Sin evaluaciones', '0', ...Array(MAX_ATTEMPTS).fill('—'), '—', '—', '—']);
        return;
      }
      p.modules.forEach(m => body.push([
        who, m.title, String(m.count),
        ...m.slots.map(a => a ? attemptGrade(a) + (a.manual ? ' (manual)' : '') + '\n' + attemptDate(a) : '—'),
        m.best === null ? '—' : m.best + '%', m.status, m.cert ? m.cert.code : '—'
      ]));
    });

    const STATUS_COL = 4 + MAX_ATTEMPTS;
    doc.autoTable({
      startY: y,
      margin: { left: M, right: M, bottom: M + 10 },
      head: [['Persona', 'Módulo', 'Intentos',
        ...Array.from({ length: MAX_ATTEMPTS }, (_, i) => `Intento ${i + 1}`), 'Mejor', 'Estado', 'Certificado']],
      body: (body.length ? body : [['No hay personas registradas.', '', '', ...Array(MAX_ATTEMPTS).fill(''), '', '', '']])
        .map(r => r.map(txt)),
      theme: 'grid',
      rowPageBreak: 'avoid',
      styles: { font: 'helvetica', fontSize: 8, cellPadding: 4, textColor: [30, 41, 46], lineColor: [220, 228, 230], lineWidth: 0.5, valign: 'middle' },
      headStyles: { fillColor: BRAND, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [241, 246, 247] },
      columnStyles: {
        0: { cellWidth: 150 }, 1: { cellWidth: 110 }, 2: { halign: 'center', cellWidth: 46 },
        [3 + MAX_ATTEMPTS]: { halign: 'center', fontStyle: 'bold' }
      },
      didParseCell(d) {
        if (d.section !== 'body' || d.column.index !== STATUS_COL) return;
        const status = String(d.row.raw[STATUS_COL]);
        if (status.startsWith('Aprobado')) d.cell.styles.textColor = [22, 128, 61];
        if (status.startsWith('No aprobado')) d.cell.styles.textColor = [185, 28, 28];
      },
      didDrawPage() {
        doc.setFontSize(8).setTextColor(...MUTED);
        doc.text('Grupo HDI · Campus de formación', M, pageH - M + 12);
        doc.text('Página ' + doc.internal.getNumberOfPages(), pageW - M, pageH - M + 12, { align: 'right' });
      }
    });

    doc.save(filename);
  }

  /* =======================================================
     Administración — exámenes
     ======================================================= */
  function viewAdminExams() {
    const exams = Store.exams();
    const atts = Store.attempts();

    $app.innerHTML = `
      <div class="page-head">
        <div><p class="eyebrow">Panel administrativo</p><h1>Exámenes</h1>
        <p class="muted">Crea, edita, publica o desactiva exámenes.</p></div>
        <a class="btn btn-accent" href="#/admin/examen/nuevo">+ Nuevo examen</a>
      </div>
      ${adminTabs('#/admin/examenes')}
      <div class="table-wrap">
        <table class="table-responsive">
          <thead><tr><th>Título</th><th>Preguntas</th><th>Estado</th><th>Intentos</th><th>Actualizado</th><th>Acciones</th></tr></thead>
          <tbody>
            ${exams.length ? exams.map(e => `<tr>
              <td data-label="Título"><strong>${UI.esc(e.title)}</strong><br><span class="small muted">${UI.esc(e.description).slice(0, 90)}</span></td>
              <td data-label="Preguntas">${e.questions.length}</td>
              <td data-label="Estado">${e.published ? '<span class="badge badge-success">Publicado</span>' : '<span class="badge badge-neutral">Inactivo</span>'}</td>
              <td data-label="Intentos">${atts.filter(a => a.examId === e.id).length}</td>
              <td data-label="Actualizado">${UI.fmtDate(e.updatedAt)}</td>
              <td data-label="Acciones"><div class="btn-row">
                <a class="btn btn-outline btn-sm" href="#/admin/examen/${e.id}">Editar</a>
                <button class="btn btn-outline btn-sm" data-action="toggle" data-id="${e.id}">${e.published ? 'Desactivar' : 'Publicar'}</button>
                <button class="btn btn-danger btn-sm" data-action="delete" data-id="${e.id}">Eliminar</button>
              </div></td></tr>`).join('')
            : '<tr><td colspan="6" class="empty">No hay exámenes. Crea el primero.</td></tr>'}
          </tbody>
        </table>
      </div>`;

    actions.toggle = async el => {
      const e = Store.exams().find(x => x.id === el.dataset.id);
      if (!e) return;
      if (!e.published && !e.questions.length) return UI.toast('Agrega al menos una pregunta antes de publicar', 'error');
      const saved = await UI.run(el, () => Api.setExamPublished(e.id, !e.published));
      if (!saved) return;
      UI.toast(saved.published ? 'Examen publicado' : 'Examen desactivado', 'success');
      render();
    };
    actions.delete = async el => {
      const e = Store.exams().find(x => x.id === el.dataset.id);
      if (!e) return;
      const ok = await UI.confirm(`¿Eliminar el examen «${UI.esc(e.title)}»? Los intentos y certificados históricos se conservarán.`,
        { title: 'Eliminar examen', okLabel: 'Eliminar', danger: true });
      if (!ok) return;
      if (await UI.run(el, () => Api.deleteExam(e.id).then(() => true))) {
        UI.toast('Examen eliminado', 'success');
        render();
      }
    };
  }

  function blankQuestion() {
    return {
      id: uid('q'), text: '', type: 'single',
      options: [0, 1, 2, 3].map(() => ({ id: uid('o'), text: '' })),
      correct: []
    };
  }

  function viewExamEditor(user, examId) {
    const isNew = examId === 'nuevo';
    const source = isNew ? null : Domain.exam(examId);
    if (!isNew && !source) return renderNotFound(user);

    const draft = source ? JSON.parse(JSON.stringify(source)) : {
      id: uid('exam'), title: '', description: '', published: false, questions: [blankQuestion()]
    };
    const attemptCount = isNew ? 0 : Store.attempts().filter(a => a.examId === draft.id).length;

    $app.innerHTML = `
      <div class="page-head">
        <div><p class="eyebrow">Panel administrativo · Exámenes</p><h1>${isNew ? 'Nuevo examen' : 'Editar examen'}</h1></div>
        <a class="btn btn-outline btn-sm" href="#/admin/examenes">&larr; Volver</a>
      </div>
      ${attemptCount ? `<div class="alert alert-info">Este examen tiene ${attemptCount} intento(s). Los cambios no alteran los resultados ya registrados.</div>` : ''}
      <form class="form" id="examForm" novalidate>
        <section class="card form">
          <div class="field">
            <label for="eTitle">Título</label>
            <input class="input" id="eTitle" maxlength="120" value="${UI.esc(draft.title)}" required>
          </div>
          <div class="field">
            <label for="eDesc">Descripción</label>
            <textarea class="input" id="eDesc" maxlength="500">${UI.esc(draft.description)}</textarea>
          </div>
          <div class="form-row">
            <div class="field">
              <label for="eCount">Número de preguntas</label>
              <input class="input" id="eCount" type="number" min="1" max="100" value="${draft.questions.length}">
              <span class="hint">Ajusta la cantidad o usa “Agregar pregunta”.</span>
            </div>
            <div class="field" style="align-content:center">
              <label class="switch"><input type="checkbox" id="ePub" ${draft.published ? 'checked' : ''}> Publicado (visible para estudiantes)</label>
            </div>
          </div>
        </section>

        <section class="section" style="margin-top:8px">
          <div class="section-title"><h2>Preguntas</h2></div>
          <div id="qList"></div>
          <div class="btn-row" style="margin-top:14px">
            <button type="button" class="btn btn-outline" data-action="addQ">+ Agregar pregunta</button>
          </div>
        </section>

        <div class="btn-row" style="justify-content:flex-end;border-top:1px solid var(--border);padding-top:16px">
          <a class="btn btn-outline" href="#/admin/examenes">Cancelar</a>
          <button type="submit" class="btn btn-primary">Guardar examen</button>
        </div>
      </form>`;

    const $list = document.getElementById('qList');
    const $count = document.getElementById('eCount');

    function questionHtml(q, idx) {
      const t = q.type === 'multiple' ? 'checkbox' : 'radio';
      return `
        <div class="q-editor" data-qid="${q.id}">
          <div class="q-editor-head">
            <h3>Pregunta ${idx + 1}</h3>
            <div class="btn-row">
              <select class="input" data-role="type" style="width:auto" aria-label="Tipo de respuesta">
                <option value="single" ${q.type === 'single' ? 'selected' : ''}>Respuesta única</option>
                <option value="multiple" ${q.type === 'multiple' ? 'selected' : ''}>Selección múltiple</option>
              </select>
              <button type="button" class="btn btn-danger btn-sm" data-action="delQ" data-qid="${q.id}">Eliminar</button>
            </div>
          </div>
          <div class="field">
            <textarea class="input" data-role="text" placeholder="Escribe el enunciado de la pregunta" aria-label="Enunciado de la pregunta ${idx + 1}">${UI.esc(q.text)}</textarea>
          </div>
          <p class="hint" style="margin:10px 0 6px">Opciones — marca ${q.type === 'multiple' ? 'todas las respuestas correctas' : 'la única respuesta correcta'}:</p>
          ${q.options.map((o, k) => `
            <div class="opt-row" data-oid="${o.id}">
              <input type="${t}" name="c_${q.id}" value="${o.id}" ${q.correct.includes(o.id) ? 'checked' : ''} aria-label="Marcar opción ${k + 1} como correcta">
              <input class="input" data-role="opt" value="${UI.esc(o.text)}" placeholder="Opción ${k + 1}">
              <button type="button" class="icon-btn" data-action="delOpt" data-qid="${q.id}" data-oid="${o.id}" aria-label="Quitar opción" ${q.options.length <= 2 ? 'disabled' : ''}>&times;</button>
            </div>`).join('')}
          <button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px" data-action="addOpt" data-qid="${q.id}">+ Agregar opción</button>
        </div>`;
    }

    function drawQuestions() {
      $list.innerHTML = draft.questions.map(questionHtml).join('') ||
        '<div class="card"><p class="empty">Sin preguntas. Agrega al menos una.</p></div>';
      $count.value = draft.questions.length;
    }

    /** Lee el DOM hacia el borrador antes de cualquier cambio estructural. */
    function collect() {
      draft.title = document.getElementById('eTitle').value;
      draft.description = document.getElementById('eDesc').value;
      draft.published = document.getElementById('ePub').checked;
      draft.questions = Array.from($list.querySelectorAll('.q-editor')).map(box => {
        const qid = box.dataset.qid;
        return {
          id: qid,
          text: box.querySelector('[data-role=text]').value,
          type: box.querySelector('[data-role=type]').value,
          options: Array.from(box.querySelectorAll('.opt-row')).map(r => ({ id: r.dataset.oid, text: r.querySelector('[data-role=opt]').value })),
          correct: Array.from(box.querySelectorAll(`input[name="c_${qid}"]:checked`)).map(i => i.value)
        };
      });
    }

    $list.addEventListener('change', e => {
      if (e.target.dataset.role === 'type') {
        collect();
        const q = draft.questions.find(x => x.id === e.target.closest('.q-editor').dataset.qid);
        if (q.type === 'single' && q.correct.length > 1) q.correct = q.correct.slice(0, 1);
        drawQuestions();
      }
    });

    $count.addEventListener('change', async () => {
      collect();
      let n = Math.max(1, Math.min(100, parseInt($count.value, 10) || 1));
      if (n < draft.questions.length) {
        const removed = draft.questions.slice(n);
        const hasContent = removed.some(q => q.text.trim() || q.options.some(o => o.text.trim()));
        if (hasContent && !(await UI.confirm(`Se eliminarán las últimas ${removed.length} pregunta(s) con su contenido. ¿Continuar?`,
          { title: 'Reducir preguntas', okLabel: 'Eliminar', danger: true }))) {
          $count.value = draft.questions.length;
          return;
        }
        draft.questions = draft.questions.slice(0, n);
      } else {
        while (draft.questions.length < n) draft.questions.push(blankQuestion());
      }
      drawQuestions();
    });

    actions.addQ = () => {
      collect();
      draft.questions.push(blankQuestion());
      drawQuestions();
      const last = $list.querySelector('.q-editor:last-child [data-role=text]');
      if (last) last.focus();
    };
    actions.delQ = el => {
      collect();
      draft.questions = draft.questions.filter(q => q.id !== el.dataset.qid);
      drawQuestions();
    };
    actions.addOpt = el => {
      collect();
      const q = draft.questions.find(x => x.id === el.dataset.qid);
      if (q.options.length >= 10) return UI.toast('Máximo 10 opciones por pregunta', 'error');
      q.options.push({ id: uid('o'), text: '' });
      drawQuestions();
    };
    actions.delOpt = el => {
      collect();
      const q = draft.questions.find(x => x.id === el.dataset.qid);
      if (q.options.length <= 2) return;
      q.options = q.options.filter(o => o.id !== el.dataset.oid);
      q.correct = q.correct.filter(c => c !== el.dataset.oid);
      drawQuestions();
    };

    document.getElementById('examForm').addEventListener('submit', async e => {
      e.preventDefault();
      collect();
      const title = draft.title.trim();
      if (!title) return UI.toast('El título es obligatorio', 'error');

      const questions = [];
      for (let i = 0; i < draft.questions.length; i++) {
        const q = draft.questions[i];
        const label = 'Pregunta ' + (i + 1) + ': ';
        const options = q.options.map(o => ({ id: o.id, text: o.text.trim() })).filter(o => o.text);
        const correct = q.correct.filter(c => options.some(o => o.id === c));
        if (!q.text.trim()) return UI.toast(label + 'escribe el enunciado', 'error');
        if (options.length < 2) return UI.toast(label + 'agrega al menos 2 opciones', 'error');
        if (q.type === 'single' && correct.length !== 1) return UI.toast(label + 'marca una única respuesta correcta', 'error');
        if (q.type === 'multiple' && correct.length < 1) return UI.toast(label + 'marca al menos una respuesta correcta', 'error');
        questions.push({ id: q.id, text: q.text.trim(), type: q.type, options, correct });
      }
      if (draft.published && !questions.length) return UI.toast('Agrega al menos una pregunta para publicar', 'error');

      const saved = await UI.run(e.submitter || e.target.querySelector('button[type=submit]'), () => Api.saveExam({
        id: draft.id,
        title,
        description: draft.description.trim(),
        published: draft.published,
        questions
      }));
      if (!saved) return;
      UI.toast('Examen guardado', 'success');
      go('#/admin/examenes');
    });

    drawQuestions();
  }

  /* =======================================================
     Administración — usuarios
     ======================================================= */
  function viewAdminUsers(me) {
    const users = Store.users();
    const atts = Store.attempts();
    const certs = Store.certificates();

    $app.innerHTML = `
      <div class="page-head">
        <div><p class="eyebrow">Panel administrativo</p><h1>Usuarios</h1>
        <p class="muted">Gestiona estudiantes y administradores.</p></div>
        <button class="btn btn-accent" data-action="new">+ Nuevo usuario</button>
      </div>
      ${adminTabs('#/admin/usuarios')}
      <div class="table-wrap">
        <table class="table-responsive">
          <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Intentos</th><th>Certificados</th><th>Registro</th><th>Acciones</th></tr></thead>
          <tbody>
            ${users.map(u => `<tr>
              <td data-label="Nombre"><strong>${UI.esc(u.name)}</strong>${u.id === me.id ? ' <span class="badge badge-accent">Tú</span>' : ''}</td>
              <td data-label="Correo">${UI.esc(u.email)}</td>
              <td data-label="Rol">${u.role === 'admin' ? '<span class="badge badge-accent">Administrador</span>' : '<span class="badge badge-neutral">Estudiante</span>'}</td>
              <td data-label="Intentos">${atts.filter(a => a.userId === u.id).length}</td>
              <td data-label="Certificados">${certs.filter(c => c.userId === u.id).length}</td>
              <td data-label="Registro">${UI.fmtDate(u.createdAt)}</td>
              <td data-label="Acciones"><div class="btn-row">
                <button class="btn btn-outline btn-sm" data-action="edit" data-id="${u.id}">Editar</button>
                ${u.role === 'student' ? `<button class="btn btn-outline btn-sm" data-action="recordAttempt" data-id="${u.id}">Registrar evaluación</button>` : ''}
                ${atts.some(a => a.userId === u.id) ? `<button class="btn btn-outline btn-sm" data-action="resetAttempts" data-id="${u.id}">Reiniciar intentos</button>` : ''}
                <button class="btn btn-danger btn-sm" data-action="delete" data-id="${u.id}" ${u.id === me.id ? 'disabled title="No puedes eliminar tu propia cuenta"' : ''}>Eliminar</button>
              </div></td></tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    function userForm(u) {
      const self = u && u.id === me.id;
      return `
        <div class="form">
          <div class="field"><label for="uName">Nombre completo</label>
            <input class="input" id="uName" name="uname" value="${UI.esc(u ? u.name : '')}"></div>
          <div class="field"><label for="uEmail">Correo</label>
            <input class="input" id="uEmail" name="uemail" type="email" value="${UI.esc(u ? u.email : '')}"></div>
          <div class="form-row">
            <div class="field"><label for="uRole">Rol</label>
              <select class="input" id="uRole" name="urole" ${self ? 'disabled' : ''}>
                <option value="student" ${!u || u.role === 'student' ? 'selected' : ''}>Estudiante</option>
                <option value="admin" ${u && u.role === 'admin' ? 'selected' : ''}>Administrador</option>
              </select></div>
            <div class="field"><label for="uPass">Contraseña</label>
              <input class="input" id="uPass" name="upass" type="password" autocomplete="new-password"
                placeholder="${u ? 'Dejar vacío para no cambiar' : `Mínimo ${MIN_PASSWORD_LENGTH} caracteres`}"></div>
          </div>
          <p class="form-error" id="uErr" role="alert"></p>
        </div>`;
    }

    function openForm(u) {
      UI.modal({
        title: u ? 'Editar usuario' : 'Nuevo usuario',
        body: userForm(u),
        buttons: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Guardar', value: 'save', cls: 'btn-primary' }],
        async onSubmit(val, form) {
          const err = form.querySelector('#uErr');
          const name = form.uname.value.trim();
          const email = form.uemail.value.trim().toLowerCase();
          const role = u && u.id === me.id ? u.role : form.urole.value;
          const pass = form.upass.value;
          const all = Store.users();
          if (name.length < 3) { err.textContent = 'Ingresa un nombre válido.'; return false; }
          if (!UI.emailOk(email)) { err.textContent = 'Ingresa un correo válido.'; return false; }
          if (all.some(x => x.email.toLowerCase() === email && (!u || x.id !== u.id))) { err.textContent = 'Ese correo ya está registrado.'; return false; }
          if ((!u || pass) && pass.length < MIN_PASSWORD_LENGTH) { err.textContent = `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`; return false; }
          if (u && u.role === 'admin' && role !== 'admin' && all.filter(x => x.role === 'admin').length <= 1) {
            err.textContent = 'Debe existir al menos un administrador.'; return false;
          }

          // El servidor repite estas validaciones y sincroniza el nombre en los certificados.
          err.textContent = '';
          try {
            await Api.saveUser({ id: u ? u.id : null, name, email, role, password: pass });
          } catch (ex) {
            err.textContent = ex.message;
            return false;
          }
          return true;
        }
      }).then(v => {
        if (v === 'save') { UI.toast(u ? 'Usuario actualizado' : 'Usuario creado', 'success'); render(); }
      });
    }

    /** Reinicia (anula) los intentos de un usuario en un examen elegido. */
    actions.resetAttempts = el => {
      const u = users.find(x => x.id === el.dataset.id);
      if (!u) return;
      const byExam = [];
      atts.filter(a => a.userId === u.id).forEach(a => {
        let g = byExam.find(x => x.examId === a.examId);
        if (!g) byExam.push(g = { examId: a.examId, title: a.examTitle, count: 0, inProgress: false });
        g.count++;
        if (a.status === 'in_progress') g.inProgress = true;
      });
      if (!byExam.length) return;
      const hasCert = examId => certs.some(c => c.userId === u.id && c.examId === examId);

      UI.modal({
        title: 'Reiniciar intentos',
        body: `
          <div class="form">
            <p style="margin:0">Estudiante: <strong>${UI.esc(u.name)}</strong></p>
            <div class="field"><label for="rExam">Examen</label>
              <select class="input" id="rExam" name="rexam">
                ${byExam.map(g => `<option value="${UI.esc(g.examId)}">${UI.esc(g.title)} — ${g.count}/${MAX_ATTEMPTS} intentos${g.inProgress ? ' (uno en curso)' : ''}${hasCert(g.examId) ? ' · certificado' : ''}</option>`).join('')}
              </select></div>
            <p class="small muted" style="margin:0">El estudiante volverá a tener ${MAX_ATTEMPTS} intentos disponibles. Los intentos anteriores se conservan en el historial de la base de datos, pero dejarán de mostrarse; un intento en curso se cancela. Los certificados ya emitidos se mantienen.</p>
            <p class="form-error" id="rErr" role="alert"></p>
          </div>`,
        buttons: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Reiniciar intentos', value: 'reset', cls: 'btn-danger' }],
        async onSubmit(val, form) {
          const err = form.querySelector('#rErr');
          err.textContent = '';
          try {
            await Api.resetAttempts(u.id, form.rexam.value);
          } catch (ex) {
            err.textContent = ex.message;
            return false;
          }
          return true;
        }
      }).then(v => {
        if (v === 'reset') { UI.toast('Intentos reiniciados', 'success'); render(); }
      });
    };

    /** Elige el examen y abre el formulario para registrar una evaluación hecha por otro medio. */
    actions.recordAttempt = el => {
      const u = users.find(x => x.id === el.dataset.id);
      if (!u) return;
      const exams = Store.exams().filter(e => e.questions.length);
      if (!exams.length) return UI.toast('No hay exámenes con preguntas', 'error');
      const used = examId => atts.filter(a => a.userId === u.id && a.examId === examId).length;

      UI.modal({
        title: 'Registrar evaluación',
        body: `
          <div class="form">
            <p style="margin:0">Estudiante: <strong>${UI.esc(u.name)}</strong></p>
            <div class="field"><label for="pExam">Examen</label>
              <select class="input" id="pExam" name="pexam">
                ${exams.map(e => `<option value="${UI.esc(e.id)}" ${used(e.id) >= MAX_ATTEMPTS ? 'disabled' : ''}>${UI.esc(e.title)} — ${used(e.id)}/${MAX_ATTEMPTS} intentos${e.published ? '' : ' (inactivo)'}</option>`).join('')}
              </select></div>
            <p class="small muted" style="margin:0">Registra las respuestas de una evaluación que el estudiante presentó por otro medio. Se guarda como un intento nuevo y cuenta para el máximo de ${MAX_ATTEMPTS}. Para corregir un intento existente usa «Editar» en sus resultados.</p>
          </div>`,
        buttons: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Continuar', value: 'go', cls: 'btn-primary' }],
        onSubmit(val, form) {
          if (!form.pexam.value || used(form.pexam.value) >= MAX_ATTEMPTS) {
            UI.toast('El estudiante ya usó todos sus intentos en ese examen', 'error');
            return false;
          }
          go(`#/admin/registrar/${u.id}/${form.pexam.value}`);
          return true;
        }
      });
    };

    actions.new = () => openForm(null);
    actions.edit = el => openForm(Store.users().find(x => x.id === el.dataset.id));
    actions.delete = async el => {
      const u = Store.users().find(x => x.id === el.dataset.id);
      if (!u || u.id === me.id) return;
      if (u.role === 'admin' && Store.users().filter(x => x.role === 'admin').length <= 1) {
        return UI.toast('Debe existir al menos un administrador', 'error');
      }
      const ok = await UI.confirm(`¿Eliminar a <strong>${UI.esc(u.name)}</strong>? También se eliminarán sus intentos y certificados.`,
        { title: 'Eliminar usuario', okLabel: 'Eliminar', danger: true });
      if (!ok) return;
      // En el servidor, el borrado en cascada elimina también intentos y certificados
      if (await UI.run(el, () => Api.deleteUser(u.id).then(() => true))) {
        UI.toast('Usuario eliminado', 'success');
        render();
      }
    };
  }

  /* =======================================================
     Administración — registrar o editar las respuestas de un intento
     ======================================================= */
  function viewAdminAttemptEdit(user, attemptId) {
    const att = Store.attempts().find(a => a.id === attemptId);
    if (!att) return renderNotFound(user);
    if (att.status !== 'finished') {
      $app.innerHTML = `
        <section class="card" style="max-width:560px;margin:40px auto;text-align:center">
          <h1>Intento en curso</h1>
          <p class="muted">El estudiante está presentando este intento. Podrás editarlo cuando lo finalice.</p>
          <a class="btn btn-primary" href="#/admin/resultados/${att.userId}">Volver</a>
        </section>`;
      return;
    }
    attemptEditor(user, { att, userId: att.userId, examId: att.examId });
  }

  function viewAdminAttemptNew(user, userId, examId) {
    const exam = Domain.exam(examId);
    if (!exam || !exam.questions.length || !Store.users().some(u => u.id === userId)) return renderNotFound(user);
    attemptEditor(user, { att: null, userId, examId });
  }

  /** datetime-local ↔ ISO en la zona horaria del navegador */
  function toLocalInput(iso) {
    const d = iso ? new Date(iso) : new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  function attemptEditor(user, { att, userId, examId }) {
    const owner = Store.users().find(u => u.id === userId);
    const exam = Domain.exam(examId);
    const questions = att ? att.questionsSnapshot : exam.questions;
    const title = att ? att.examTitle : exam.title;
    const number = att ? att.number : Domain.attemptsFor(userId, examId).length + 1;
    const cert = Domain.certFor(userId, examId);
    const backsCert = !!(att && cert && cert.attemptId === att.id);
    const back = att ? '#/resultado/' + att.id : '#/admin/usuarios';

    $app.innerHTML = `
      <div class="page-head">
        <div>
          <p class="eyebrow">Panel administrativo · ${att ? 'Editar intento' : 'Registrar evaluación'}</p>
          <h1>${UI.esc(title)}</h1>
          <p class="muted">Estudiante: <strong>${UI.esc(owner ? owner.name : 'Usuario eliminado')}</strong> · Intento ${number} de ${MAX_ATTEMPTS}</p>
        </div>
        <a class="btn btn-outline btn-sm" href="${back}">&larr; Volver</a>
      </div>
      <div class="alert alert-info">${att
        ? 'Corrige las respuestas del estudiante. La calificación y el certificado se recalculan al guardar; el cambio queda registrado.'
        : 'Marca las respuestas que el estudiante dio en la evaluación presentada por otro medio. Se guardará como un intento finalizado.'}
        Las opciones marcadas con ✓ son las correctas.</div>

      <form id="attForm" class="form" novalidate>
        <section class="card form">
          <div class="form-row">
            <div class="field">
              <label for="aDate">Fecha y hora de presentación</label>
              <input class="input" id="aDate" type="datetime-local" max="${toLocalInput()}" value="${toLocalInput(att ? att.finishedAt : null)}" required>
            </div>
            <div class="field" style="align-content:end">
              <p class="small" style="margin:0" id="aScore" aria-live="polite"></p>
            </div>
          </div>
        </section>

        <section class="section" style="margin-top:8px">
          <div class="section-title"><h2>Respuestas</h2></div>
          <div class="card" id="aList">
            ${questions.map((q, k) => {
              const sel = att ? (att.answers[q.id] || []) : [];
              const type = q.type === 'multiple' ? 'checkbox' : 'radio';
              return `
                <fieldset class="review-item" data-qid="${UI.esc(q.id)}" style="margin-inline:0;min-width:0">
                  <legend class="hidden">Pregunta ${k + 1}</legend>
                  <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
                    <strong>${k + 1}. ${UI.esc(q.text)}</strong>
                    <span class="badge ${q.type === 'multiple' ? 'badge-accent' : 'badge-neutral'}">${q.type === 'multiple' ? 'Selección múltiple' : 'Selección única'}</span>
                  </div>
                  <div class="options" style="margin:12px 0 6px">
                    ${q.options.map(o => `
                      <label class="option ${sel.includes(o.id) ? 'selected' : ''}">
                        <input type="${type}" name="a_${UI.esc(q.id)}" value="${UI.esc(o.id)}" ${sel.includes(o.id) ? 'checked' : ''}>
                        <span>${UI.esc(o.text)}${(q.correct || []).includes(o.id) ? ' <strong style="color:var(--success)">✓</strong>' : ''}</span>
                      </label>`).join('')}
                  </div>
                  <button type="button" class="btn btn-ghost btn-sm" data-action="clearQ" data-qid="${UI.esc(q.id)}">Dejar sin responder</button>
                </fieldset>`;
            }).join('')}
          </div>
        </section>

        <div class="btn-row" style="justify-content:flex-end;border-top:1px solid var(--border);padding-top:16px">
          <a class="btn btn-outline" href="${back}">Cancelar</a>
          <button type="submit" class="btn btn-primary">${att ? 'Guardar cambios' : 'Registrar evaluación'}</button>
        </div>
      </form>`;

    const $list = document.getElementById('aList');
    const initialDate = document.getElementById('aDate').value;
    const boxes = () => Array.from($list.querySelectorAll('fieldset[data-qid]'));

    function collect() {
      const answers = {};
      boxes().forEach(box => {
        const ids = Array.from(box.querySelectorAll('input:checked')).map(i => i.value);
        if (ids.length) answers[box.dataset.qid] = ids;
      });
      return answers;
    }

    function score(answers) {
      const correct = questions.filter(q => Domain.isCorrect(q, answers[q.id] || [])).length;
      return { correct, percentage: Math.round(correct * 100 / questions.length) };
    }

    function refreshScore() {
      const answers = collect();
      const s = score(answers);
      const answered = Object.keys(answers).length;
      boxes().forEach(box => {
        box.classList.toggle('wrong', !Domain.isCorrect(questions.find(q => q.id === box.dataset.qid), answers[box.dataset.qid] || []));
        box.querySelectorAll('.option').forEach(l => l.classList.toggle('selected', l.querySelector('input').checked));
      });
      document.getElementById('aScore').innerHTML =
        `Resultado: <strong>${s.correct}/${questions.length}</strong> correctas · ${UI.badgeForPercent(s.percentage)}
         <br><span class="muted">${answered} de ${questions.length} respondidas</span>`;
    }

    $list.addEventListener('change', refreshScore);
    actions.clearQ = el => {
      const box = boxes().find(b => b.dataset.qid === el.dataset.qid);
      if (box) box.querySelectorAll('input').forEach(i => { i.checked = false; });
      refreshScore();
    };

    document.getElementById('attForm').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = e.submitter || e.target.querySelector('button[type=submit]');
      if (btn.disabled) return;
      const dateVal = document.getElementById('aDate').value;
      const takenAt = dateVal ? new Date(dateVal) : null;
      if (!takenAt || isNaN(takenAt)) return UI.toast('Indica la fecha y hora de presentación', 'error');
      if (takenAt > new Date()) return UI.toast('La fecha de presentación no puede estar en el futuro', 'error');

      const answers = collect();
      const s = score(answers);
      const missing = questions.length - Object.keys(answers).length;
      let msg = att
        ? `Se actualizarán las respuestas del <strong>intento ${number}</strong> de ${UI.esc(owner ? owner.name : '')}. Nuevo resultado: <strong>${s.percentage}%</strong>.`
        : `Se registrará el <strong>intento ${number} de ${MAX_ATTEMPTS}</strong> de ${UI.esc(owner ? owner.name : '')} con un resultado de <strong>${s.percentage}%</strong>.`;
      if (missing) msg += `<br><br>${missing} pregunta(s) quedan sin responder y se calificarán como incorrectas.`;
      if (backsCert && s.percentage < PASS_PERCENT) {
        msg += `<br><br><strong>El certificado ${UI.esc(cert.code)} se retirará</strong> porque este intento quedará por debajo del ${PASS_PERCENT}% (se emitirá uno nuevo si otro intento lo supera).`;
      } else if (!cert && s.percentage >= PASS_PERCENT) {
        msg += '<br><br>Se emitirá el certificado del examen.';
      }
      const ok = await UI.confirm(msg, {
        title: att ? 'Guardar cambios' : 'Registrar evaluación',
        okLabel: att ? 'Guardar' : 'Registrar',
        danger: backsCert && s.percentage < PASS_PERCENT
      });
      if (!ok) return;

      // Al editar, la fecha solo se envía si cambió (el campo no guarda segundos)
      const sendDate = !att || dateVal !== initialDate;
      const saved = await UI.run(btn, () => Api.saveAttemptAsAdmin({
        attemptId: att ? att.id : null, userId, examId, answers, takenAt: sendDate ? takenAt.toISOString() : null
      }));
      if (!saved) return;
      UI.toast(att ? 'Intento actualizado' : 'Evaluación registrada', 'success');
      go('#/resultado/' + saved.id);
    });

    refreshScore();
  }

  /* =======================================================
     Arranque
     ======================================================= */
  async function init() {
    document.getElementById('year').textContent = new Date().getFullYear();
    const toggle = document.getElementById('navToggle');
    toggle.addEventListener('click', () => {
      const open = $nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });

    $app.innerHTML = '<p class="empty" role="status">Cargando…</p>';
    try {
      await window.HDIData.init();
    } catch (ex) {
      $app.innerHTML = `
        <section class="card" style="max-width:520px;margin:40px auto;text-align:center">
          <p class="eyebrow">Sin conexión</p>
          <h1>No se pudo conectar con el servidor</h1>
          <p class="muted">${UI.esc(ex.message)}</p>
          <button class="btn btn-primary" type="button" onclick="location.reload()">Reintentar</button>
        </section>`;
      return;
    }

    window.addEventListener('hashchange', render);
    // Sesión iniciada o cerrada en otra pestaña, o sesión expirada
    window.HDIData.onAuthChange(render);
    render();
  }

  init();
})();
