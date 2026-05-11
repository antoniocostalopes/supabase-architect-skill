# Encryption & Secrets — Supabase

Como proteger dados sensíveis em repouso usando Vault, `pgsodium` e patterns de column-level encryption. Crítico para compliance (PCI, HIPAA, GDPR strict) e para dados que não devem ser legíveis nem por developers com acesso à DB.

## Modelo de threat

A camada de defesa não é binária. Diferentes ameaças, diferentes proteções:

| Ameaça | Mitigação primária |
|---|---|
| SQL injection / RLS escape | RLS + grants |
| Stolen database backup | **Encryption at rest** (Supabase managed + column-level) |
| Insider acesso à DB | **Column-level encryption** (developers veem ciphertext) |
| Aplicação comprometida | Vault para keys + key rotation |
| Tokens expostos em logs | Mascarar + redact + Vault |
| Compliance (PCI/HIPAA) | Encryption obrigatório + audit |

**Disk encryption do Supabase** (transparent, AES-256) protege contra **roubo físico**. Não protege contra acesso lógico (SQL). Para isso, precisas column-level.

## Supabase Vault

Mecanismo nativo do Supabase para armazenar **secrets encriptados** dentro da DB. Usa pgsodium debaixo do capot. Cada secret é encriptado com uma master key que só o Supabase platform tem.

### Activar
```sql
CREATE EXTENSION IF NOT EXISTS supabase_vault;
```

### Inserir / actualizar secret
```sql
-- Via SQL
SELECT vault.create_secret(
  'plaintext_value',           -- valor
  'stripe_api_key',            -- name
  'Stripe production API key'  -- description
);

-- Ler ID do secret criado
SELECT id FROM vault.secrets WHERE name = 'stripe_api_key';
```

### Ler secret (decrypted)
```sql
-- View que decrypts on-the-fly (apenas para roles com permissão)
SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'stripe_api_key';
```

### Permissões
```sql
-- Por defeito, só superuser/postgres pode ler decrypted
-- Para conceder a authenticated:
GRANT SELECT ON vault.decrypted_secrets TO authenticated;

-- Mas isso é mau — em vez disso, criar função SECURITY DEFINER que valida quem pode ler
CREATE OR REPLACE FUNCTION public.get_stripe_key()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = vault, pg_temp
AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'stripe_api_key';
$$;

REVOKE EXECUTE ON FUNCTION public.get_stripe_key() FROM PUBLIC;
-- Não conceder a `authenticated` — apenas a Edge Functions / service contexts
```

### Quando usar Vault

- **API keys** que precisas em RPCs/triggers (Stripe, OpenAI, etc.)
- **Webhook secrets** referenciados de migrations
- **Tokens** rotacionáveis com escopo limitado
- **Credenciais** para Foreign Data Wrappers

### Quando NÃO usar Vault

- Secrets do **cliente** — esses ficam em `.env`, não em DB
- Secrets **per-user** — usar tabela própria com encryption coluna
- Volume alto de leituras — overhead de decrypt afeta latência

## pgsodium — libsodium para Postgres

`pgsodium` é wrapper do libsodium dentro de Postgres. Permite encryption simétrica e asimétrica diretamente em SQL.

### Activar
```sql
CREATE EXTENSION IF NOT EXISTS pgsodium;
```

### Modelos de uso

#### Modelo 1: Transparent Column Encryption (TCE) — automático

Adicionar comment seletivo a uma coluna → pgsodium encrypta/decrypta automaticamente, oferecendo view "decrypted".

```sql
CREATE TABLE public.customer_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  ssn text,
  -- key_id define que key usar; pgsodium gere o keyring
  ssn_key_id uuid NOT NULL DEFAULT (pgsodium.create_key()).id
);

-- Marcar coluna como encryptable
SECURITY LABEL FOR pgsodium ON COLUMN public.customer_records.ssn
  IS 'ENCRYPT WITH KEY COLUMN ssn_key_id';

-- Insert (plaintext)
INSERT INTO public.customer_records (organization_id, ssn) VALUES ('...', '123-45-6789');

-- A coluna `ssn` na tabela fica encrypted (lê garbage se SELECT direto)
SELECT ssn FROM public.customer_records;
-- → \xc4f3... (binary ciphertext)

-- View autogerada `customer_records_decrypted` (decrypts em SELECT)
SELECT decrypted_ssn FROM public.customer_records_decrypted;
-- → '123-45-6789'
```

