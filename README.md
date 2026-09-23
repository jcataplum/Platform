# Campus HDI · Plataforma educativa de exámenes

Aplicación web en HTML5, CSS3 y JavaScript vanilla para presentar exámenes de opción múltiple, consultar resultados y obtener certificados. No usa frameworks, backend ni base de datos externa: toda la información se guarda en `localStorage`.

## Ejecución

- Abrir `index.html` con doble clic, o
- Servir la carpeta con un servidor estático: `py -m http.server 5510` → http://localhost:5510

## Cuentas de demostración

| Rol | Correo | Contraseña |
|---|---|---|
| Administrador | admin@hdi.com | admin123 |
| Estudiante | estudiante@hdi.com | estudiante123 |

## Funcionalidades

- Registro, inicio y cierre de sesión (sesión persistente).
- Exámenes con preguntas de selección única o múltiple, una pregunta a la vez; cada respuesta confirmada se guarda y se bloquea.
- Máximo 3 intentos por examen; cada intento se conserva de forma individual.
- Resultados con correctas, incorrectas, porcentaje, fecha/hora y número de intento.
- Certificado con código único al obtener 90% o más (uno por usuario y examen), imprimible o guardable como PDF.
- Panel administrativo: estadísticas, CRUD de exámenes (publicar/desactivar) y CRUD de usuarios.

## Estructura

```
index.html   Estructura semántica de la SPA
styles.css   Estilos responsive y de impresión (colores Grupo HDI)
data.js      Capa de datos en localStorage y datos de demostración
app.js       Autenticación, enrutador, motor de examen y vistas
assets/      Logo corporativo
```

> Nota: las contraseñas se guardan con un hash básico solo para demostración; no constituye seguridad real.
