-- La plataforma ya tiene cuentas y resultados reales: se elimina la RPC que
-- permitía a un admin reemplazarlos por los datos de demostración.
-- private.seed_demo() se conserva solo para supabase/seed.sql en entornos locales.
drop function if exists public.admin_reset_demo();