**Vantagem**: app continua a escrever plaintext; encryption é transparente.

**Desvantagens**:
- Não consegues fazer `WHERE ssn = '...'` direto (precisas decrypted view)
- Indexes em coluna encryptada não fazem sentido (ciphertext é random)
- Key management ainda é teu — perder key = perder dados

### Modelo 2: Encrypt explícito em RPC

Para casos onde queres controlo total:

```sql
-- Criar key uma vez
SELECT pgsodium.create_key('aead-det', 'customer-data-key');

-- Função encrypt
CREATE OR REPLACE FUNCTION public.set_customer_ssn(p_customer_id uuid, p_ssn text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pgsodium, pg_temp
AS $$
DECLARE
  key_id uuid := (SELECT id FROM pgsodium.valid_key WHERE name = 'customer-data-key');
  encrypted_ssn bytea;
BEGIN
  -- Autoriza apenas user da org dona deste customer
  IF NOT public.is_member((SELECT organization_id FROM public.customers WHERE id = p_customer_id)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  -- Encrypt
  encrypted_ssn := pgsodium.crypto_aead_det_encrypt(
    p_ssn::bytea,
    p_customer_id::text::bytea,  -- additional data (binds ciphertext ao customer)
    key_id
  );

  UPDATE public.customers SET ssn_encrypted = encrypted_ssn WHERE id = p_customer_id;
END;
$$;

-- Função decrypt
CREATE OR REPLACE FUNCTION public.get_customer_ssn(p_customer_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pgsodium, pg_temp
AS $$
DECLARE
  key_id uuid := (SELECT id FROM pgsodium.valid_key WHERE name = 'customer-data-key');
  encrypted bytea;
  decrypted bytea;
BEGIN
  IF NOT public.has_role(
    (SELECT organization_id FROM public.customers WHERE id = p_customer_id),
    'admin'  -- só admins veem SSN, não todos os members
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT ssn_encrypted INTO encrypted FROM public.customers WHERE id = p_customer_id;
  IF encrypted IS NULL THEN RETURN NULL; END IF;

  decrypted := pgsodium.crypto_aead_det_decrypt(encrypted, p_customer_id::text::bytea, key_id);
  RETURN convert_from(decrypted, 'utf8');
END;
$$;
```

**Vantagens**:
- Audit explícito (cada read passa por RPC, logable)
- Authorização per-call
- Padrão claro sobre quem decrypts

**Desvantagens**:
- App muda de `SELECT ssn` para `SELECT public.get_customer_ssn(id)`
- Mais boilerplate

## pgcrypto — alternativa legacy

`pgcrypto` é mais antigo, vem com Postgres core, ainda usado. Não recomendado para projetos novos vs pgsodium, mas existe.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Encrypt com password
INSERT INTO secrets (data) VALUES (pgp_sym_encrypt('plaintext', 'pwd'));
-- Decrypt
SELECT pgp_sym_decrypt(data::bytea, 'pwd') FROM secrets;
```

**Problemas**:
- Password hardcoded em SQL → mal
- Sem key rotation built-in
- Algoritmos mais antigos que libsodium

Migrar para pgsodium quando possível.

## Application-level encryption

Quando queres que **nem o Supabase tenha as keys** (zero-knowledge), encryption tem de ser do lado da aplicação. A DB só vê ciphertext.

```ts
// Cliente / server da app
import { Buffer } from 'buffer'
import sodium from 'libsodium-wrappers'

await sodium.ready
const key = sodium.from_base64(process.env.APP_ENCRYPTION_KEY!)

function encrypt(plaintext: string): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key)
  return Buffer.concat([nonce, ciphertext]).toString('base64')
}

function decrypt(payload: string): string {
  const buf = Buffer.from(payload, 'base64')
  const nonce = buf.slice(0, sodium.crypto_secretbox_NONCEBYTES)
  const ct = buf.slice(sodium.crypto_secretbox_NONCEBYTES)
  return sodium.to_string(sodium.crypto_secretbox_open_easy(ct, nonce, key))
}

