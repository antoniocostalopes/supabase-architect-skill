# Template — SUPABASE_SECURITY.md

Estrutura fixa para output de auditoria de segurança (auth, storage, edge functions, secrets).

---

```markdown
# SUPABASE_SECURITY — <project_name>

> Auditoria de segurança gerada por **Supabase Architect** em <YYYY-MM-DD>.
> Escopo: Auth + Storage + Edge Functions + Secrets + Realtime authorization.

## Sumário

- **Críticos**: <n>
- **Altos**: <n>
- **Médios**: <n>

**Top 3 ações urgentes**:
1. <...>
2. <...>
3. <...>

## 1. Auth

### 1.1 Configuração (Dashboard)
| Setting | Valor atual | Recomendado | Status |
|---|---|---|---|
| Confirm email | <on/off> | on | ✅/❌ |
| Refresh Token Rotation | <on/off> | on | |
| Refresh Token Reuse Detection | <on/off> | on | |
| Min password length | <n> | ≥12 | |
| Site URL | <url> | sem localhost | |
| Redirect URLs wildcards | <yes/no> | no | |
| Rate limits (sign-up/h/IP) | <n> | conservador | |

### 1.2 Achados

#### [CRÍTICO · 95%] `service_role` exposto no bundle
- **Localização**: `.env.local:7`, `src/lib/supabase.ts:12`
- **Problema**: `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` está prefixada com `NEXT_PUBLIC_`.
- **Correção**:
  1. Rotar key no Dashboard
  2. Renomear var (sem `NEXT_PUBLIC_`)
  3. Mover usos para Edge Functions ou route handlers server-only

#### [ALTO] `getSession()` em SSR sem revalidação
- **Localização**: `middleware.ts:23`
- **Problema**: Cookie pode ser forjado; `getSession()` não revalida contra servidor.
- **Fix**:
  ```ts
  const { data: { user } } = await supabase.auth.getUser()  // não getSession()
  ```

### 1.3 Funções SECURITY DEFINER

| Função | search_path fixo | EXECUTE | Risco |
|---|---|---|---|
| public.is_member | ✅ | authenticated | OK |
| public.dangerous_fn | ❌ | PUBLIC | **Alto** |

Fix:
```sql
CREATE OR REPLACE FUNCTION public.dangerous_fn(...)
RETURNS ... LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ ... $$;
REVOKE EXECUTE ON FUNCTION public.dangerous_fn FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dangerous_fn TO authenticated;
```

## 2. Storage

### 2.1 Buckets
| Bucket | Público | Policies | Path strategy | Risco |
|---|---|---|---|---|
| avatars | sim | 3 | `<user>/file` | OK (público intencional) |
| documents | sim | 2 | sem tenant prefix | **Crítico** |
| temp_exports | não | 0 | flat | **Alto** (sem policies) |

### 2.2 Achados

#### [CRÍTICO] Bucket `documents` público com PII
- Tornar privado:
  ```sql
  UPDATE storage.buckets SET public = false WHERE id = 'documents';
  ```
- Acrescentar policies (ver `06-storage-security.md`)
- Migrar app para `createSignedUrl` em vez de `getPublicUrl`

#### [ALTO] Bucket `temp_exports` sem policies
- Activar policies path-based ou apenas service_role insert

## 3. Edge Functions

### 3.1 Inventário
| Função | Auth check | Service role | Input validation | CORS | Status |
|---|---|---|---|---|---|
| create-order | ✅ | após validar | Zod | restrito | OK |
| webhook-stripe | signature | sim | — | n/a | OK |
| send-invite | ❌ | sim | none | `*` | **Crítico** |

### 3.2 Achados

#### [CRÍTICO] `send-invite` aceita qualquer caller
- **Problema**: Sem validação de auth, qualquer um envia convites em nome de qualquer org.
- **Fix**: aplicar skeleton de `08-edge-functions-security.md`.

## 4. Secrets

### 4.1 Variáveis de ambiente
| Var | Onde aparece | Tipo | Status |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client | público (OK) | OK |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client | público (OK) | OK |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only | secreto | ✅ |
| `STRIPE_WEBHOOK_SECRET` | edge func | secreto | ✅ |

### 4.2 Verificação git history
- [ ] `git log --all -p | grep -E "(service_role|jwt_secret|sk_live_)"`
- Achados: <ficheiros>

## 5. Realtime authorization

### 5.1 Postgres Changes
| Canal | Filter server-side | RLS aplicada | Status |
|---|---|---|---|
| messages | ✅ | ✅ | OK |
| orders (global) | ❌ | parcial | **Alto** |

### 5.2 Broadcast / Presence
- `realtime.messages` tem policies? <sim / não>
- Sem policies = qualquer cliente subscreve qualquer canal.

## 6. Plano de correção

### Imediato (24h)
- [ ] Rotar service_role key
- [ ] Tornar bucket `documents` privado
- [ ] Bloquear endpoint `send-invite` ou adicionar auth check

### Curto prazo (1 semana)
- [ ] Substituir `getSession()` por `getUser()` em SSR
- [ ] Adicionar policies em `realtime.messages`
- [ ] Validar e fixar `search_path` em todas as funções SECURITY DEFINER

### Médio prazo (1 mês)
- [ ] Test suite de auth/RLS (pgTAP ou supabase-test-helpers)
- [ ] Rate limiting custom em Edge Functions críticas
- [ ] Audit logs de operações sensíveis

## Apêndice — Comandos de verificação

```bash
# Procurar service_role no bundle
grep -r "SERVICE_ROLE" src/ public/ pages/ app/ --include="*.{ts,tsx,js,jsx}"

# Procurar getSession em SSR
grep -rn "getSession()" src/ app/ middleware.ts

# Verificar variáveis públicas com nome perigoso
env | grep -E "(NEXT_PUBLIC|VITE_|PUBLIC_).*(SECRET|KEY|PASSWORD|TOKEN)"
```

```sql
-- RLS coverage gap
SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = false;

-- Buckets públicos
SELECT id, public FROM storage.buckets WHERE public = true;

-- SECURITY DEFINER sem search_path fixo
SELECT n.nspname || '.' || p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef = true
  AND n.nspname IN ('public','auth')
  AND NOT EXISTS (
    SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'
  );
```
```
