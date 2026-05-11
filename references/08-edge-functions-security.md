# Supabase Edge Functions — Security & Patterns

Edge Functions são Deno workers que correm na infra do Supabase. Têm acesso a env vars e podem usar `service_role`.

## Modelo mental

Uma Edge Function é o equivalente Supabase a uma API route serverless. Sem código defensivo, é um endpoint anónimo.

Hierarquia de validação:
1. **Origin/CORS** — quem pode chamar
2. **Authentication** — quem é o utilizador
3. **Authorization** — tem permissão para esta operação?
4. **Input validation** — payload é o esperado?
5. **Rate limiting** — não está a abusar?
6. **Business logic** — só então
7. **Output sanitization** — não vazar dados sensíveis na response

## Skeleton seguro

```ts
// supabase/functions/create-order/index.ts
import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const BodySchema = z.object({
  organization_id: z.string().uuid(),
  amount: z.number().positive().max(1_000_000),
  description: z.string().max(500),
})

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    if (req.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405)
    }

    // 1. Auth header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ error: 'Unauthorized' }, 401)
    }

    // 2. User client (RLS aplicada)
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: userErr } = await userClient.auth.getUser()
    if (userErr || !user) return json({ error: 'Unauthorized' }, 401)

    // 3. Parse + validate
    const parsed = BodySchema.safeParse(await req.json())
    if (!parsed.success) {
      return json({ error: 'Invalid input', details: parsed.error.flatten() }, 400)
    }
    const body = parsed.data

    // 4. Authorize against business resource
    const { data: membership, error: memErr } = await userClient
      .from('memberships')
      .select('role')
      .eq('user_id', user.id)
      .eq('organization_id', body.organization_id)
      .eq('is_active', true)
      .single()

    if (memErr || !membership) return json({ error: 'Forbidden' }, 403)
    if (!['owner','admin','member'].includes(membership.role)) {
      return json({ error: 'Forbidden' }, 403)
    }

    // 5. Business logic (usar userClient se RLS é suficiente; admin só se preciso)
    const { data: order, error: insErr } = await userClient
      .from('orders')
      .insert({
        organization_id: body.organization_id,
        amount: body.amount,
        description: body.description,
        created_by: user.id,
      })
      .select('id, created_at')
      .single()

    if (insErr) {
      console.error('insert failed', { userId: user.id, code: insErr.code })
      return json({ error: 'Internal error' }, 500)
    }

    return json({ id: order.id }, 201)
  } catch (err) {
    console.error('unhandled', err instanceof Error ? err.message : String(err))
    return json({ error: 'Internal error' }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
```

## Quando usar `service_role` numa Edge Function

Default: **usar `userClient`** com auth do user. RLS faz o trabalho.

Usar `service_role` apenas para operações que requerem bypass legítimo:
- Criar memberships antes do user ter membership (onboarding)
- Operações de admin de plataforma que ignoram RLS por design
- Backfills / migrações de dados
- Webhook handlers de provedores externos (Stripe, Resend) — não há user

E mesmo então, **após validar membership/permissão** com `userClient`:

```ts
// Validar com userClient (RLS aplicada)
const { data: caller } = await userClient.auth.getUser()
const { data: membership } = await userClient.from('memberships')...

if (!isAuthorized(membership)) return forbidden()

// Só então criar admin client
const adminClient = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
)

// Operação que precisa de bypass
await adminClient.from('audit_logs').insert(...)
```

## Webhooks externos (Stripe, etc.)

Webhooks não trazem `Authorization` do nosso user. Validar via **signature**:

```ts
import Stripe from 'npm:stripe@14'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-04-10' })
const endpointSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!

Deno.serve(async (req) => {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return new Response('no sig', { status: 400 })
  const body = await req.text()
  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, endpointSecret)
  } catch (err) {
    return new Response('invalid signature', { status: 400 })
  }

  // Idempotência: usar event.id
  // ... processar com admin client
})
```

## Secrets management

Em local dev (`supabase functions serve`), Edge Functions carregam de `supabase/.env.local`. Em produção, definir via:

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_live_xxx
supabase secrets list
supabase secrets unset OLD_VAR
```

Variáveis **sempre injetadas automaticamente**:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_URL`

Não as configures manualmente. Não as commites.

## Rate limiting

Supabase Edge Functions **não** trazem rate limiting built-in granular. Opções:

### Aplicativo (com pg + counter)
```ts
async function rateLimit(key: string, limit: number, windowSec: number) {
  const { data, error } = await adminClient.rpc('rate_limit_check', {
    bucket_key: key, max_requests: limit, window_seconds: windowSec
  })
  return !error && data === true
}
```