// Uso
await supabase.from('notes').insert({ content: encrypt('secret message') })
```

**Trade-off**: zero-knowledge mas perdes search, ordering, indexing nas colunas encrypted. Funciona bem para campos "blob" (notas, documentos, payload), mau para campos pesquisáveis.

## Patterns por caso de uso

### P1. PII regulada (SSN, CC, ID números)
- **Coluna encrypted** com pgsodium ou app-level
- **RPC** `SECURITY DEFINER` para read, com auth check + audit
- **Não indexar** (não há ganho — ciphertext é random)
- **Last-4** como coluna plaintext separada para UI (mostra `****1234`)

```sql
CREATE TABLE public.payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  cc_last4 text NOT NULL,           -- plaintext, para UI
  cc_encrypted bytea NOT NULL,      -- full PAN encrypted
  cc_token text NOT NULL UNIQUE     -- token do Stripe, melhor: não guardar PAN de todo
);
```

**Regra de PCI**: idealmente, **não armazenes PAN**. Tokeniza tudo via Stripe/etc.

### P2. Tokens de API (Google, Slack, etc. per-user)
- Colunas encrypted em tabela `user_integrations`
- Refresh tokens encrypted
- Key rotation: cada refresh pode rotar

```sql
CREATE TABLE public.user_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  access_token_encrypted bytea NOT NULL,
  refresh_token_encrypted bytea NOT NULL,
  token_key_id uuid NOT NULL DEFAULT (pgsodium.create_key()).id,
  expires_at timestamptz,
  UNIQUE (user_id, provider)
);

SECURITY LABEL FOR pgsodium ON COLUMN public.user_integrations.access_token_encrypted
  IS 'ENCRYPT WITH KEY COLUMN token_key_id';
SECURITY LABEL FOR pgsodium ON COLUMN public.user_integrations.refresh_token_encrypted
  IS 'ENCRYPT WITH KEY COLUMN token_key_id';
```

### P3. Healthcare notes (HIPAA)
- Application-level encryption (zero-knowledge)
- Key per-organization (cada cliente HIPAA tem a sua key, guardada no provedor de KMS deles)
- Audit log de **todos os reads** (lei HIPAA)

### P4. Configuração sensível por-org
- Vault para "secrets globais" do tenant
- Tabela `org_secrets` com encryption per-row se valores variam

## Key management

### Hierarquia recomendada
```
1. Master key (Supabase Vault, gerida pela platform)
   ↓
2. Per-purpose keys (uma para PII, uma para tokens, etc.)
   ↓
3. Per-row keys (opcional, para isolamento extremo)
```

### Key rotation

#### Rotação leve (mesmo algoritmo, key nova)
```sql
-- 1. Criar key nova
SELECT pgsodium.create_key('aead-det', 'customer-data-key-v2');

-- 2. Job que re-encrypta com a nova key (em batches)
-- ... loop por linhas, decrypt com v1, encrypt com v2 ...

-- 3. Marcar key antiga como invalid
UPDATE pgsodium.key SET status = 'expired' WHERE name = 'customer-data-key' AND status = 'valid';
```

#### Rotação obrigatória
- Após **compromise suspeito** (key vazada em log, GitHub, etc.)
- Após **employee turnover** com acesso a Vault
- Periodicamente (cada 12-24 meses) para boa higiene

### Backup das keys
A platform Supabase faz backup do Vault. Em self-host, **keys têm de estar replicadas** ou perdes acesso a tudo se a primary falhar.

## Hashing (não encryption)

Para tokens que **não precisam de ser lidos** (verificações de igualdade apenas):

```sql
-- Em vez de armazenar token plaintext ou encrypted:
CREATE TABLE public.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  key_hash text NOT NULL UNIQUE,  -- hex de sha256(api_key)
  key_prefix text NOT NULL,        -- "sk_live_abc" — primeiros 12 chars, para UI
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

-- Insert: cliente recebe plaintext UMA vez; DB só guarda hash
-- Verify: hash do input → comparar com key_hash

