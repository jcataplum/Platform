/* =========================================================
   app.js — Campus HDI: SPA de exámenes (JavaScript vanilla)
   Módulos: UI, Auth, Domain, Router, Views (auth, estudiante,
   motor de examen, resultados, certificado, administración)
   ========================================================= */
(function () {
  'use strict';

  const { Store, KEYS, MAX_ATTEMPTS, PASS_PERCENT, uid, certCode, hash, seed, gradeAnswers } = window.HDIData;

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
     * Abre un modal. buttons: [{label, value, cls}]. onSubmit(value, form) → false mantiene abierto.
     * Resuelve con el value del botón pulsado (o null si se cierra).
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
        const onFormSubmit = e => {
          e.preventDefault();
          const def = form.querySelector('#modalFoot button[type=submit]');
          const val = e.submitter ? e.submitter.value : (def ? def.value : 'ok');
          if (val === 'cancel') return finish(null);
          if (onSubmit && onSubmit(val, form) === false) return;
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
     Auth — sesión con localStorage
     ======================================================= */
  const Auth = {
    current() {
      const session = Store.get(KEYS.currentUser, null);
      if (!session) return null;
      const user = Store.users().find(u => u.id === session.id);
      if (!user) { Store.remove(KEYS.currentUser); return null; }
      return user;
    },
    login(email, password) {
      const user = Store.users().find(u => u.email.toLowerCase() === email.trim().toLowerCase());
      if (!user || user.passwordHash !== hash(password)) return null;
      Store.set(KEYS.currentUser, { id: user.id, since: new Date().toISOString() });
      return user;
    },
    register(name, email, password) {
      const users = Store.users();
      if (users.some(u => u.email.toLowerCase() === email.trim().toLowerCase())) {
        throw new Error('Ya existe una cuenta con ese correo.');
      }
      const user = {
        id: uid('user'),
        name: name.trim(),
        email: email.trim().toLowerCase(),
        passwordHash: hash(password),
        role: 'student',
        createdAt: new Date().toISOString()
      };
      users.push(user);
      Store.saveUsers(users);
      Store.set(KEYS.currentUser, { id: user.id, since: new Date().toISOString() });
      return user;
    },
    logout() {
      Store.remove(KEYS.currentUser);
    },
    home(user) {
      return user && user.role === 'admin' ? '#/admin' : '#/panel';
    }
  };

  /* =======================================================
     Domain — reglas de negocio (intentos, calificación, certificados)
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

    /** Crea un nuevo intento (o reanuda el que está en curso). */
    startAttempt(user, examId) {
      const exam = Domain.exam(examId);
      if (!exam || !exam.published) throw new Error('El examen no está disponible.');
      if (!exam.questions.length) throw new Error('El examen no tiene preguntas.');
      const current = Domain.inProgress(user.id, examId);
      if (current) return current;
      const used = Domain.attemptsFor(user.id, examId).length;
      if (used >= MAX_ATTEMPTS) throw new Error('Has alcanzado el máximo de ' + MAX_ATTEMPTS + ' intentos.');

      const attempt = {
        id: uid('att'),
        userId: user.id,
        examId: exam.id,
        examTitle: exam.title,
        number: used + 1,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        questionsSnapshot: JSON.parse(JSON.stringify(exam.questions)),
        answers: {},
        currentIndex: 0,
        correctCount: 0,
        total: exam.questions.length,
        percentage: 0,
        status: 'in_progress'
      };
      const all = Store.attempts();
      all.push(attempt); // nunca se sobrescriben intentos anteriores
      Store.saveAttempts(all);
      return attempt;
    },

    /** Aplica un cambio a un intento y lo persiste de inmediato. */
    updateAttempt(id, mutator) {
      const all = Store.attempts();
      const att = all.find(a => a.id === id);
      if (!att) return null;
      mutator(att);
      Store.saveAttempts(all);
      return att;
    },

    saveAnswer(attemptId, questionId, optionIds) {
      return Domain.updateAttempt(attemptId, att => {
        if (att.status !== 'in_progress') throw new Error('El intento ya fue finalizado.');
        if (att.answers[questionId]) throw new Error('Esta respuesta ya fue confirmada y no puede modificarse.');
        att.answers[questionId] = optionIds.slice();
      });
    },

    finishAttempt(attemptId) {
      let cert = null;
      const att = Domain.updateAttempt(attemptId, a => {
        if (a.status !== 'in_progress') return;
        a.correctCount = gradeAnswers(a.questionsSnapshot, a.answers);
        a.total = a.questionsSnapshot.length;
        a.percentage = a.total ? Math.round((a.correctCount / a.total) * 100) : 0;
        a.finishedAt = new Date().toISOString();
        a.status = 'finished';
      });
      if (att && att.percentage >= PASS_PERCENT) cert = Domain.issueCertificate(att);
      return { attempt: att, certificate: cert };
    },

    /** Emite certificado si no existe ya uno para el mismo usuario y examen. */
    issueCertificate(att) {
      const existing = Domain.certFor(att.userId, att.examId);
      if (existing) return existing;
      const user = Store.users().find(u => u.id === att.userId);
      const certs = Store.certificates();
      const codes = new Set(certs.map(c => c.code));
      let code;
      do { code = certCode(); } while (codes.has(code));
      const cert = {
        id: uid('cert'),
        code,
        userId: att.userId,
        userName: user ? user.name : '',
        examId: att.examId,
        examTitle: att.examTitle,
        attemptId: att.id,
        percentage: att.percentage,
        issuedAt: att.finishedAt
      };
      certs.push(cert);
      Store.saveCertificates(certs);
      return cert;
    },

    isCorrect(question, selected) {
      const s = (selected || []).slice().sort();
      const c = question.correct.slice().sort();
      return s.length === c.length && s.every((v, i) => v === c[i]);
    }
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
    { re: /^#\/admin\/usuarios$/, view: viewAdminUsers, access: 'admin' }
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
      links = [['#/admin', 'Dashboard'], ['#/admin/examenes', 'Exámenes'], ['#/admin/usuarios', 'Usuarios']];
    } else {
      links = [['#/panel', 'Mis exámenes'], ['#/resultados', 'Resultados'], ['#/certificados', 'Certificados']];
    }
    const isActive = h => hash === h || (h === '#/admin/examenes' && hash.startsWith('#/admin/examen/'));
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
    if (lb) lb.addEventListener('click', () => {
      Auth.logout();
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
            <div class="demo-box">
              <strong>Cuentas de demostración</strong><br>
              Admin: <code>admin@hdi.com</code> / <code>admin123</code>
              <button type="button" class="btn btn-ghost btn-sm" data-action="fill" data-email="admin@hdi.com" data-pass="admin123">Usar</button><br>
              Estudiante: <code>estudiante@hdi.com</code> / <code>estudiante123</code>
              <button type="button" class="btn btn-ghost btn-sm" data-action="fill" data-email="estudiante@hdi.com" data-pass="estudiante123">Usar</button>
            </div>
          </form>
        </section>
      </div>`;

    actions.fill = el => {
      document.getElementById('lEmail').value = el.dataset.email;
      document.getElementById('lPass').value = el.dataset.pass;
    };

    document.getElementById('loginForm').addEventListener('submit', e => {
      e.preventDefault();
      const f = e.target;
      const err = document.getElementById('lErr');
      if (!f.email.value.trim() || !f.password.value) { err.textContent = 'Completa correo y contraseña.'; return; }
      const user = Auth.login(f.email.value, f.password.value);
      if (!user) { err.textContent = 'Correo o contraseña incorrectos.'; return; }
      UI.toast('¡Bienvenido(a), ' + user.name.split(' ')[0] + '!', 'success');
      go(Auth.home(user));
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
                <input class="input" id="rPass" name="password" type="password" autocomplete="new-password" minlength="6" required>
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

    document.getElementById('regForm').addEventListener('submit', e => {
      e.preventDefault();
      const f = e.target;
      const err = document.getElementById('rErr');
      const name = f.name.value.trim(), email = f.email.value.trim();
      if (name.length < 3) { err.textContent = 'Ingresa tu nombre completo.'; return; }
      if (!UI.emailOk(email)) { err.textContent = 'Ingresa un correo válido.'; return; }
      if (f.password.value.length < 6) { err.textContent = 'La contraseña debe tener al menos 6 caracteres.'; return; }
      if (f.password.value !== f.password2.value) { err.textContent = 'Las contraseñas no coinciden.'; return; }
      try {
        const user = Auth.register(name, email, f.password.value);
        UI.toast('Cuenta creada correctamente', 'success');
        go(Auth.home(user));
      } catch (ex) {
        err.textContent = ex.message;
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

  function historyTableHtml(atts, { showUser = false, users = [] } = {}) {
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
                <td data-label="Intento">#${a.number}</td>
                <td data-label="Fecha">${UI.fmtDateTime(done ? a.finishedAt : a.startedAt)}</td>
                <td data-label="Correctas">${done ? a.correctCount : '—'}</td>
                <td data-label="Incorrectas">${done ? a.total - a.correctCount : '—'}</td>
                <td data-label="Resultado">${done ? UI.badgeForPercent(a.percentage) : '<span class="badge badge-accent">En curso</span>'}</td>
                <td data-label="">${done
                  ? `<a class="btn btn-outline btn-sm" href="#/resultado/${a.id}">Ver detalle</a>`
                  : (!showUser ? `<a class="btn btn-accent btn-sm" href="#/intento/${a.id}">Continuar</a>` : '')}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function certListHtml(certs) {
    if (!certs.length) {
      return `<div class="card"><p class="empty" style="padding:8px">Aún no tienes certificados. Obtén ${PASS_PERCENT}% o más en un examen para recibir uno.</p></div>`;
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
      try {
        const att = Domain.startAttempt(user, exam.id);
        go('#/intento/' + att.id);
      } catch (ex) {
        UI.toast(ex.message, 'error');
        render();
      }
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
      form.addEventListener('submit', e => {
        e.preventDefault();
        if (locked || !pending.length) return;
        try {
          att = Domain.saveAnswer(att.id, q.id, pending);
          pending = [];
          UI.toast('Respuesta guardada', 'success');
          // Avanza automáticamente a la siguiente pregunta sin responder
          const nextIdx = qs.findIndex((x, k) => k > i && !att.answers[x.id]);
          if (nextIdx !== -1) setIndex(nextIdx);
          else draw();
        } catch (ex) {
          UI.toast(ex.message, 'error');
        }
      });
    }

    function setIndex(i) {
      pending = [];
      att = Domain.updateAttempt(att.id, a => { a.currentIndex = i; });
      draw();
    }

    actions.prev = () => { if (att.currentIndex > 0) setIndex(att.currentIndex - 1); };
    actions.next = () => { if (att.currentIndex < qs.length - 1) setIndex(att.currentIndex + 1); };
    actions.goto = el => setIndex(Number(el.dataset.i));
    actions.finish = async () => {
      const missing = qs.filter(x => !att.answers[x.id]).length;
      const msg = missing
        ? `Tienes <strong>${missing} pregunta(s) sin responder</strong>; se calificarán como incorrectas.<br><br>¿Deseas finalizar el examen?`
        : '¿Deseas finalizar y enviar el examen? No podrás modificar tus respuestas.';
      const ok = await UI.confirm(msg, { title: 'Finalizar examen', okLabel: 'Finalizar', danger: missing > 0 });
      if (!ok) return;
      const { attempt, certificate } = Domain.finishAttempt(att.id);
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
    const back = user.role === 'admin' ? '#/admin' : '#/resultados';

    $app.innerHTML = `
      <div class="page-head">
        <div>
          <p class="eyebrow">Resultado · Intento ${att.number} de ${MAX_ATTEMPTS}</p>
          <h1>${UI.esc(att.examTitle)}</h1>
          ${user.role === 'admin' ? `<p class="muted">Estudiante: ${UI.esc(owner ? owner.name : 'Usuario eliminado')}</p>` : ''}
        </div>
        <a class="btn btn-outline btn-sm" href="${back}">&larr; Volver</a>
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
                    const isC = q.correct.includes(o.id);
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
    const back = user.role === 'admin' ? '#/admin' : '#/certificados';

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
          <div><b>Campus HDI</b>Dirección de Formación</div>
        </div>
      </article>`;

    actions.print = () => window.print();
    if (printFlag) setTimeout(() => window.print(), 400);
  }

  /* =======================================================
     Administración — dashboard
     ======================================================= */
  function adminTabs(active) {
    const tabs = [['#/admin', 'Dashboard'], ['#/admin/examenes', 'Exámenes'], ['#/admin/usuarios', 'Usuarios']];
    return `<nav class="tabs" aria-label="Secciones de administración">${tabs.map(([h, l]) =>
      `<a href="${h}" class="${h === active ? 'active' : ''}">${l}</a>`).join('')}</nav>`;
  }

  function viewAdminDashboard() {
    const users = Store.users();
    const exams = Store.exams();
    const atts = Store.attempts();
    const finished = atts.filter(a => a.status === 'finished');
    const certs = Store.certificates();
    const avg = finished.length ? Math.round(finished.reduce((s, a) => s + a.percentage, 0) / finished.length) : 0;
    const passed = finished.filter(a => a.percentage >= PASS_PERCENT).length;
    const examIds = Array.from(new Set(atts.map(a => a.examId)));

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
        <button class="btn btn-danger btn-sm" data-action="reset">Restablecer datos demo</button>
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
      </section>

      <section class="section">
        <div class="section-title">
          <h2>Resultados</h2>
          <label class="small" style="display:flex;gap:8px;align-items:center">Filtrar
            <select class="input" id="examFilter" style="width:auto">
              <option value="">Todos los exámenes</option>
              ${examIds.map(id => {
                const a = atts.find(x => x.examId === id);
                return `<option value="${id}">${UI.esc(a.examTitle)}</option>`;
              }).join('')}
            </select>
          </label>
        </div>
        <div id="resultsTable"></div>
      </section>

      <section class="section">
        <div class="section-title"><h2>Certificados emitidos</h2></div>
        <div class="table-wrap">
          <table class="table-responsive">
            <thead><tr><th>Código</th><th>Estudiante</th><th>Examen</th><th>Puntaje</th><th>Fecha</th><th></th></tr></thead>
            <tbody>${certs.length ? certs.slice().reverse().map(c => `<tr>
              <td data-label="Código"><code>${UI.esc(c.code)}</code></td>
              <td data-label="Estudiante">${UI.esc((users.find(u => u.id === c.userId) || {}).name || c.userName)}</td>
              <td data-label="Examen">${UI.esc(c.examTitle)}</td>
              <td data-label="Puntaje">${c.percentage}%</td>
              <td data-label="Fecha">${UI.fmtDate(c.issuedAt)}</td>
              <td data-label=""><a class="btn btn-outline btn-sm" href="#/certificado/${c.id}">Ver</a></td></tr>`).join('')
              : '<tr><td colspan="6" class="empty">Aún no se han emitido certificados.</td></tr>'}</tbody>
          </table>
        </div>
      </section>`;

    const drawResults = () => {
      const f = document.getElementById('examFilter').value;
      const list = atts.filter(a => !f || a.examId === f)
        .sort((a, b) => (b.finishedAt || b.startedAt).localeCompare(a.finishedAt || a.startedAt));
      document.getElementById('resultsTable').innerHTML = historyTableHtml(list, { showUser: true, users });
    };
    document.getElementById('examFilter').addEventListener('change', drawResults);
    drawResults();

    actions.reset = async () => {
      const ok = await UI.confirm('Se eliminarán todos los usuarios, exámenes, intentos y certificados, y se restaurarán los datos de demostración.',
        { title: 'Restablecer datos', okLabel: 'Restablecer', danger: true });
      if (!ok) return;
      seed(true);
      UI.toast('Datos de demostración restablecidos', 'success');
      render();
    };
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

    actions.toggle = el => {
      const all = Store.exams();
      const e = all.find(x => x.id === el.dataset.id);
      if (!e) return;
      if (!e.published && !e.questions.length) return UI.toast('Agrega al menos una pregunta antes de publicar', 'error');
      e.published = !e.published;
      e.updatedAt = new Date().toISOString();
      Store.saveExams(all);
      UI.toast(e.published ? 'Examen publicado' : 'Examen desactivado', 'success');
      render();
    };
    actions.delete = async el => {
      const e = Store.exams().find(x => x.id === el.dataset.id);
      if (!e) return;
      const ok = await UI.confirm(`¿Eliminar el examen «${UI.esc(e.title)}»? Los intentos y certificados históricos se conservarán.`,
        { title: 'Eliminar examen', okLabel: 'Eliminar', danger: true });
      if (!ok) return;
      Store.saveExams(Store.exams().filter(x => x.id !== e.id));
      UI.toast('Examen eliminado', 'success');
      render();
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

    document.getElementById('examForm').addEventListener('submit', e => {
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

      const now = new Date().toISOString();
      const all = Store.exams();
      const saved = {
        id: draft.id,
        title,
        description: draft.description.trim(),
        published: draft.published,
        questions,
        createdAt: source ? source.createdAt : now,
        updatedAt: now
      };
      const idx = all.findIndex(x => x.id === draft.id);
      if (idx === -1) all.push(saved); else all[idx] = saved;
      Store.saveExams(all);
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
                placeholder="${u ? 'Dejar vacío para no cambiar' : 'Mínimo 6 caracteres'}"></div>
          </div>
          <p class="form-error" id="uErr" role="alert"></p>
        </div>`;
    }

    function openForm(u) {
      UI.modal({
        title: u ? 'Editar usuario' : 'Nuevo usuario',
        body: userForm(u),
        buttons: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Guardar', value: 'save', cls: 'btn-primary' }],
        onSubmit(val, form) {
          const err = form.querySelector('#uErr');
          const name = form.uname.value.trim();
          const email = form.uemail.value.trim().toLowerCase();
          const role = u && u.id === me.id ? u.role : form.urole.value;
          const pass = form.upass.value;
          const all = Store.users();
          if (name.length < 3) { err.textContent = 'Ingresa un nombre válido.'; return false; }
          if (!UI.emailOk(email)) { err.textContent = 'Ingresa un correo válido.'; return false; }
          if (all.some(x => x.email.toLowerCase() === email && (!u || x.id !== u.id))) { err.textContent = 'Ese correo ya está registrado.'; return false; }
          if ((!u || pass) && pass.length < 6) { err.textContent = 'La contraseña debe tener al menos 6 caracteres.'; return false; }
          if (u && u.role === 'admin' && role !== 'admin' && all.filter(x => x.role === 'admin').length <= 1) {
            err.textContent = 'Debe existir al menos un administrador.'; return false;
          }

          if (u) {
            const t = all.find(x => x.id === u.id);
            t.name = name; t.email = email; t.role = role;
            if (pass) t.passwordHash = hash(pass);
            // mantiene el nombre de los certificados sincronizado
            const cs = Store.certificates();
            cs.forEach(c => { if (c.userId === t.id) c.userName = name; });
            Store.saveCertificates(cs);
          } else {
            all.push({ id: uid('user'), name, email, passwordHash: hash(pass), role, createdAt: new Date().toISOString() });
          }
          Store.saveUsers(all);
          return true;
        }
      }).then(v => {
        if (v === 'save') { UI.toast(u ? 'Usuario actualizado' : 'Usuario creado', 'success'); render(); }
      });
    }

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
      Store.saveUsers(Store.users().filter(x => x.id !== u.id));
      Store.saveAttempts(Store.attempts().filter(a => a.userId !== u.id));
      Store.saveCertificates(Store.certificates().filter(c => c.userId !== u.id));
      UI.toast('Usuario eliminado', 'success');
      render();
    };
  }

  /* =======================================================
     Arranque
     ======================================================= */
  function init() {
    seed(false);
    document.getElementById('year').textContent = new Date().getFullYear();
    const toggle = document.getElementById('navToggle');
    toggle.addEventListener('click', () => {
      const open = $nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    window.addEventListener('hashchange', render);
    // Sincroniza si los datos cambian en otra pestaña
    window.addEventListener('storage', e => {
      if (e.key === KEYS.currentUser || e.key === KEYS.users) render();
    });
    render();
  }

  init();
})();
