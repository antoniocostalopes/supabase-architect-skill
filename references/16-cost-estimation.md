# Cost Estimation — Supabase

Como dimensionar custo de um projeto Supabase ao longo das suas fases: dev → growth → scale. Foco em **metodologia e dimensões de custo**, não em preços absolutos (que mudam).

## Os 7 eixos de custo

Custo total = combinação de:

1. **Compute** — instância da base de dados (CPU + RAM)
2. **Storage** — disco da DB + Storage buckets
3. **Egress / Bandwidth** — dados transferidos para fora
4. **Auth MAU** — Monthly Active Users autenticados
5. **Realtime** — connections concorrentes + messages
6. **Edge Functions** — invocações + compute time
7. **Branching** — horas de compute de branches efémeros

Custos externos (não Supabase mas relacionados):
- **AI tokens** — embeddings (OpenAI/Voyage), LLM calls
- **CDN** — para assets servidos via Storage público
- **Email / SMS** — Resend, Twilio, etc.
- **Observability** — Sentry, Logflare external

## Plano Supabase

| Plano | Quando usar | Características |
|---|---|---|
| **Free** | Side projects, protótipos | 1 projeto activo grátis, paga uses (egress, MAU) |
| **Pro** | Projeto em produção pequeno-médio | Compute baseline incluído + branches + PITR |
| **Team** | Equipa profissional, B2B SaaS | SSO, audit logs, project transfer |
| **Enterprise** | Compliance, SLA, dedicated | Custom pricing, support 24/7 |

**Decisão chave**: salta para Pro assim que tens utilizadores reais (não confias um SLA Free a clientes pagantes). Salta para Team quando precisas SSO ou audit do dashboard.

## Estimativa por fase

### Fase 1 — Pre-launch (0-100 users)

| Eixo | Estimativa |
|---|---|
| Compute | Pro baseline incluído |
| Storage DB | <1 GB |
| Storage buckets | <1 GB |
| Egress | <50 GB/mês |
| MAU | <100 |
| Realtime | <100 connections concorrentes |
| Edge Functions | <100k invocations/mês |
| AI (se RAG) | <$5/mês embedding |

Custo típico: **Pro fixo + uses dentro do incluído**.

### Fase 2 — Growth (100-10k users)

| Eixo | Estimativa | Onde costuma rebentar |
|---|---|---|
| Compute | Pro / Team consoante carga | Realtime + queries simultâneas |
| Storage DB | 5-50 GB | jsonb não otimizado, audit logs sem retention |
| Storage buckets | 50 GB - 500 GB | Vídeos / PDFs sem cleanup |
| Egress | 100-500 GB/mês | Imagens originais sem transform |
| MAU | 1k-10k | OK |
| Realtime | 500-5k connections | Subscriptions sem filter |
| Edge Functions | 100k-1M invocations | Webhooks de Stripe/etc. |

Custo típico: Pro $25-100 + uses overage $50-300 = **$75-400/mês**.

### Fase 3 — Scale (10k-100k+ users)

Aqui o custo varia muito conforme arquitetura. Tipicamente:
- Compute upgrade (instância maior, ou Team plan)
- Read replica se queries de leitura saturarem
- CDN externo à frente do Storage público
- Considerar self-host se >$3000/mês (break-even depende muito)

## Estimativa por eixo (metodologia)

### Compute (instance size)

Sinais de subir tier:
- CPU sustentado >70%
- Memory pressure (swap)
- `max_connections` saturado (mesmo via pooler)
- IOPS limites

Estimar capacidade necessária:
```sql
-- Connections em uso
SELECT count(*), state FROM pg_stat_activity GROUP BY state;

-- Hot tables (precisam RAM)
SELECT relname, pg_size_pretty(pg_relation_size(relid)) AS size,
       seq_scan, idx_scan, n_tup_ins + n_tup_upd + n_tup_del AS writes
FROM pg_stat_user_tables WHERE schemaname = 'public'
ORDER BY pg_relation_size(relid) DESC LIMIT 10;
```