-- Função
CREATE OR REPLACE FUNCTION public.verify_api_key(p_key text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pgcrypto, pg_temp
AS $$
  UPDATE public.api_keys SET last_used_at = now()
  WHERE key_hash = encode(digest(p_key, 'sha256'), 'hex')
  RETURNING user_id;
$$;
```

**Hash > encryption** quando não precisas de ler de volta. Mais simples + mais seguro.

## Audit de encryption

```sql
-- Tabelas com colunas labeled para pgsodium
SELECT
  objname AS table_column,
  label
FROM pg_seclabel
WHERE provider = 'pgsodium';

-- Keys ativas
SELECT id, name, status, created
FROM pgsodium.valid_key
ORDER BY created DESC;

-- Vault secrets
SELECT name, description, created_at, updated_at
FROM vault.secrets;
```

## Anti-patterns

### A1. Encryption sem authentication (AEAD)
```sql
-- MAU
pgp_sym_encrypt(...)  -- sem authenticated data → tampering possível

-- BOM
pgsodium.crypto_aead_det_encrypt(plaintext, aad, key)
-- aad = "additional authenticated data" (ex: row id) — bind ciphertext ao contexto
```

### A2. Mesma key para tudo
Compromise = total breach. Pelo menos uma key por **purpose** (PII, tokens, etc.).

### A3. Keys hardcoded em código / migration
```sql
-- ERRADO
INSERT INTO secrets VALUES (pgp_sym_encrypt('data', 'mypassword123'));
```

Usar Vault ou variáveis de ambiente. **Nunca** commit de keys.

### A4. Decrypt para todos os reads
Decrypt em cada SELECT = overhead. Decryptar **só quando necessário** (apenas no fluxo que precisa do plaintext).

### A5. Sem audit log de reads
HIPAA / PCI exigem **log de quem leu o quê**. Implementar:
```sql
CREATE OR REPLACE FUNCTION public.get_customer_ssn(p_id uuid) RETURNS text ...
-- No corpo:
INSERT INTO public.pii_access_log (user_id, accessed_table, accessed_id, action, accessed_at)
VALUES (auth.uid(), 'customers.ssn', p_id, 'read', now());
```

### A6. Encryption "para mostrar" sem decrypt cuidadoso
Se o decrypt é trivial de obter (RPC pública), encryption não dá benefício real. **Authorização forte** antes do decrypt é o que importa.

### A7. Esquecer backups das keys
Self-host: keys têm de estar **replicadas** ou DR não funciona. Documentar onde estão.

### A8. Mesma encryption key entre dev e prod
Compromise em dev compromete prod. Keys distintas, mesmo que sejam para schemas idênticos.

## Compliance quick reference

| Standard | Encryption requerido |
|---|---|
| **PCI-DSS** | PAN encrypted at rest; tokens preferíveis |
| **HIPAA** | PHI encrypted at rest + in transit; audit log de reads obrigatório |
| **GDPR** | "Adequate technical measures"; pseudonymization recomendada |
| **SOC 2 Type 2** | Encryption at rest + key management documentado |
| **CCPA** | Não obrigatório explicitamente; "reasonable security" |
| **ISO 27001** | A.10.1 — encryption policy obrigatória |

## Checklist

### Setup
- [ ] Decidiste o threat model (insider vs external vs compliance)
- [ ] Identificaste colunas que requerem encryption (PII, tokens, healthcare data)
- [ ] Escolheste estratégia: Vault (secrets globais) / pgsodium TCE (auto) / pgsodium explícito (RPC) / app-level (zero-knowledge)

### Implementação
- [ ] Colunas encryptáveis marcadas com `SECURITY LABEL FOR pgsodium`
- [ ] RPCs `SECURITY DEFINER` com `search_path` fixo para acesso decryptado
- [ ] Auth check **antes** de qualquer decrypt
- [ ] Audit log de reads para dados regulados
- [ ] `cc_last4` ou equivalente para UI (não decrypts a meio de listings)

### Key management
- [ ] Plano de rotação documentado (frequência + processo)
- [ ] Keys backup verificado
- [ ] Master key não está em `.env` committed
- [ ] Keys distintas por ambiente (dev/staging/prod)

### Operacional
- [ ] Vault contém apenas secrets do servidor (não client-side)
- [ ] Tokens hashed em vez de encrypted onde só precisas verify
- [ ] No `pgp_sym_encrypt` em projetos novos — migrar para pgsodium

### Compliance
- [ ] DPA assinada com Supabase
- [ ] Audit log de PII reads existe (HIPAA/PCI)
- [ ] Encryption documentado em ISO 27001 / SOC 2 controles
- [ ] Right-to-be-forgotten implementado (GDPR)
