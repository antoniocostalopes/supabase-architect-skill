---
description: Auditar Supabase Auth — service_role, JWT, sessões, providers, roles, profiles
argument-hint: [path opcional]
---

Aplica a skill **Supabase Architect** em modo Auth.

Carrega:
- `references/05-auth-security.md`
- `references/10-common-vulnerabilities.md` (V04, V11, V13)
- `references/02-multi-tenant-patterns.md` (para role/membership patterns)

Workflow:
1. Procura `service_role` exposto:
   - Grep por `NEXT_PUBLIC_.*SERVICE_ROLE`, `VITE_.*SERVICE_ROLE`, `PUBLIC_.*SERVICE_ROLE`
   - Grep por `createClient(...SERVICE_ROLE...)` em código cliente
2. Audita uso de `getSession()` vs `getUser()` em SSR
3. Verifica `@supabase/ssr` vs legacy `auth-helpers`
4. Audita middleware (refresca sessão?)
5. Audita Edge Functions / route handlers:
   - Há validação de `Authorization` header?
   - Usa userClient para RLS, ou apenas adminClient?
   - Há validação de membership antes de operações privilegiadas?
6. Audita schema:
   - `profiles` existe + trigger `handle_new_user`?
   - Funções `SECURITY DEFINER` com `search_path` fixo?
   - `EXECUTE` revogado de `PUBLIC`?
7. Audita configuração Dashboard (perguntar valores ao developer se não confirmados):
   - Confirm email, refresh rotation, reuse detection
   - Password min length, pwned check
   - Rate limits, redirect URLs, OAuth scopes

Output: `SUPABASE_SECURITY.md` (secção Auth) seguindo `templates/security.md`:
- Achados Críticos/Altos/Médios com fix copy-paste
- Tabela de funções SECURITY DEFINER com diagnóstico
- Patches em código (TypeScript) para `getUser()` e middleware
- Checklist de configuração Dashboard
- Comandos para rotar service_role e validar
