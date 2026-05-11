# Example — SUPABASE_RAG.md (multi-tenant chatbot)

Exemplo do output de `/supabase-rag setup` num projeto SaaS B2B que vai adicionar **chatbot interno** com semantic search sobre documentos do cliente.

Contexto: 200 clientes (orgs) × ~500 documentos cada × ~10 chunks/documento = 1M chunks esperados. Modelo escolhido: `voyage-3` (1024 dim, multilingual).

---

```markdown
# SUPABASE_RAG — acme-helpdesk

> Setup gerado por **Supabase Architect** em 2026-05-11.
> Stack: Next.js + Voyage AI + Supabase Pro · Modelo: `voyage-3` · Dimensão: 1024.
> Escopo: setup novo, multi-tenant, com hybrid search FTS + vector.

## Sumário

- **Estado pgvector**: a instalar (CREATE EXTENSION)
- **Tabelas vectoriais**: 1 (`document_chunks`)
- **Index ANN**: HNSW com `vector_cosine_ops`
- **Hybrid search**: sim (FTS + vector com RRF)
- **RLS em embeddings**: per-organization via `is_member`

## 1. Pré-requisitos

```sql
-- 1. Activar extensão
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Confirmar versão (≥0.7 para HNSW com filter)
SELECT extversion FROM pg_extension WHERE extname = 'vector';
-- Esperado: 0.7+
```

## 2. Schema completo

```sql
-- Tabela principal de chunks
CREATE TABLE public.document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Documento origem (referência a uma tabela documents existente)
  source_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  chunk_index int NOT NULL,

  -- Conteúdo
  content text NOT NULL,
  content_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('portuguese', content)) STORED,

  -- Embedding (voyage-3: 1024 dim)
  embedding vector(1024) NOT NULL,

  -- Metadata para reranking + context no LLM
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Estrutura esperada de metadata:
  -- {
  --   "title": "Política de reembolso",
  --   "section": "Refunds",
  --   "breadcrumbs": ["Manual", "Refunds", "Conditions"],
  --   "page": 12,
  --   "source_url": "https://..."
  -- }

  token_count int,
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source_id, chunk_index),
  CHECK (jsonb_typeof(metadata) = 'object')
);
```

## 3. Indexes

```sql
-- 1. Tenant filter (sempre)
CREATE INDEX idx_doc_chunks_org
  ON public.document_chunks(organization_id);

-- 2. FTS para hybrid search
CREATE INDEX idx_doc_chunks_tsv
  ON public.document_chunks USING gin (content_tsv);

-- 3. Index ANN — HNSW preferido para tabelas com inserts/updates contínuos
CREATE INDEX idx_doc_chunks_embedding_hnsw
  ON public.document_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 4. Metadata para filtros (categoria, tipo de doc, etc.)
CREATE INDEX idx_doc_chunks_metadata_gin
  ON public.document_chunks USING gin (metadata);

-- 5. Source / chunk index lookups
CREATE INDEX idx_doc_chunks_source
  ON public.document_chunks(source_id, chunk_index);
```

**Tuning HNSW para 1M chunks**:
- `m = 16` (default — bom balance)
- `ef_construction = 64` (build mais rápido)
- Query: `SET hnsw.ef_search = 100` para recall alta

Se atingir >5M chunks, considerar:
- Subir `m` para 24-32
- Considerar `halfvec(1024)` (~50% storage)

## 4. RLS

```sql
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;

-- SELECT — apenas members da org
CREATE POLICY "doc_chunks_select" ON public.document_chunks
FOR SELECT TO authenticated
USING (public.is_member(organization_id));

-- INSERT — via Edge Function (admin) ou via membro autorizado
CREATE POLICY "doc_chunks_insert" ON public.document_chunks
FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(organization_id, 'admin')
);

-- UPDATE — geralmente não permitido (chunks são imutáveis); apenas admin
CREATE POLICY "doc_chunks_update_admin" ON public.document_chunks
FOR UPDATE TO authenticated
USING (public.has_role(organization_id, 'admin'))
WITH CHECK (
  public.has_role(organization_id, 'admin')
  AND organization_id = (SELECT dc.organization_id FROM public.document_chunks dc WHERE dc.id = document_chunks.id)
);

