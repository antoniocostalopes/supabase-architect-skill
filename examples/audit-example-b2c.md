# Example — SUPABASE_AUDIT.md (B2C user-as-tenant)

Exemplo few-shot para app B2C onde **o tenant é o próprio user** (sem organizations). Padrões: workspaces pessoais, sharing por convite, presets/templates partilháveis, profiles públicos vs privados.

---

```markdown
# SUPABASE_AUDIT — pocket-journal

> Auditoria gerada por **Supabase Architect** em 2026-05-11.
> Stack: Expo + Next.js web · Supabase project: `pjlx456`.
> Modelo: user-as-tenant (cada user tem o seu workspace pessoal; sharing opcional via tokens).

## Sumário

- **Score**: 67 / 100 — Pre-produção avançada
- **Críticos**: 1 · **Altos**: 4 · **Médios**: 7 · **Baixos**: 3

## Modelo de dados

Sem `organizations`. Cada user tem o seu cantinho:

```
auth.users
    │
    ├──1:1── public.profiles
    │
    ├──1:N── public.journals
    │            │
    │            └──1:N── public.entries
    │
    └──1:N── public.share_links (recurso → token público)
                  │
                  └──> consumido por user_id (autenticação anónima ou nova conta)
```

**Princípio**: policies baseadas em `created_by = auth.uid()`. Sharing introduz exceções controladas.

## Achados destacados (únicos do domínio)

### [CRÍTICO · 95%] Profiles expõem email para qualquer authenticated

- **Localização**: `pg_policies` → `profiles_select`
- **Problema atual**:
  ```sql
  CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT TO authenticated USING (true);
  ```
- **Impacto**: Apps consumer não devem expor emails para enumeração. User A pode listar todos os utilizadores via `SELECT email FROM profiles`.
- **Fix**: Separar campos públicos e privados em colunas, e expor view pública:
  ```sql
  -- Colunas privadas só para o próprio
  CREATE POLICY "profiles_select_self_full" ON public.profiles
  FOR SELECT TO authenticated USING (id = auth.uid());

  -- View pública sem campos sensíveis
  CREATE VIEW public.profiles_public AS
  SELECT id, username, display_name, avatar_url, bio
  FROM public.profiles
  WHERE is_public = true;

  GRANT SELECT ON public.profiles_public TO anon, authenticated;
  ```

### [ALTO · 90%] Share links nunca expiram + permission não restritiva

- **Problema**: `share_links` tabela tem `token` mas `expires_at NULL` permitido e `permission = 'edit'` por defeito.
- **Fix**:
  ```sql
  ALTER TABLE public.share_links
    ALTER COLUMN expires_at SET NOT NULL,
    ALTER COLUMN expires_at SET DEFAULT now() + interval '7 days',
    ALTER COLUMN permission SET DEFAULT 'view';

  CREATE INDEX idx_share_links_token_active
    ON public.share_links(token)
    WHERE expires_at > now();

  -- Cleanup automático de tokens expirados
  SELECT cron.schedule(
    'cleanup-expired-shares',
    '0 4 * * *',
    $$DELETE FROM public.share_links WHERE expires_at < now() - interval '30 days'$$
  );
  ```

### [ALTO · 85%] Consumir share link via RPC sem rate limit

- **Problema**: Endpoint `/api/share/[token]` valida token mas sem rate limit. Brute-force de tokens de 8 chars é trivial.
- **Fix combinado**:
  1. Tokens com entropia alta (UUID v4 ou 32 bytes random base64).
  2. Rate limiting per-IP no endpoint.
  3. Audit de tentativas falhadas:
  ```sql
  CREATE TABLE public.share_link_attempts (
    id bigint generated always as identity PRIMARY KEY,
    token_attempted text NOT NULL,
    ip inet,
    succeeded boolean NOT NULL,
    attempted_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX idx_share_attempts_ip_time
    ON public.share_link_attempts(ip, attempted_at DESC)
    WHERE succeeded = false;
  ```

### [ALTO · 80%] Sync mobile + web — last-write-wins sem audit

- **Problema**: Expo offline + web online → user edita `entries` em ambos. Sem `updated_at + version`, mudanças silenciosamente sobrescritas.
- **Fix optimistic locking**:
  ```sql
  ALTER TABLE public.entries ADD COLUMN version int NOT NULL DEFAULT 1;

  CREATE OR REPLACE FUNCTION public.update_entry_optimistic(
    entry_id uuid,
    expected_version int,
    new_content text
  ) RETURNS public.entries
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE updated_row public.entries;
  BEGIN
    UPDATE public.entries
    SET content = new_content,
        version = version + 1,
        updated_at = now()
    WHERE id = entry_id
      AND created_by = auth.uid()
      AND version = expected_version
    RETURNING * INTO updated_row;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'conflict_or_not_found' USING ERRCODE = 'P0001';
    END IF;
    RETURN updated_row;
  END;
  $$;
  ```
  Cliente apanha o erro → mostra UI de "merge conflict".

### [MÉDIO] Storage `avatars` bucket público sem path sanitization
Padrão B2C clássico. Fix em `references/06-storage-security.md`.

## Plano

### Fase 1 (48h)
- [ ] Restringir `profiles_select` + criar view `profiles_public`
- [ ] Endurecer `share_links` (default 7d, permission view)
- [ ] Adicionar rate limit + audit em consumo de tokens

### Fase 2 (1 semana)
- [ ] Optimistic locking em `entries` (Expo offline)
- [ ] Cleanup `share_links` via pg_cron
- [ ] Storage path sanitization no Expo client

### Fase 3 (1 mês)
- [ ] GDPR export/delete RPCs
- [ ] Anonymous sign-in para "try before sign-up"
```

---

## Notas — padrões únicos B2C

- **Sem `organization_id`**: ownership é direto via `created_by = auth.uid()`.
- **Profiles públicos vs privados**: separar via colunas + view, não via duas tabelas (1:1 com auth.users já é forte).
- **Share tokens** introduzem auth out-of-band — exigem TTL obrigatório e rate limit.
- **Sync offline (mobile + web)** força optimistic concurrency control. Cliente passa `version` esperada; servidor incrementa atomically.
- **GDPR** mais saliente que em B2B: cada user é dono total dos seus dados; export/delete tem de ser self-service.
- **Anonymous sign-ins** úteis para reduzir friction inicial — converter quando user decide criar conta.
