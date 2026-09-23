// =========================================================
// admin-users — gestión de cuentas desde el panel administrativo
//
// POST { action: 'create', name, email, password, role }
// POST { action: 'update', id, name, email, role, password? }
// POST { action: 'delete', id }
//
// Crear/editar/eliminar cuentas requiere la API admin de Auth (service
// role), que nunca debe exponerse al navegador; por eso vive aquí.
// Solo usuarios con perfil 'admin' pueden invocarla.
// =========================================================
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ROLES = ['admin', 'student'];
const MIN_PASSWORD_LENGTH = 8; // igual a "Minimum password length" de Supabase Auth

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}

async function adminCount(db: SupabaseClient) {
  const { count, error } = await db.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin');
  if (error) throw error;
  return count ?? 0;
}

function validate(name: string, email: string, role: string, password: string, requirePassword: boolean) {
  if (name.length < 3) fail(400, 'Ingresa un nombre válido.');
  if (!EMAIL_RE.test(email)) fail(400, 'Ingresa un correo válido.');
  if (!ROLES.includes(role)) fail(400, 'Rol no válido.');
  if ((requirePassword || password) && password.length < MIN_PASSWORD_LENGTH) {
    fail(400, `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
}

function authError(error: { code?: string; message: string }): never {
  if (error.code === 'email_exists' || /already (been )?registered/i.test(error.message)) {
    fail(409, 'Ese correo ya está registrado.');
  }
  fail(400, error.message);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);

  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: { user: caller } } = await db.auth.getUser(token);
    if (!caller) fail(401, 'Debes iniciar sesión.');
    const { data: me } = await db.from('profiles').select('role').eq('id', caller.id).maybeSingle();
    if (me?.role !== 'admin') fail(403, 'Solo los administradores pueden gestionar usuarios.');

    const body = await req.json().catch(() => ({}));
    const name = String(body.name ?? '').trim();
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    let role = String(body.role ?? 'student');

    switch (body.action) {
      case 'create': {
        validate(name, email, role, password, true);
        const { data, error } = await db.auth.admin.createUser({
          email, password, email_confirm: true, user_metadata: { name },
        });
        if (error) authError(error);
        // el trigger crea el perfil como 'student'; aquí se fija nombre y rol reales
        const { error: pErr } = await db.from('profiles').update({ name, role }).eq('id', data.user.id);
        if (pErr) throw pErr;
        return json({ id: data.user.id });
      }

      case 'update': {
        const id = String(body.id ?? '');
        const { data: target } = await db.from('profiles').select('id, email, role').eq('id', id).maybeSingle();
        if (!target) fail(404, 'Usuario no encontrado.');
        if (id === caller.id) role = target.role; // nadie cambia su propio rol
        validate(name, email, role, password, false);
        if (target.role === 'admin' && role !== 'admin' && (await adminCount(db)) <= 1) {
          fail(400, 'Debe existir al menos un administrador.');
        }

        const changes: { email?: string; password?: string; email_confirm?: boolean } = {};
        if (email !== target.email) { changes.email = email; changes.email_confirm = true; }
        if (password) changes.password = password;
        if (Object.keys(changes).length) {
          const { error } = await db.auth.admin.updateUserById(id, changes);
          if (error) authError(error);
        }
        // el correo del perfil se sincroniza por trigger; el nombre del certificado también
        const { error: pErr } = await db.from('profiles').update({ name, role }).eq('id', id);
        if (pErr) throw pErr;
        return json({ id });
      }

      case 'delete': {
        const id = String(body.id ?? '');
        if (id === caller.id) fail(400, 'No puedes eliminar tu propia cuenta.');
        const { data: target } = await db.from('profiles').select('role').eq('id', id).maybeSingle();
        if (!target) fail(404, 'Usuario no encontrado.');
        if (target.role === 'admin' && (await adminCount(db)) <= 1) {
          fail(400, 'Debe existir al menos un administrador.');
        }
        // on delete cascade elimina perfil, intentos y certificados
        const { error } = await db.auth.admin.deleteUser(id);
        if (error) throw error;
        return json({ id });
      }

      default:
        fail(400, 'Acción no válida.');
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Error interno del servidor.' }, 500);
  }
});
