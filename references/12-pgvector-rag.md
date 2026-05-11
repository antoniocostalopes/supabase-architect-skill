# pgvector / RAG / IA em Supabase

Vector embeddings, semantic search, hybrid search e padrões RAG em Postgres.

## Setup

```sql
-- Activar extensão (Supabase tem pré-instalada — só precisa CREATE EXTENSION)
CREATE EXTENSION IF NOT EXISTS vector;

-- Verificar versão
SELECT extversion FROM pg_extension WHERE extname = 'vector';
-- ≥ 0.7.0 recomendado (HNSW + queries paralelas)
```

## Tipos

| Tipo | Uso |
|---|---|
| `vector(N)` | Vector denso de N dimensões, float32 |
| `halfvec(N)` | Vector denso N dimensões, float16 (~50% storage) |
| `sparsevec(N)` | Vector esparso (ex: BM25 weights) |
| `bit(N)` | Binary embeddings (binary quantization) |

### Dimensões típicas

| Modelo | Dimensões | Notas |
|---|---|---|
| OpenAI `text-embedding-3-small` | 1536 (truncável até 256) | Default. Bom custo/qualidade. |
| OpenAI `text-embedding-3-large` | 3072 (truncável) | Qualidade alta, mais caro. |
| Voyage `voyage-3` | 1024 | Forte em domain-specific. |
| Cohere `embed-v3` | 1024 | Multilingual sólido. |
| Anthropic via Voyage AI | 1024+ | Recomendado pela Anthropic. |
| Open-source (e5, bge) | 768–1024 | Auto-hospedável. |

**Regra prática**: truncar para 512–1024 dims quando possível. Memória e velocidade do index são lineares na dimensão.

## Schema base

```sql
CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,           -- id do recurso original (artigo, ficheiro)
  chunk_index int NOT NULL,          -- ordem dentro do recurso
  content text NOT NULL,
  content_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('portuguese', content)) STORED,
  embedding vector(1024) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_count int,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, chunk_index)
);

-- Indexes
-- 1. Tenant filter (sempre)
CREATE INDEX idx_documents_org ON public.documents(organization_id);

-- 2. FTS para hybrid search
CREATE INDEX idx_documents_tsv ON public.documents USING gin (content_tsv);

-- 3. ANN index (escolher HNSW ou IVFFlat — ver abaixo)
CREATE INDEX idx_documents_embedding_hnsw
  ON public.documents USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 4. Metadata frequente (se filtras por tipo, source, etc.)
CREATE INDEX idx_documents_metadata_gin ON public.documents USING gin (metadata);
```

## Distance operators

```sql
SELECT embedding <-> query_vec FROM ...     -- L2 distance (Euclidean)
SELECT embedding <=> query_vec FROM ...     -- Cosine distance (1 - similarity)
SELECT embedding <#> query_vec FROM ...     -- Negative inner product (dot product reverso)
```

**Para embeddings normalizados** (OpenAI, Cohere, Voyage): cosine e inner product são equivalentes. Usar `<=>` (mais legível) ou `<#>` (ligeiramente mais rápido).

Os indexes têm uma classe de operador específica:
- `vector_l2_ops` — para `<->`
- `vector_cosine_ops` — para `<=>`
- `vector_ip_ops` — para `<#>`

**Crítico**: o index só é usado se a query usar o mesmo operador da classe.

## HNSW vs IVFFlat — qual escolher

| Critério | HNSW | IVFFlat |
|---|---|---|
| Build time | Lento | Rápido |
| Build memory | Alto | Baixo |
| Query speed | Mais rápido | Mais lento |
| Recall (qualidade) | Mais alto | Mais baixo |
| Updates / inserts | OK (rebuild incremental) | Degrada — precisa REINDEX |
| Tabela em crescimento | **Preferir HNSW** | Evitar |
| Volume grande estático | OK | OK (mais leve) |

**Default 2026**: HNSW. Só usa IVFFlat se memória/storage forem problema.

### HNSW tuning

```sql
CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)
WITH (
  m = 16,                -- conexões por nó (16 default, subir até 32–48 para qualidade)
  ef_construction = 64   -- candidatos durante build (subir = melhor qualidade, build mais lento)
);

-- Query-time
SET hnsw.ef_search = 100;  -- candidatos por query (default 40; subir para melhor recall)
```