Regra prática: **shared_buffers deve cobrir indexes hot + ~30% das tabelas hot**. Se a instância tem 1GB RAM e os indexes hot somam 800MB, vais ter cache misses.

### Storage DB

Custo escala linearmente com tamanho. Otimizações:

```sql
-- Top tabelas por tamanho
SELECT
  relname,
  pg_size_pretty(pg_total_relation_size(relid)) AS total,
  pg_size_pretty(pg_relation_size(relid)) AS table_only,
  pg_size_pretty(pg_indexes_size(relid)) AS indexes
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(relid) DESC LIMIT 20;
```

Reduções típicas:
- **Cleanup periódico** de `audit_logs`, `events`, `outbox` (cron job que apaga >90 dias)
- **TOAST compression**: `ALTER TABLE x ALTER COLUMN big_jsonb SET STORAGE EXTENDED` (default; compresses)
- **Particionar** tabelas grandes (audit_logs por mês via pg_partman) — facilita drop de partições antigas
- **Materialized views** com refresh — reduz queries pesadas mas adiciona storage; trade-off
- **VACUUM FULL** ocasional em tabelas com churn (cuidado: lock)

### Storage buckets

| Tipo | Tamanho médio | Notas |
|---|---|---|
| Avatares | 50-200 KB | Comprimir + resize via transform |
| PDFs (faturas, etc.) | 100-500 KB | Não duplicar; signed URL on-demand |
| Imagens product | 500 KB - 2 MB | Servir variantes via transform |
| Vídeo curto | 5-50 MB | Considerar Mux/Cloudflare Stream (CDN custa) |
| Exports CSV | 1-100 MB | Apagar após X dias |

Custo de storage é tipicamente **baixo**. Custo de **egress** é onde rebenta — cada GET de ficheiro público conta como egress.

Mitigação:
- **CDN à frente** (Cloudflare cache em hits >85% reduz egress dramatica)
- **Image transformations** servidas via CDN
- **Signed URLs com cache headers** longos para conteúdo imutável

### Egress

Maior gerador inesperado de custo. Componentes:
- API responses (REST/PostgREST) — payload com colunas a mais (`SELECT *`)
- Storage GET de buckets públicos sem CDN
- Realtime messages (cada event replicado a N clientes)

Estimativa:
```
Egress mensal ≈ (avg response size) × (requests/mês)
             + (avg file size) × (downloads/mês)
             + (avg message size) × (subscribers × events/mês)
```

Exemplo: 100k requests/dia × 50KB avg response × 30 dias = **150 GB/mês** só REST.

Reduções:
- `SELECT col1, col2` em vez de `SELECT *` (especialmente importante se tabela tem jsonb grande)
- Pagination (não devolver listas inteiras)
- Realtime filters (cliente subscrevia tudo, agora filtra)
- gzip / brotli (PostgREST suporta; verificar Accept-Encoding)
- CDN para Storage assets

### Auth MAU

Cobrado por **Monthly Active User** distinto (login pelo menos 1x no mês).

Considerações:
- Anonymous sign-ins **contam** como MAU em alguns planos — confirmar
- Inactive users não contam
- Limite varia por plano

Otimizações:
- **Não criar anonymous** se não convertes — cada visita gera MAU
- **Cleanup de anonymous** antigos
- **Sessions longas** (1 mês) para reduzir contagem? Não — MAU é por login não por session

### Realtime

Cobrado por **concurrent connections** (peak) + **messages** (volume).

Sinais de overuse:
- Tabelas write-heavy em `supabase_realtime` publication
- Clientes subscribed sem `filter`
- `REPLICA IDENTITY FULL` em tabelas com escrita alta

Otimizações:
- Mover `audit_logs`, `events`, `telemetry` para fora da publication
- Tabela `notifications` dedicada (writes pequenos) em vez de subscrever tabelas de domínio
- Throttle / debounce no cliente para broadcast (cursores, typing)
- Granularidade de canais por escopo (`messages:doc-${docId}` vs `messages`)

### Edge Functions