Função SQL:
```sql
CREATE OR REPLACE FUNCTION public.rate_limit_check(
  bucket_key text, max_requests int, window_seconds int
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE counter int;
BEGIN
  INSERT INTO public.rate_limits (key, count, window_start)
  VALUES (bucket_key, 1, now())
  ON CONFLICT (key) DO UPDATE SET
    count = CASE
      WHEN rate_limits.window_start < now() - (window_seconds || ' seconds')::interval
      THEN 1
      ELSE rate_limits.count + 1
    END,
    window_start = CASE
      WHEN rate_limits.window_start < now() - (window_seconds || ' seconds')::interval
      THEN now()
      ELSE rate_limits.window_start
    END
  RETURNING count INTO counter;
  RETURN counter <= max_requests;
END;
$$;

CREATE TABLE public.rate_limits (
  key text PRIMARY KEY,
  count int NOT NULL,
  window_start timestamptz NOT NULL
);
```

### Externo
Cloudflare Workers / Upstash / Redis em frente. Mais escalável.

## Logging — sem leak

```ts
// MAU
console.log('JWT received:', authHeader)
console.log('User data:', user)

// CERTO
console.log('request', { userId: user.id, route: 'create-order' })
```

Em Supabase, logs são acessíveis no Dashboard. Não logues secrets, JWTs, passwords, PII desnecessária.

## CORS

Para apps web:
```ts
const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',')
const origin = req.headers.get('Origin') ?? ''
const corsOrigin = allowedOrigins.includes(origin) ? origin : 'null'
```

Não usar `Access-Control-Allow-Origin: *` em produção se a função aceita auth.

## JWT inspection (custom claims)

```ts
const { data: { user } } = await userClient.auth.getUser()
// Custom claims do JWT (se hook custom_access_token_hook estiver configurado)
const claims = JSON.parse(atob(authHeader.split(' ')[1].split('.')[1]))
const currentOrg = claims.app_metadata?.current_org
```

## Função CRON / scheduled

Para tarefas agendadas, **pg_cron + Edge Function** é o padrão:

```sql
SELECT cron.schedule(
  'daily-report',
  '0 6 * * *',
  $$
    SELECT net.http_post(
      url := 'https://<project>.supabase.co/functions/v1/daily-report',
      headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_token')),
      body := '{}'::jsonb
    );
  $$
);
```

E a função verifica o token em vez de JWT de utilizador:
```ts
const token = req.headers.get('Authorization')?.replace('Bearer ','')
if (token !== Deno.env.get('CRON_TOKEN')) return new Response('unauthorized', { status: 401 })
```

## Anti-patterns

### A1. Função sem validação de auth
```ts
Deno.serve(async (req) => {
  const body = await req.json()
  await adminClient.from('orders').insert(body)
  // ← endpoint anónimo a inserir orders
})
```

### A2. service_role para ler dados do user
```ts
// MAU
const { data } = await adminClient.from('orders').select().eq('user_id', body.user_id)
// → user_id vem do request; user pode pedir qualquer um
```

### A3. Trust no payload sem validação
```ts
const body = await req.json()
await client.from('users').update(body).eq('id', user.id)
// ← user pode injetar `role: 'admin'`
```

Sempre validar com schema (Zod, Valibot, Joi).

### A4. Errors detalhados para o cliente
```ts
catch (err) {
  return new Response(JSON.stringify({ stack: err.stack, message: err.message }))
}
```
Vaza estrutura interna. Devolver mensagem genérica; log do detalhe.

### A5. CORS `*` numa função autenticada
Permite que qualquer site execute a função no contexto do user (se houver cookies de auth do projeto).

### A6. Esquecer idempotência em webhooks
Stripe pode reenviar o mesmo evento. Persistir `event.id` único antes de processar.

## Checklist por Edge Function

- [ ] Há validação de auth (`Authorization` header)?
- [ ] Usa `getUser()` (não `getSession()`)?
- [ ] Input validado com schema?
- [ ] Authorização sobre o recurso (membership/ownership)?
- [ ] `service_role` é usado apenas após validar permissões?
- [ ] CORS limitado a origins legítimos?
- [ ] Rate limiting onde aplicável?
- [ ] Erros para o cliente são genéricos; detalhes só nos logs?
- [ ] Webhooks validam signature do provider?
- [ ] Logs não contêm JWTs, passwords, PII desnecessária?
- [ ] Idempotência para webhooks?

## Comandos úteis

```bash
# Local
supabase functions serve

# Deploy
supabase functions deploy <name>

# Logs em produção
supabase functions logs <name>

# Secrets
supabase secrets set KEY=VALUE
supabase secrets list

# Invoke local com auth
curl -X POST http://127.0.0.1:54321/functions/v1/<name> \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"foo":"bar"}'
```
