/* =========================================================
   data.js — Capa de datos (localStorage) + datos de demostración
   Claves: users, exams, attempts, certificates, currentUser
   ========================================================= */
(function (global) {
  'use strict';

  const KEYS = {
    users: 'users',
    exams: 'exams',
    attempts: 'attempts',
    certificates: 'certificates',
    currentUser: 'currentUser',
    seeded: 'hdi_seeded_v1'
  };

  const MAX_ATTEMPTS = 3;
  const PASS_PERCENT = 90;

  /* ---------- Utilidades ---------- */
  function uid(prefix) {
    const rnd = new Uint32Array(2);
    (global.crypto || global.msCrypto).getRandomValues(rnd);
    return (prefix || 'id') + '_' + Date.now().toString(36) + rnd[0].toString(36) + rnd[1].toString(36).slice(0, 4);
  }

  function certCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const rnd = new Uint32Array(8);
    global.crypto.getRandomValues(rnd);
    let s = '';
    for (let i = 0; i < 8; i++) s += alphabet[rnd[i] % alphabet.length];
    return 'HDI-' + s.slice(0, 4) + '-' + s.slice(4);
  }

  /* Hash sincrónico (cyrb53) con sal. Solo para demostración: no es seguridad real. */
  function hash(str) {
    str = 'hdi::' + String(str);
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }

  /* ---------- Store ---------- */
  const Store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    },
    remove(key) {
      localStorage.removeItem(key);
    },
    users() { return Store.get(KEYS.users, []); },
    exams() { return Store.get(KEYS.exams, []); },
    attempts() { return Store.get(KEYS.attempts, []); },
    certificates() { return Store.get(KEYS.certificates, []); },
    saveUsers(v) { Store.set(KEYS.users, v); },
    saveExams(v) { Store.set(KEYS.exams, v); },
    saveAttempts(v) { Store.set(KEYS.attempts, v); },
    saveCertificates(v) { Store.set(KEYS.certificates, v); }
  };

  /* ---------- Datos demo ---------- */
  function q(text, type, options, correctIdx) {
    const opts = options.map(t => ({ id: uid('o'), text: t }));
    return {
      id: uid('q'),
      text,
      type,
      options: opts,
      correct: correctIdx.map(i => opts[i].id)
    };
  }

  function buildDemoExams() {
    const now = new Date().toISOString();
    return [
      {
        id: 'exam_fundamentos',
        title: 'Fundamentos de Seguros',
        description: 'Conceptos esenciales del sector asegurador: riesgo, póliza, prima, deducible y coberturas.',
        published: true,
        createdAt: now,
        updatedAt: now,
        questions: [
          q('¿Qué es la prima en un contrato de seguro?', 'single',
            ['El valor que paga el asegurado por la cobertura', 'La indemnización que paga la aseguradora', 'El documento que formaliza el contrato', 'El monto máximo asegurado'], [0]),
          q('¿Qué documento formaliza el contrato de seguro?', 'single',
            ['La factura', 'La póliza', 'El siniestro', 'El endoso'], [1]),
          q('Selecciona los elementos esenciales de un contrato de seguro.', 'multiple',
            ['Interés asegurable', 'Riesgo asegurable', 'Prima', 'Descuento comercial'], [0, 1, 2]),
          q('¿Qué es un siniestro?', 'single',
            ['La renovación de la póliza', 'La materialización del riesgo cubierto', 'Un tipo de reaseguro', 'La cancelación del contrato'], [1]),
          q('El deducible es:', 'single',
            ['La parte de la pérdida que asume el asegurado', 'Un beneficio adicional', 'El impuesto del seguro', 'La comisión del intermediario'], [0]),
          q('¿Cuáles de los siguientes son seguros de daños?', 'multiple',
            ['Seguro de automóviles', 'Seguro de hogar', 'Seguro de vida', 'Seguro de incendio'], [0, 1, 3]),
          q('¿Quién es el tomador del seguro?', 'single',
            ['Quien recibe la indemnización siempre', 'Quien contrata el seguro y paga la prima', 'El perito de la aseguradora', 'El reasegurador'], [1]),
          q('El reaseguro es:', 'single',
            ['Un seguro para las aseguradoras', 'Una renovación automática', 'Un seguro obligatorio de tránsito', 'Un descuento por buen historial'], [0])
        ]
      },
      {
        id: 'exam_servicio',
        title: 'Atención y Servicio al Cliente',
        description: 'Buenas prácticas de servicio, comunicación efectiva y gestión de reclamaciones.',
        published: true,
        createdAt: now,
        updatedAt: now,
        questions: [
          q('¿Cuál es el primer paso ante la reclamación de un cliente?', 'single',
            ['Escuchar activamente', 'Transferir la llamada', 'Ofrecer un descuento', 'Cerrar el caso'], [0]),
          q('Selecciona prácticas de comunicación efectiva.', 'multiple',
            ['Usar lenguaje claro', 'Confirmar la comprensión', 'Interrumpir para ahorrar tiempo', 'Mostrar empatía'], [0, 1, 3]),
          q('Un cliente satisfecho suele:', 'single',
            ['Cancelar su póliza', 'Recomendar la compañía', 'Presentar más quejas', 'Ignorar las comunicaciones'], [1]),
          q('¿Qué indicador mide la probabilidad de que un cliente recomiende la empresa?', 'single',
            ['ROI', 'NPS', 'KPI de ventas', 'EBITDA'], [1]),
          q('Selecciona canales de atención digitales.', 'multiple',
            ['Chat en línea', 'Aplicación móvil', 'Correo electrónico', 'Oficina física'], [0, 1, 2]),
          q('Ante un error de la compañía, lo correcto es:', 'single',
            ['Negarlo', 'Reconocerlo y ofrecer solución', 'Culpar al cliente', 'Esperar a que el cliente lo olvide'], [1])
        ]
      },
      {
        id: 'exam_fraude',
        title: 'Prevención de Fraude',
        description: 'Identificación de señales de alerta y protocolos ante posibles fraudes en seguros.',
        published: false,
        createdAt: now,
        updatedAt: now,
        questions: [
          q('¿Cuál es una señal de alerta de fraude?', 'single',
            ['Reclamación presentada con documentos completos', 'Siniestro reportado poco después de contratar la póliza', 'Cliente con años de antigüedad', 'Pago puntual de primas'], [1]),
          q('Selecciona acciones correctas ante una sospecha de fraude.', 'multiple',
            ['Documentar la evidencia', 'Escalar al área encargada', 'Confrontar públicamente al cliente', 'Seguir el protocolo interno'], [0, 1, 3]),
          q('El fraude en seguros afecta principalmente a:', 'single',
            ['Solo a la aseguradora', 'A todos los asegurados vía mayores primas', 'A nadie', 'Solo al Estado'], [1])
        ]
      }
    ];
  }

  function gradeAnswers(questions, answers) {
    let correct = 0;
    questions.forEach(qq => {
      const sel = (answers[qq.id] || []).slice().sort();
      const ok = qq.correct.slice().sort();
      if (sel.length === ok.length && sel.every((v, i) => v === ok[i])) correct++;
    });
    return correct;
  }

  function seed(force) {
    if (!force && localStorage.getItem(KEYS.seeded)) return;

    const now = Date.now();
    const admin = {
      id: 'user_admin',
      name: 'Administrador HDI',
      email: 'admin@hdi.com',
      passwordHash: hash('admin123'),
      role: 'admin',
      createdAt: new Date(now - 86400000 * 30).toISOString()
    };
    const student = {
      id: 'user_estudiante',
      name: 'Laura Gómez',
      email: 'estudiante@hdi.com',
      passwordHash: hash('estudiante123'),
      role: 'student',
      createdAt: new Date(now - 86400000 * 10).toISOString()
    };
    const exams = buildDemoExams();
    const service = exams[1];

    // Intento 1 (reprobado) y 2 (aprobado con certificado) en "Atención y Servicio al Cliente"
    const qs = service.questions;
    const a1 = {};
    qs.forEach((qq, i) => { a1[qq.id] = i < 4 ? qq.correct.slice() : [qq.options[qq.options.length - 1].id]; });
    const a2 = {};
    qs.forEach(qq => { a2[qq.id] = qq.correct.slice(); });

    const mk = (n, answers, daysAgo) => {
      const correctCount = gradeAnswers(qs, answers);
      const finished = new Date(now - 86400000 * daysAgo);
      return {
        id: uid('att'),
        userId: student.id,
        examId: service.id,
        examTitle: service.title,
        number: n,
        startedAt: new Date(finished.getTime() - 600000).toISOString(),
        finishedAt: finished.toISOString(),
        questionsSnapshot: JSON.parse(JSON.stringify(qs)),
        answers,
        currentIndex: qs.length - 1,
        correctCount,
        total: qs.length,
        percentage: Math.round((correctCount / qs.length) * 100),
        status: 'finished'
      };
    };
    const att1 = mk(1, a1, 3);
    const att2 = mk(2, a2, 1);

    const cert = {
      id: uid('cert'),
      code: certCode(),
      userId: student.id,
      userName: student.name,
      examId: service.id,
      examTitle: service.title,
      attemptId: att2.id,
      percentage: att2.percentage,
      issuedAt: att2.finishedAt
    };

    Store.saveUsers([admin, student]);
    Store.saveExams(exams);
    Store.saveAttempts([att1, att2]);
    Store.saveCertificates([cert]);
    localStorage.setItem(KEYS.seeded, '1');
  }

  global.HDIData = {
    KEYS, MAX_ATTEMPTS, PASS_PERCENT,
    Store, uid, certCode, hash, seed, gradeAnswers
  };
})(window);