Cobrado por **invocações** + **compute time** (vCPU × ms).

Reduções:
- Caching de responses no cliente
- Batching no cliente (combinar várias chamadas pequenas em uma)
- Outbox pattern em vez de Edge Function-per-event
- Evitar cold starts pesados (mantém o bundle pequeno)

### Branching

Cobrado por **branch-hours** (cada branch projeto custa enquanto está activo).

Otimizações:
- **Auto-pause** após inatividade (configurar)
- **Auto-delete** ao fechar PR
- Não criar branches longas (>7 dias) — usar staging dedicado

### AI (embeddings + LLM)

Não é custo Supabase mas crítico em projetos com RAG.

| Modelo | Custo aproximado | Quando usar |
|---|---|---|
| OpenAI `text-embedding-3-small` | ~$0.02/1M tokens | Default RAG |
| OpenAI `text-embedding-3-large` | ~$0.13/1M tokens | Alta qualidade |
| Voyage `voyage-3` | ~$0.06/1M tokens | Alternativa sólida |
| OpenAI `gpt-4o-mini` | ~$0.15 input / $0.60 output /1M | LLM barato |
| Anthropic `claude-haiku-4-5` | ~$1 input / $5 output /1M | LLM rápido + bom |
| Anthropic `claude-sonnet-4-6` | ~$3 input / $15 output /1M | LLM forte |

Estimativa de embedding:
```
N documentos × N chunks/doc × N tokens/chunk × ($/1M tokens) / 1M
```

Exemplo: 10k documents × 5 chunks × 500 tokens × $0.02 = **$0.50** total inicial.

LLM por query é o custo dominante em produção:
```
queries/mês × tokens/query × ($/1M tokens)
```

100k queries/mês × 2000 tokens × $0.20 (mini blended) = **$40/mês**.

## Patterns de redução de custo

### P1. SELECT explícito
```ts
// Custo de egress alto
.from('orders').select()  // devolve todas as colunas

// Custo reduzido
.from('orders').select('id, status, amount, created_at')
```

### P2. Cursor pagination
OFFSET grande não só é lento — devolve linhas desnecessárias para descartar. Cursor pagination só puxa o que precisas.

### P3. CDN para Storage público
```
Cloudflare → Supabase Storage
Hit rate ~85% → 6× menos egress no Supabase
```

### P4. Cleanup periódico
```sql
-- Audit logs >90 dias
SELECT cron.schedule('cleanup-audit', '0 4 * * *',
  $$DELETE FROM public.audit_logs WHERE created_at < now() - interval '90 days'$$);

-- Outbox entregue >30 dias
SELECT cron.schedule('cleanup-outbox', '0 4 * * *',
  $$DELETE FROM public.event_outbox WHERE delivered_at IS NOT NULL AND delivered_at < now() - interval '30 days'$$);

-- Temp uploads >7 dias
SELECT cron.schedule('cleanup-temp', '0 4 * * *',
  $$DELETE FROM storage.objects WHERE bucket_id = 'temp' AND created_at < now() - interval '7 days'$$);
```

### P5. Partial indexes
Reduzem storage + custo write:
```sql
CREATE INDEX idx_x_active ON x(...) WHERE deleted_at IS NULL;
-- vs index completo que indexa também linhas apagadas
```

### P6. Compressão de imagens via transform
```ts
.storage.from('avatars').getPublicUrl(path, {
  transform: { width: 400, height: 400, quality: 75 }
})
// 2MB → 60KB → 33x egress reduction
```

### P7. Outbox em vez de webhooks síncronos
Reduz cold starts e custo de invocations:
```sql
-- 1000 webhooks/min → 1 worker pg_cron processa em batch
```

### P8. Realtime granular
```ts
// MAU subscribe a tudo + filtra cliente
.channel('all-data').on('postgres_changes', { ... })

// BOM: filter server-side
.channel(`data:${orgId}`).on('postgres_changes', {
  filter: `organization_id=eq.${orgId}`
})
```

## Estimativa de custo (planilha mental)