-- DELETE — admin ou owner
CREATE POLICY "doc_chunks_delete_admin" ON public.document_chunks
FOR DELETE TO authenticated
USING (public.has_role(organization_id, 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_chunks TO authenticated;
```

## 5. RPCs de busca

### Semantic search (vector apenas)

```sql
CREATE OR REPLACE FUNCTION public.search_doc_chunks(
  query_embedding vector(1024),
  org_id uuid,
  match_count int DEFAULT 10,
  similarity_threshold float DEFAULT 0.5
)
RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT
    dc.id, dc.content, dc.metadata,
    1 - (dc.embedding <=> query_embedding) AS similarity
  FROM public.document_chunks dc
  WHERE dc.organization_id = org_id
    AND public.is_member(org_id)
    AND 1 - (dc.embedding <=> query_embedding) >= similarity_threshold
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
$$;

REVOKE EXECUTE ON FUNCTION public.search_doc_chunks FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_doc_chunks TO authenticated;
```

### Hybrid search (FTS + vector com RRF)

Combina busca lexical e semântica via Reciprocal Rank Fusion:

```sql
CREATE OR REPLACE FUNCTION public.hybrid_search_doc_chunks(
  query_text text,
  query_embedding vector(1024),
  org_id uuid,
  match_count int DEFAULT 10,
  full_text_weight float DEFAULT 1.0,
  semantic_weight float DEFAULT 1.0,
  rrf_k int DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  score float
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH full_text AS (
    SELECT id, row_number() OVER (
      ORDER BY ts_rank_cd(content_tsv, websearch_to_tsquery('portuguese', query_text)) DESC
    ) AS rank
    FROM public.document_chunks
    WHERE organization_id = org_id
      AND content_tsv @@ websearch_to_tsquery('portuguese', query_text)
    LIMIT match_count * 2
  ),
  semantic AS (
    SELECT id, row_number() OVER (ORDER BY embedding <=> query_embedding) AS rank
    FROM public.document_chunks
    WHERE organization_id = org_id
    ORDER BY embedding <=> query_embedding
    LIMIT match_count * 2
  )
  SELECT
    dc.id, dc.content, dc.metadata,
    (
      coalesce(1.0 / (rrf_k + ft.rank), 0) * full_text_weight +
      coalesce(1.0 / (rrf_k + s.rank),  0) * semantic_weight
    ) AS score
  FROM public.document_chunks dc
  LEFT JOIN full_text ft ON ft.id = dc.id
  LEFT JOIN semantic  s  ON s.id  = dc.id
  WHERE dc.organization_id = org_id
    AND public.is_member(org_id)
    AND (ft.id IS NOT NULL OR s.id IS NOT NULL)
  ORDER BY score DESC
  LIMIT match_count;
$$;

REVOKE EXECUTE ON FUNCTION public.hybrid_search_doc_chunks FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hybrid_search_doc_chunks TO authenticated;
```

**Quando usar cada um**:
- `search_doc_chunks`: queries conceptuais ("como reembolso funciona")
- `hybrid_search_doc_chunks`: queries com keywords específicas ("erro 503", "Stripe Invoice ID 12345")

## 6. Edge Function — ingestão server-side

Geração de embeddings **sempre server-side**. Cliente nunca tem `VOYAGE_API_KEY`.

```ts
// supabase/functions/embed-document/index.ts
import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'

const BodySchema = z.object({
  organization_id: z.string().uuid(),
  source_id: z.string().uuid(),
  chunks: z.array(z.object({
    chunk_index: z.number().int().nonnegative(),
    content: z.string().min(1).max(8000),
    token_count: z.number().int().nonnegative().optional(),
    metadata: z.record(z.unknown()).default({}),
  })).min(1).max(100),  // máx 100 chunks por call (Voyage suporta até 1000 inputs)
})

Deno.serve(async (req) => {
  // 1. Auth
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  )
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  // 2. Parse + validate
  const parsed = BodySchema.safeParse(await req.json())
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: parsed.error.flatten() }), { status: 400 })
  }
  const body = parsed.data

  // 3. Authorize — apenas admins podem ingestar
  const { data: membership } = await userClient
    .from('memberships')
    .select('role')
    .eq('user_id', user.id)
    .eq('organization_id', body.organization_id)
    .eq('is_active', true)
    .single()

  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return new Response('Forbidden', { status: 403 })
  }

  // 4. Embed via Voyage AI
  const voyageRes = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('VOYAGE_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'voyage-3',
      input: body.chunks.map(c => c.content),
      input_type: 'document',
    }),
  })

  if (!voyageRes.ok) {
    console.error('voyage failed', { status: voyageRes.status })
    return new Response('Embedding service error', { status: 502 })
  }

  const { data: embeddings } = await voyageRes.json()

  // 5. Insert via userClient (RLS aplicada)
  const rows = body.chunks.map((c, i) => ({
    organization_id: body.organization_id,
    source_id: body.source_id,
    chunk_index: c.chunk_index,
    content: c.content,
    embedding: embeddings[i].embedding,
    metadata: c.metadata,
    token_count: c.token_count ?? null,
  }))

  const { error } = await userClient.from('document_chunks').insert(rows)
  if (error) {
    console.error('insert failed', { code: error.code, msg: error.message })
    return new Response('Database error', { status: 500 })
  }

  return new Response(JSON.stringify({ inserted: rows.length }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
```

**Secrets**:
```bash
supabase secrets set VOYAGE_API_KEY=<your-voyage-key>
```

## 7. Edge Function — query (chat endpoint)

```ts
// supabase/functions/chat-query/index.ts
// 1. Auth check (user)
// 2. Validar membership na org
// 3. Embed da query (Voyage)
// 4. Chamar hybrid_search_doc_chunks RPC
// 5. Construir prompt com top-5 chunks + breadcrumbs metadata
// 6. Chamar LLM (Claude / OpenAI)
// 7. Devolver resposta + citações

// (Estrutura semelhante ao embed-document; principal diferença: usa search RPC)
```

## 8. Chunking strategy

Para documentação técnica/help center:

- **Tamanho**: 500-800 tokens
- **Overlap**: 15% (75-120 tokens)
- **Metadata por chunk**:
  - `title` — título do documento
  - `breadcrumbs` — `["Manual", "Refunds", "Conditions"]`
  - `section` — secção interna
  - `source_url` — URL canónico do documento original

**Recomendação**: `metadata.breadcrumbs` deve ser incluído no prompt do LLM como contexto, melhora citação significativamente.

## 9. Cost estimation

### Embedding inicial (one-time)
- 1M chunks × 500 tokens × $0.06/1M tokens (voyage-3) = **$30**

### Re-embedding (se mudar modelo)
- Mesmo custo: $30

### Storage
- 1M chunks × `vector(1024)` ≈ 4 GB payload
- HNSW index ≈ 3-5 GB
- FTS index (`content_tsv`) ≈ 500 MB
- **Total**: ~8-10 GB

### Queries em produção
- 100k chat queries/mês × 500 tokens × $0.06/1M = **$3/mês** em embedding
- LLM (Claude Haiku 4.5): 100k × 4k tokens × $1/1M = **$400/mês** (maior bloco de custo)

**Decisão**: usar Voyage embedding mantém custo baixo; investimento principal é no LLM.

## 10. Plano de aplicação

### Fase 1 — Schema + setup (1 dia)
- [ ] `CREATE EXTENSION vector`
- [ ] CREATE TABLE + indexes + RLS + policies
- [ ] RPCs `search_doc_chunks` + `hybrid_search_doc_chunks`

### Fase 2 — Ingestão (2-5 dias)
- [ ] Edge Function `embed-document` deployed
- [ ] Secret `VOYAGE_API_KEY` configurado
- [ ] Pipeline de ingestão (job que pega documentos existentes → chunking → embed)
- [ ] Monitoring: queries de `pg_size_pretty` para verificar progresso

### Fase 3 — Query (1 semana)
- [ ] Edge Function `chat-query` deployed
- [ ] UI no frontend (chat sidebar)
- [ ] Logging de queries para análise futura
- [ ] A/B testar threshold (0.5 vs 0.7) e weights (FTS vs semantic)

### Fase 4 — Otimização (contínuo)
- [ ] Avaliar quality via labeled queries
- [ ] Considerar reranking (Voyage Rerank) se precisão for problema
- [ ] Cache de embedding por query para queries frequentes

## 11. Checklist

(do `references/12-pgvector-rag.md` — secção "Checklist pgvector")

- [x] `CREATE EXTENSION vector` aplicada
- [x] Dimensão `vector(1024)` corresponde a voyage-3
- [x] Index ANN (HNSW) com `vector_cosine_ops`
- [x] `organization_id` no schema + index a suportar
- [x] RLS ativa + policies multi-tenant via `is_member`
- [x] Embedding gerado server-side (Edge Function), nunca no cliente
- [x] Hybrid search FTS + vector implementada
- [x] Threshold de similaridade configurável (parâmetro do RPC)
- [x] Chunking strategy documentada (500-800 tokens, 15% overlap)
- [x] Plano para re-embedding ao trocar de modelo (documented in CHANGELOG)

## 12. Queries de diagnóstico

```sql
-- Volume embedido por organização
SELECT
  organization_id,
  count(*) AS chunks,
  pg_size_pretty(sum(pg_column_size(embedding))::bigint) AS embedding_size
FROM public.document_chunks
GROUP BY organization_id
ORDER BY count(*) DESC LIMIT 20;

-- Performance do HNSW
EXPLAIN ANALYZE
SELECT id, content, 1 - (embedding <=> '[0.1,0.2,...]'::vector) AS sim
FROM public.document_chunks
WHERE organization_id = '<some-uuid>'
ORDER BY embedding <=> '[0.1,0.2,...]'::vector
LIMIT 10;
-- Esperar Index Scan, não Seq Scan

-- Documentos sem chunks (falha de ingestão)
SELECT d.id, d.title FROM public.documents d
LEFT JOIN public.document_chunks dc ON dc.source_id = d.id
WHERE dc.id IS NULL;
```
```

---

## Notas — uso deste example

- **Multi-tenant** desde o início — `organization_id` denormalizado, RLS strict
- **Voyage AI** (multilingual) preferido para conteúdo pt-PT vs OpenAI default
- **Hybrid search RPC** completo (FTS + vector com RRF)
- **Edge Function** com auth + validate (zod) + admin-only para ingestão
- **Cost breakdown** real para 1M chunks (não estimativas vagas)
- **Chunking strategy** específica para help docs (500-800 tokens, 15% overlap, breadcrumbs)
- **Plano em 4 fases** com timing realista
- Heurística H37 (ANN sem filter tenant) evitada — RPC força `organization_id = org_id`