### IVFFlat tuning

```sql
-- Número de lists ≈ sqrt(n_rows) para até 1M; n_rows/1000 acima
CREATE INDEX ... USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

SET ivfflat.probes = 10;  -- lists a inspecionar (subir = melhor recall, mais lento)
```

## Query semântica básica

```sql
-- Top-K por similaridade cosseno, com filtro de tenant
SELECT
  id, content, metadata,
  1 - (embedding <=> $1::vector) AS similarity
FROM public.documents
WHERE organization_id = $2
ORDER BY embedding <=> $1::vector
LIMIT 10;
```

**Crítico para performance**: o filtro `organization_id = $2` é avaliado **depois** do scan do index ANN. Se a org tiver poucos chunks (ex: 200) num índice de 5M, perde-se eficiência do ANN.

### Solução: pre-filter via index

Postgres ≥17 com pgvector ≥0.7.0 suporta filtering em HNSW. Para versões anteriores ou ANN-friendly em multi-tenant grande:

**Opção A: partial indexes por tenant** (só viável com poucos tenants grandes):
```sql
CREATE INDEX idx_documents_emb_org_X
  ON public.documents USING hnsw (embedding vector_cosine_ops)
  WHERE organization_id = '<uuid-org-grande>';
```

**Opção B: aumentar `hnsw.ef_search`** para compensar:
```sql
SET LOCAL hnsw.ef_search = 200;
```

**Opção C: subset query** (recomendado para small/mid tenants):
```sql
WITH org_docs AS MATERIALIZED (
  SELECT id, embedding FROM public.documents WHERE organization_id = $2
)
SELECT d.* FROM public.documents d
JOIN (
  SELECT id FROM org_docs ORDER BY embedding <=> $1 LIMIT 10
) k ON k.id = d.id;
```

## RLS com pgvector

Mesmas regras de qualquer outra tabela. Mas **cuidado com o cost**:

```sql
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "documents_select" ON public.documents
FOR SELECT TO authenticated
USING (public.is_member(organization_id));
```

Quando a policy filtra por `organization_id`, o planner pode escolher entre:
1. Scan do HNSW e filtrar (mais rápido se hit-rate alto)
2. Filtrar org primeiro e fazer scan linear

Verificar com `EXPLAIN ANALYZE`. Se o plano usar `Seq Scan` em tabelas grandes, considerar **RPC `SECURITY DEFINER`**:

```sql
CREATE OR REPLACE FUNCTION public.search_documents(
  query_embedding vector(1024),
  org_id uuid,
  match_count int DEFAULT 10,
  similarity_threshold float DEFAULT 0.0
)
RETURNS TABLE (id uuid, content text, metadata jsonb, similarity float)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  -- Validar membership ANTES de aceder
  SELECT d.id, d.content, d.metadata,
         1 - (d.embedding <=> query_embedding) AS similarity
  FROM public.documents d
  WHERE d.organization_id = org_id
    AND public.is_member(org_id)
    AND 1 - (d.embedding <=> query_embedding) >= similarity_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
$$;

REVOKE EXECUTE ON FUNCTION public.search_documents FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_documents TO authenticated;
```

Cliente:
```ts
const { data } = await supabase.rpc('search_documents', {
  query_embedding: embedding,
  org_id: orgId,
  match_count: 10,
  similarity_threshold: 0.7,
})
```

## Hybrid search — FTS + vector (RRF)

Combinar busca lexical (FTS) com semântica (embedding) via **Reciprocal Rank Fusion**:

```sql
CREATE OR REPLACE FUNCTION public.hybrid_search(
  query_text text,
  query_embedding vector(1024),
  org_id uuid,
  match_count int DEFAULT 10,
  full_text_weight float DEFAULT 1.0,
  semantic_weight float DEFAULT 1.0,
  rrf_k int DEFAULT 50
)
RETURNS TABLE (id uuid, content text, metadata jsonb, score float)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH full_text AS (
    SELECT id, row_number() OVER (ORDER BY ts_rank_cd(content_tsv, websearch_to_tsquery('portuguese', query_text)) DESC) AS rank
    FROM public.documents
    WHERE organization_id = org_id
      AND content_tsv @@ websearch_to_tsquery('portuguese', query_text)
    LIMIT match_count * 2
  ),
  semantic AS (
    SELECT id, row_number() OVER (ORDER BY embedding <=> query_embedding) AS rank
    FROM public.documents
    WHERE organization_id = org_id
    ORDER BY embedding <=> query_embedding
    LIMIT match_count * 2
  )
  SELECT
    d.id, d.content, d.metadata,
    (coalesce(1.0 / (rrf_k + ft.rank), 0) * full_text_weight +
     coalesce(1.0 / (rrf_k + s.rank),  0) * semantic_weight) AS score
  FROM public.documents d
  LEFT JOIN full_text ft ON ft.id = d.id
  LEFT JOIN semantic  s  ON s.id  = d.id
  WHERE d.organization_id = org_id
    AND public.is_member(org_id)
    AND (ft.id IS NOT NULL OR s.id IS NOT NULL)
  ORDER BY score DESC
  LIMIT match_count;
$$;
```

Pesos típicos: `full_text_weight = 1.0`, `semantic_weight = 1.0`. Ajustar conforme tipo de query (factual → mais FTS; conceptual → mais semantic).

## Chunking strategy

A qualidade do RAG depende mais do chunking que do modelo.

| Tamanho | Quando |
|---|---|
| 200–400 tokens | Q&A factual, snippets curtos |
| 500–800 tokens | Documentos técnicos, artigos |
| 1000–1500 tokens | Long-form, contratos |
| 2000+ tokens | Raro — context loss no embedding |

**Overlap**: 10–20% entre chunks (para preservar contexto em fronteiras).

**Late chunking**: embedar documento completo e depois cortar — só viável com modelos de context longo (Voyage, Cohere). Melhora retrieval mas custa mais.

**Estrutura recomendada**:
```ts
type Chunk = {
  source_id: string
  chunk_index: number
  content: string
  token_count: number
  metadata: {
    title?: string
    section?: string
    page?: number
    breadcrumbs?: string[]   // ["doc title", "section", "subsection"]
    source_url?: string
    created_at?: string
  }
}
```

Os campos `metadata.breadcrumbs` melhoram drasticamente a qualidade quando incluídos no prompt do LLM como contexto.

## Geração de embeddings

### Padrão server-side (recomendado)

Edge Function que recebe texto, chama o provider, insere/atualiza:

```ts
// supabase/functions/embed-document/index.ts
import { createClient } from 'npm:@supabase/supabase-js@2'

Deno.serve(async (req) => {
  // 1. Auth check
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response('Unauthorized', { status: 401 })

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  )

  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  const { chunks, organization_id, source_id } = await req.json()

  // 2. Validar membership
  const { data: membership } = await userClient
    .from('memberships').select('role')
    .eq('user_id', user.id).eq('organization_id', organization_id)
    .eq('is_active', true).single()

  if (!membership) return new Response('Forbidden', { status: 403 })

  // 3. Embed em batch (OpenAI suporta até ~2048 inputs por call)
  const openaiKey = Deno.env.get('OPENAI_API_KEY')!
  const embResponse = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: chunks.map((c: any) => c.content),
      dimensions: 1024,
    }),
  })
  const { data: embeddings } = await embResponse.json()

  // 4. Insert com RLS aplicada
  const rows = chunks.map((c: any, i: number) => ({
    organization_id, source_id,
    chunk_index: c.chunk_index,
    content: c.content,
    embedding: embeddings[i].embedding,
    metadata: c.metadata,
    token_count: c.token_count,
  }))

  const { error } = await userClient.from('documents').insert(rows)
  if (error) {
    console.error('insert', { code: error.code })
    return new Response('Internal error', { status: 500 })
  }

  return new Response(JSON.stringify({ inserted: rows.length }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
```

### Anti-pattern: embed no cliente
Não envies a OPENAI_API_KEY ao browser. **Sempre server-side.**

## Cost & storage

### Storage por linha (aproximação)
- `vector(1536) float32`: ~6 KB
- `vector(1024) float32`: ~4 KB
- `vector(1024) float16` (halfvec): ~2 KB
- `vector(1024) bit` (binary): 128 bytes

