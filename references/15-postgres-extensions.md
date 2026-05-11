# Postgres Extensions — pg_cron, pg_net, Database Webhooks

Padrões para tarefas agendadas, HTTP-out a partir de Postgres, e eventos out-of-band em Supabase.

## pg_cron — jobs agendados

Extensão para correr SQL em schedule. Vive no schema `cron`. Pré-instalada no Supabase.

### Activar
```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant para conseguir agendar (cuidado — admin)
GRANT USAGE ON SCHEMA cron TO postgres;
```

### Sintaxe base
```sql
SELECT cron.schedule(
  '<job_name>',           -- nome único
  '<cron_expression>',    -- '0 3 * * *' = 3am daily
  $$<SQL command>$$
);

-- Listar jobs
SELECT * FROM cron.job;

-- Histórico (últimas execuções)
SELECT * FROM cron.job_run_details
ORDER BY start_time DESC LIMIT 20;

-- Apagar job
SELECT cron.unschedule('<job_name>');
```

### Cron syntax (Supabase, UTC)
| Expressão | Significado |
|---|---|
| `*/5 * * * *` | a cada 5 minutos |
| `0 * * * *` | a cada hora (ao 0) |
| `0 3 * * *` | diário às 3am UTC |
| `0 3 * * 0` | domingo às 3am UTC |
| `0 0 1 * *` | dia 1 do mês |
| `15 14 * * 1-5` | seg-sex 14:15 UTC |

Supabase suporta também syntax sub-minuto (`30 seconds` etc.) em versões recentes — verificar.

### Padrões frequentes

#### P1. Cleanup periódico
```sql
SELECT cron.schedule(
  'cleanup-expired-shares',
  '0 4 * * *',
  $$
    DELETE FROM public.share_links
    WHERE expires_at < now() - interval '30 days'
  $$
);
```

#### P2. Refresh de materialized view
```sql
SELECT cron.schedule(
  'refresh-org-stats',
  '0 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY public.org_monthly_stats$$
);
```

#### P3. Health check / alerta
```sql
CREATE OR REPLACE FUNCTION public.check_rls_coverage()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE missing_count int;
BEGIN
  SELECT count(*) INTO missing_count
  FROM pg_tables
  WHERE schemaname = 'public' AND rowsecurity = false;

  IF missing_count > 0 THEN
    -- Disparar alerta via pg_net (ver abaixo)
    PERFORM net.http_post(
      url := 'https://hooks.slack.com/...',
      body := jsonb_build_object('text', 'RLS coverage gap detected: ' || missing_count)
    );
  END IF;
END;
$$;

SELECT cron.schedule('rls-coverage-check', '0 9 * * *',
  $$SELECT public.check_rls_coverage()$$);
```

#### P4. Daily report via Edge Function
```sql
SELECT cron.schedule(
  'daily-report',
  '0 6 * * *',
  $$
    SELECT net.http_post(
      url := 'https://<project>.supabase.co/functions/v1/daily-report',
      headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_token'))
    )
  $$
);
```

### Segurança em pg_cron

- **Job corre como `postgres`** (superuser). Functions chamadas dentro **não** são re-avaliadas com RLS do user.
- **Nunca interpolar inputs** de utilizador em `cron.schedule` — só admins gerem jobs.
- **`current_setting('app.<token>')`** para passar credenciais sem hardcode no SQL:
  ```sql
  ALTER DATABASE postgres SET app.cron_token TO '<secret>';
  -- Depois `current_setting('app.cron_token')` retorna o valor
  ```

### Anti-patterns pg_cron

- A1. Agendar jobs por user — escala mal. Agendar um job que processa N users.
- A2. Jobs com lock longo num horário de tráfego alto. Sempre 2-5am UTC.
- A3. Loops dentro do job sem `LIMIT` — pode segurar lock para sempre.
- A4. Esquecer `unschedule` ao apagar feature → jobs orfãos.

## pg_net — HTTP-out de dentro do Postgres

Extensão para chamar HTTP/HTTPS via SQL. Pré-instalada no Supabase no schema `net`.

### Activar (já está)
```sql
CREATE EXTENSION IF NOT EXISTS pg_net;
```

### API base

```sql
-- POST async (fire-and-forget)
SELECT net.http_post(
  url := 'https://example.com/webhook',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ...'
  ),
  body := jsonb_build_object('event', 'created', 'data', row_to_json(...))
);

-- GET
SELECT net.http_get(url := 'https://example.com/health');

-- Retorna request_id (bigint). Resultado fica em net._http_response
```

### Inspecionar respostas

