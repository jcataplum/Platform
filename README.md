# Campus HDI · Plataforma educativa de exámenes

Aplicación web en HTML5, CSS3 y JavaScript vanilla para presentar exámenes de opción múltiple, consultar resultados y obtener certificados. El frontend no usa frameworks; los datos, la autenticación y las reglas de negocio viven en [Supabase](https://supabase.com) (Postgres + Auth + Edge Functions).

**Plataforma en línea:** https://jcataplum.github.io/Platform/

## Ejecución

Servir la carpeta con un servidor estático (requiere conexión a internet):

```
py -m http.server 5510
```

→ http://localhost:5510

## Funcionalidades

- Registro, inicio y cierre de sesión con Supabase Auth (sesión persistente). Las contraseñas deben tener al menos 8 caracteres.
- Exámenes con preguntas de selección única o múltiple, una pregunta a la vez; cada respuesta confirmada se guarda y se bloquea.
- Máximo 3 intentos por examen; cada intento se conserva de forma individual.
- Resultados con correctas, incorrectas, porcentaje, fecha/hora y número de intento.
- Certificado con código único al obtener 90% o más (uno por usuario y examen), imprimible o guardable como PDF.
- Panel administrativo: Dashboard con indicadores, gráfica «Cumplimiento por módulo evaluado» (promedio de la mejor calificación de cada persona por examen, con la meta de 90 %) y rendimiento por examen; CRUD de exámenes (publicar/desactivar) y CRUD de usuarios.
- Solo el administrador puede reiniciar los intentos de un estudiante en un examen (Usuarios → Reiniciar intentos). Los intentos anteriores no se borran: quedan anulados en la base de datos (`voided_at`, `voided_by`) como historial, y los certificados ya emitidos se conservan.
- Pestaña «Resultados y Certificados» (admin): listado de personas con búsqueda y filtro; por persona, «Ver resultados» (resultados por módulo e historial de intentos, con acceso al detalle y a la edición) y «Ver certificados».
- Descargas (en «Resultados y Certificados»): Excel (.xlsx) con tres hojas —resumen por persona, resultados por módulo con la calificación y fecha de cada intento, y detalle de respuestas— para todas las personas o solo una; y reporte de calificaciones en PDF. Las librerías de Excel (SheetJS) y PDF (jsPDF) se cargan desde cdnjs solo al descargar.
- El administrador puede registrar evaluaciones presentadas por otro medio (Usuarios → Registrar evaluación) y editar las respuestas de cualquier intento finalizado (Editar, en los resultados). La nota y el certificado se recalculan en el servidor; los intentos registrados quedan marcados como «Manual» y toda edición guarda quién y cuándo (`manual`, `edited_at`, `edited_by`). Si una edición baja un intento certificado de 90 %, el certificado se retira (y se emite de nuevo si otro intento vigente lo supera).

## Arquitectura y seguridad

- Las tablas (`profiles`, `exams`, `attempts`, `certificates`) no son accesibles directamente desde el navegador. Todo pasa por funciones RPC de Postgres que validan quién llama y aplican las reglas: límite de intentos, respuestas inmodificables, calificación y emisión de certificados en el servidor.
- Las respuestas correctas nunca se envían al estudiante mientras presenta un examen; en los resultados solo se revelan cuando obtiene el certificado o agota sus intentos.
- Los roles se asignan en el servidor: registrarse siempre crea un estudiante.
- Contraseñas de mínimo 8 caracteres, exigido por Supabase Auth ("Minimum password length"). Si se cambia ese valor, actualizar también `MIN_PASSWORD_LENGTH` en `data.js` y en `supabase/functions/admin-users/index.ts` para que los mensajes coincidan.
- La gestión de cuentas desde el panel admin usa la Edge Function `admin-users`, que es la única pieza con la clave `service_role`.

## Estructura

```
index.html                  Estructura semántica de la SPA
styles.css                  Estilos responsive y de impresión (colores Grupo HDI)
data.js                     Cliente Supabase: caché de lectura, Auth y operaciones (RPC)
app.js                      Enrutador, motor de examen y vistas
assets/                     Logo corporativo
supabase/migrations/        Esquema, reglas de negocio (RPC) y permisos
supabase/seed.sql           Cuentas y datos de demostración (solo entornos locales o de prueba)
supabase/functions/admin-users/   Edge Function para gestionar usuarios
```

> ⚠ `supabase/seed.sql` borra todos los exámenes, intentos y certificados antes de cargar los de demostración. No debe ejecutarse contra el proyecto de producción.
