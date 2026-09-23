# Campus HDI · Plataforma educativa de exámenes

Aplicación web en HTML5, CSS3 y JavaScript vanilla para presentar exámenes de opción múltiple, consultar resultados y obtener certificados. El frontend no usa frameworks; los datos, la autenticación y las reglas de negocio viven en [Supabase](https://supabase.com) (Postgres + Auth + Edge Functions).

**Demo en línea:** https://jcataplum.github.io/Platform/

## Ejecución

Servir la carpeta con un servidor estático (requiere conexión a internet):

```
py -m http.server 5510
```

→ http://localhost:5510

## Cuentas de demostración

| Rol | Correo | Contraseña |
|---|---|---|
| Administrador | admin@hdi.com | admin123 |
| Estudiante | estudiante@hdi.com | estudiante123 |

## Funcionalidades

- Registro, inicio y cierre de sesión con Supabase Auth (sesión persistente).
- Exámenes con preguntas de selección única o múltiple, una pregunta a la vez; cada respuesta confirmada se guarda y se bloquea.
- Máximo 3 intentos por examen; cada intento se conserva de forma individual.
- Resultados con correctas, incorrectas, porcentaje, fecha/hora y número de intento.
- Certificado con código único al obtener 90% o más (uno por usuario y examen), imprimible o guardable como PDF.
- Panel administrativo: estadísticas, CRUD de exámenes (publicar/desactivar) y CRUD de usuarios.

## Arquitectura y seguridad

- Las tablas (`profiles`, `exams`, `attempts`, `certificates`) no son accesibles directamente desde el navegador. Todo pasa por funciones RPC de Postgres que validan quién llama y aplican las reglas: límite de intentos, respuestas inmodificables, calificación y emisión de certificados en el servidor.
- Las respuestas correctas nunca se envían al estudiante mientras presenta un examen; en los resultados solo se revelan cuando obtiene el certificado o agota sus intentos.
- Los roles se asignan en el servidor: registrarse siempre crea un estudiante.
- La gestión de cuentas desde el panel admin usa la Edge Function `admin-users`, que es la única pieza con la clave `service_role`.

## Estructura

```
index.html                  Estructura semántica de la SPA
styles.css                  Estilos responsive y de impresión (colores Grupo HDI)
data.js                     Cliente Supabase: caché de lectura, Auth y operaciones (RPC)
app.js                      Enrutador, motor de examen y vistas
assets/                     Logo corporativo
supabase/migrations/        Esquema, reglas de negocio (RPC) y permisos
supabase/seed.sql           Cuentas y datos de demostración
supabase/functions/admin-users/   Edge Function para gestionar usuarios
```

El botón **Restablecer datos demo** del panel admin reemplaza exámenes, intentos y certificados por los de demostración; no modifica las cuentas de usuario.