```sql
SELECT id, status_code, content, error_msg, created
FROM net._http_response
ORDER BY id DESC LIMIT 10;
```

`pg_net` é **assíncrono**. O `http_post` retorna imediatamente; a resposta chega depois. Para reagir à resposta, usar `pg_cron` para fazer polling de `net._http_response`.

### Padrões frequentes

#### P1. Trigger → webhook externo (sem Database Webhooks built-in)
```sql
CREATE OR REPLACE FUNCTION public.notify_order_paid()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'paid' AND OLD.status != 'paid' THEN
    PERFORM net.http_post(
      url := 'https://api.acme.com/orders/paid',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Webhook-Token', current_setting('app.webhook_token')
      ),
      body := to_jsonb(NEW)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_order_paid_webhook
AFTER UPDATE OF status ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.notify_order_paid();
```

#### P2. Chamar Edge Function de dentro da DB
```sql
SELECT net.http_post(
  url := 'https://<project>.supabase.co/functions/v1/process-batch',
  headers := jsonb_build_object(
    'Authorization', 'Bearer ' || current_setting('app.cron_token'),
    'Content-Type', 'application/json'
  ),
  body := '{}'::jsonb
);
```

#### P3. Health check externo periódico
```sql
SELECT cron.schedule('ping-status', '*/5 * * * *',
  $$SELECT net.http_get(url := 'https://status.acme.com/ping')$$);
```

### Segurança pg_net

- **Não chamar URLs construídos a partir de input do utilizador** — risco de SSRF.
- **Whitelisting** explícito: trigger valida que `url` está numa lista permitida.
- **Tokens** via `current_setting('app.X')`, não hardcoded.
- **Não fazer requests síncronos** (espera por resposta) em triggers — torna INSERT/UPDATE lentos.

### Limitações
- Sem support para HTTP/2 stream
- Sem retry built-in — implementar via pg_cron + retry queue table
- Timeout default ~10s
- Não suporta cancelação

## Database Webhooks (Function Hooks)

Feature nativa do Supabase. UI/API para invocar HTTP externos em INSERT/UPDATE/DELETE.

### Configuração via UI
Dashboard → Database → Webhooks → New webhook:
- **Name**: `order-paid-webhook`
- **Table**: `public.orders`
- **Events**: `UPDATE` (filtros opcionais)
- **Type**: HTTP request | Supabase Edge Function
- **HTTP target**: URL + method + headers
- **Conditions**: `OLD.status != NEW.status AND NEW.status = 'paid'`

### Por SQL (migration-versionable)

Internamente cria trigger + function. Para versionar em migration:

```sql
-- Criar a function callback
CREATE OR REPLACE FUNCTION supabase_functions.http_request(...)
RETURNS trigger AS $$ ... $$;  -- já existe em Supabase

-- Criar trigger
CREATE TRIGGER on_order_paid
AFTER UPDATE OF status ON public.orders
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'paid')
EXECUTE FUNCTION supabase_functions.http_request(
  'https://api.acme.com/orders/paid',
  'POST',
  '{"Content-Type":"application/json"}',
  '{}',
  '5000'  -- timeout ms
);
```

### Database Webhooks vs pg_net vs Realtime

| Caso | Solução |
|---|---|
| Reagir a mudanças → external API | **Database Webhooks** (UI managed) ou pg_net (SQL versionável) |
| Reagir a mudanças → cliente UI ao vivo | **Realtime** (Postgres Changes) |
| Tarefa agendada | **pg_cron** |
| Tarefa agendada que chama HTTP | **pg_cron + pg_net** ou **pg_cron + Edge Function via pg_net** |
| Stream de eventos para outro serviço | **Database Webhooks** ou **CDC externo** (Debezium etc.) |

### Padrões frequentes

#### P1. Notify CRM externo ao criar lead
```sql
CREATE TRIGGER trg_lead_notify_crm
AFTER INSERT ON public.leads
FOR EACH ROW
EXECUTE FUNCTION supabase_functions.http_request(
  'https://api.salesforce.com/leads',
  'POST',
  '{"Authorization":"Bearer xxx"}',
  '{}',
  '5000'
);
```

#### P2. Index document → search engine ao criar documento
```sql
CREATE TRIGGER trg_doc_index
AFTER INSERT OR UPDATE ON public.documents
FOR EACH ROW
EXECUTE FUNCTION supabase_functions.http_request(
  'https://search.acme.com/index',
  'POST',
  '{}', '{}', '3000'
);
```

