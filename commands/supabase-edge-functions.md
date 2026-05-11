---
description: Auditar Supabase Edge Functions — auth check, service_role, secrets, CORS, validation, rate limit
argument-hint: [função opcional]
---

Aplica a skill **Supabase Architect** em modo Edge Functions.

Carrega:
- `references/08-edge-functions-security.md`
- `references/05-auth-security.md`
- `references/10-common-vulnerabilities.md` (V04, V11)

Workflow:
1. Lista Edge Functions em `supabase/functions/*/`
2. Para cada função:
   - Verifica validação de `Authorization` header
   - Verifica uso de `getUser()` (não `getSession()`)
   - Verifica se `service_role` só é usado **após** validar permissões
   - Verifica validação de input (Zod/Valibot/Joi/manual)
   - Verifica CORS (allowed origins não `*` em endpoints autenticados)
   - Verifica logging (não loga JWT/passwords/PII)
   - Para webhooks: valida signature do provider (Stripe, etc.)
   - Verifica idempotência em webhooks
   - Verifica rate limiting (custom ou platform)
3. Verifica secrets:
   - Vars definidas via `supabase secrets set` (não commit no `.env`)
   - Logs do Supabase não contêm secrets
4. Procura no código auxiliar (chamadas client → function):
   - Existe runtime API (Node/Next route) que invoca Edge Function?
   - JWT é forwarded corretamente?

Output: `SUPABASE_SECURITY.md` (secção Edge Functions) seguindo `templates/security.md`:
- Tabela de funções com diagnóstico (auth check, service role, validation, CORS)
- Achados:
  - Funções sem auth → endpoints anónimos
  - service_role usado sem validar permissões
  - Inputs não validados (trust no payload)
  - CORS `*` em endpoint autenticado
  - Webhooks sem signature verification
  - Logs com PII/secrets
- Skeleton de função segura (TypeScript) — copy-paste pronto
- Padrão para webhooks (Stripe + outros)
- Padrão de rate limiting (SQL + uso)
- Comandos `supabase secrets` para gestão de secrets