Para 1M chunks com `vector(1536)`: ~6 GB de payload + HNSW index ~3–6 GB.

### Custo de embedding
- OpenAI `text-embedding-3-small`: ~$0.02 / 1M tokens
- OpenAI `text-embedding-3-large`: ~$0.13 / 1M tokens
- Voyage `voyage-3`: similar ao 3-small

**Mil documentos × 5 chunks × 500 tokens = 2.5M tokens ≈ $0.05 com `3-small`.** Cheap. O bottleneck é storage, não embedding.

### Re-embedding ao mudar de modelo
Mudar de modelo = re-embedar tudo. Estratégia:
1. Adicionar coluna `embedding_v2 vector(N)`
2. Backfill em batches
3. Migrar app para usar `embedding_v2`
4. DROP `embedding`

## Quantização (avançado)

Para reduzir storage e ganhar velocidade em escala (>10M vectors):

```sql
-- Halfvec — perde pouca recall, ~50% storage
ALTER TABLE documents ADD COLUMN embedding_half halfvec(1024);
UPDATE documents SET embedding_half = embedding::halfvec(1024);
CREATE INDEX ... USING hnsw (embedding_half halfvec_cosine_ops);

-- Binary quantization — máxima compressão, recall mais baixo
-- Usar como first-stage filter, reranking com vector full
```

## Anti-patterns

### A1. ANN sem filtro de tenant
```sql
-- BAD: retorna similar de qualquer org
SELECT * FROM documents ORDER BY embedding <=> $1 LIMIT 10;
```

### A2. Dimensão errada na tabela vs query
```sql
embedding vector(1536)
-- mas a app passa vector(1024) → erro em runtime
```
Trancar dimensão **em código** + **em CHECK constraint** se possível.

### A3. Re-embedar a cada query
```ts
const emb = await openai.embed(text)  // por cada search → caro e lento
```
Embedar a query 1 vez, reusar.

### A4. Index ANN sem operator class correto
```sql
CREATE INDEX ... USING hnsw (embedding);  -- ← faltam ops
```
Sem `vector_cosine_ops` o index é inútil para `<=>`.

### A5. Top-K demasiado pequeno
Pedir `LIMIT 3` ao retriever e enviar ao LLM = perda de recall.
- Recommended: retrieval `LIMIT 20-50` → reranking opcional (Cohere Rerank, Voyage Rerank) → top-5 para o prompt.

### A6. Confiar só em similarity score
Cosine 0.85 não é "verdade absoluta". Combinar com:
- Threshold mínimo (0.65–0.75 conforme domínio)
- Re-ranking (encoder cross-attention, melhor recall)
- Hybrid search (FTS para keyword-anchored)

## Checklist pgvector

- [ ] `CREATE EXTENSION vector` aplicada
- [ ] Dimensão da coluna corresponde ao modelo de embedding usado
- [ ] Index ANN (HNSW preferido) com operator class correta
- [ ] `organization_id` (ou tenant_id) no schema + index a suportar
- [ ] RLS ativa + policies multi-tenant
- [ ] Embedding gerado server-side (Edge Function), nunca no cliente
- [ ] Hybrid search FTS + vector implementada se há queries factuais
- [ ] Threshold de similaridade configurável (não `LIMIT 10` direto)
- [ ] Chunking strategy documentada (tamanho + overlap)
- [ ] Plano para re-embedding ao trocar de modelo

## Query diagnóstico

```sql
-- Linhas embedidas por organização
SELECT organization_id, count(*), pg_size_pretty(sum(pg_column_size(embedding))::bigint) AS total
FROM public.documents
GROUP BY organization_id
ORDER BY count(*) DESC;

-- Indexes ANN
SELECT indexrelname, indexdef
FROM pg_indexes JOIN pg_class c ON c.relname = indexname
WHERE indexdef LIKE '%hnsw%' OR indexdef LIKE '%ivfflat%';

-- Tabelas com colunas vector
SELECT n.nspname || '.' || c.relname AS table, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE a.atttypid = (SELECT oid FROM pg_type WHERE typname = 'vector')
  AND n.nspname = 'public';
```