#### P3. Trigger Edge Function por mudança
Mais robusto que HTTP externo: chama Edge Function que faz retry, validação, logging.
```sql
CREATE TRIGGER trg_user_signup_welcome
AFTER INSERT ON auth.users  -- atenção: schema auth
FOR EACH ROW
EXECUTE FUNCTION supabase_functions.http_request(
  'https://<project>.supabase.co/functions/v1/send-welcome',
  'POST',
  '{"Content-Type":"application/json"}',
  '{}', '3000'
);
```

### Segurança Database Webhooks

- **URL hardcoded** na trigger → se mudar endpoint, fazer migration.
- **Sem auth header** = qualquer um pode forjar request "from-supabase". Sempre passar `Authorization` ou shared secret.
- **Receiver deve validar** que o payload é genuinamente do Supabase (header customizado ou IP allow-list).
- **Idempotência** no receiver: pode receber a mesma mensagem 2x (retries internos).
- **Volume**: cada INSERT/UPDATE dispara request. Tabela write-heavy → muitos pedidos. Filtrar via `WHEN (...)` no trigger.

## Anti-patterns combinados

### A1. Trigger síncrono → HTTP → bloqueia INSERT
```sql
-- MAU: INSERT espera por HTTP response
CREATE TRIGGER ...
FOR EACH ROW
EXECUTE FUNCTION supabase_functions.http_request(..., '60000');  -- 60s timeout
```
Sempre usar timeouts curtos (≤5s) e tornar request async/fire-and-forget.

### A2. pg_net + waiting loop dentro de trigger
Bloqueia transação. Use `pg_cron` para "fan-out queue → workers".

### A3. Webhook payload com dados sensíveis sem encriptar
Webhook URL pode ser HTTPS mas headers / payload são visíveis em logs do receiver. Não enviar `password_hash`, tokens, PII desnecessária.

### A4. Sem retry policy
Database Webhooks têm retry interno limitado. Operações críticas: usar fila (`outbox pattern`) + worker que processa via pg_cron com retry exponencial.

### A5. Webhook fire em loop (cascading triggers)
Trigger A faz UPDATE → trigger B faz UPDATE → trigger A re-corre → loop.
Adicionar guarda:
```sql
IF NEW.updated_at = OLD.updated_at AND ... THEN RETURN NEW; END IF;
```

## Outbox pattern (recomendado para alto volume)

Em vez de webhook direto, separar **observação** de **entrega**:

```sql
-- 1. Tabela outbox
CREATE TABLE public.event_outbox (
  id bigint generated always as identity PRIMARY KEY,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  last_error text
);

CREATE INDEX idx_outbox_pending ON public.event_outbox(created_at)
  WHERE delivered_at IS NULL;

-- 2. Trigger só escreve no outbox (rápido, local)
CREATE OR REPLACE FUNCTION public.queue_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.event_outbox (topic, payload)
  VALUES (TG_TABLE_NAME || '.created', to_jsonb(NEW));
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_orders_outbox
AFTER INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.queue_event();

-- 3. Worker via pg_cron
CREATE OR REPLACE FUNCTION public.deliver_outbox()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE evt record;
BEGIN
  FOR evt IN
    SELECT * FROM public.event_outbox
    WHERE delivered_at IS NULL AND attempts < 5
    ORDER BY created_at
    LIMIT 50
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      PERFORM net.http_post(
        url := 'https://api.acme.com/events',
        body := evt.payload
      );
      UPDATE public.event_outbox
      SET delivered_at = now()
      WHERE id = evt.id;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.event_outbox
      SET attempts = attempts + 1, last_error = SQLERRM
      WHERE id = evt.id;
    END;
  END LOOP;
END;
$$;

SELECT cron.schedule('deliver-outbox', '* * * * *',
  $$SELECT public.deliver_outbox()$$);
```

Vantagens: retry built-in, observabilidade (queries em `event_outbox` mostram backlog), durável.

## Checklist extensions

- [ ] pg_cron jobs versionados em migrations (não criados via Studio)
- [ ] Jobs com nome descritivo + comentário sobre propósito
- [ ] Sem hardcoded secrets em SQL — usar `current_setting('app.X')`
- [ ] pg_net requests com whitelist de URLs em triggers
- [ ] Database Webhooks: timeout ≤5s, header de auth, idempotência no receiver
- [ ] Triggers que disparam HTTP fazem fan-out via outbox em vez de bloquear transação
- [ ] Cleanup jobs em horário de baixo tráfego (2-5am UTC)
- [ ] `cron.job_run_details` monitorizada (alertar em N falhas consecutivas)
- [ ] `net._http_response` purged periodicamente (cresce indefinidamente)