Para qualquer projeto, perguntar:

1. **N MAU esperados** (12 meses)? × $ por MAU acima de incluído
2. **Storage DB esperado**? cleanup policy clara?
3. **Egress** estimado? CDN à frente?
4. **Realtime**: quantos canais? Quantos subscribers/canal? Write rate?
5. **Edge Functions**: quantas invocações/dia?
6. **AI**: embedar quanto? Quantas queries/mês?

Multiplica pela tabela de preços do Supabase do plano alvo.

**Heurística de orçamento inicial** para SaaS B2B:
- 100-500 MAU: $25-100/mês
- 500-5000 MAU: $100-400/mês
- 5000-50000 MAU: $400-2000/mês
- 50000+ MAU: $2000+ (revisão arquitetural recomendada)

## Anti-patterns de custo

### A1. Sem cleanup
Tabela `audit_logs` cresce indefinidamente → DB > 50GB → upgrade compute → +$200/mês

### A2. `SELECT *` em hot endpoints
Multiplica egress + latência. Identificar via Supabase Reports os endpoints com response size grande.

### A3. Realtime em tudo
Cada tabela adicionada à publication aumenta replication overhead. Realtime para colaboração ao vivo apenas.

### A4. Embedding ao cliente
Reembedar a mesma query 1000× para os mesmos resultados. **Cachear** embedding por query.

### A5. Sem CDN para Storage
Hits diretos ao Supabase Storage = egress. Cloudflare grátis reduz drasticamente.

### A6. Anonymous sign-ins sem rate limit
Spam = MAU artificial = custo. CAPTCHA + cleanup periódico.

### A7. Edge Functions monolíticas
1 função que faz tudo → cold start de toda a app → +tempo +custo. Funções dedicadas pequenas.

### A8. Logs com PII em volume
`console.log` extenso em Edge Functions sobe custo de logging e levanta compliance.

## Quando considerar self-hosting

Indicadores:
- Custo Supabase Cloud sustentado >$3000-5000/mês
- Requisitos de soberania de dados (regiões não suportadas)
- Compliance que exige controlo total (HIPAA muito stricter, government)
- Equipa com DevOps maduro

Custos a antecipar em self-host:
- Compute (RDS, GCP SQL, ou self-managed Postgres)
- Storage S3 / equivalente
- Operações: backups, monitoring, security patches, rotations
- Tempo da equipa SRE / DBA

Break-even ronda os $5000-10000/mês de Supabase Cloud. Abaixo disto, raramente vale a pena.

## Checklist de cost optimization

Periódico (mensal):

- [ ] Top 10 tabelas por tamanho — alguma cresce inesperadamente?
- [ ] Egress break-down — endpoints com response > 100KB?
- [ ] Realtime — tabelas na publication são todas necessárias?
- [ ] MAU vs registered users — anonymous spam?
- [ ] Edge Function logs — alguma a falhar e a re-correr em loop?
- [ ] Branches efémeros — quantos abertos? Auto-pause configurado?
- [ ] Cleanup jobs — `cron.job_run_details` mostra que correm?
- [ ] AI tokens — embedding cache hit rate?

## Templates de queries

```sql
-- Cleanup health check
SELECT
  (SELECT count(*) FROM public.audit_logs) AS audit_rows,
  (SELECT pg_size_pretty(pg_total_relation_size('public.audit_logs'))) AS audit_size,
  (SELECT count(*) FROM public.event_outbox WHERE delivered_at IS NOT NULL) AS outbox_done,
  (SELECT count(*) FROM storage.objects WHERE bucket_id = 'temp' AND created_at < now() - interval '7 days') AS old_temp;

-- Realtime cost indicators
SELECT pubname, schemaname, tablename,
  (SELECT n_tup_ins + n_tup_upd + n_tup_del FROM pg_stat_user_tables
   WHERE schemaname = pg_publication_tables.schemaname AND relname = pg_publication_tables.tablename) AS write_volume
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
ORDER BY write_volume DESC NULLS LAST;
```
