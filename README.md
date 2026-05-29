# MotoNuvem Mirror Worker

Worker do GitHub Actions para espelhar arquivos grandes para Pixeldrain sem estourar o timeout do Lovable Cloud.

## Arquivos

Copie estes arquivos para a raiz do repositório do worker:

- `.github/workflows/mirror.yml`
- `scripts/mirror.mjs`
- `package.json`

## Secrets do repositório no GitHub

Em **Settings → Secrets and variables → Actions → Repository secrets**, crie:

- `PIXELDRAIN_API_KEY`: sua API key do Pixeldrain.
- `CALLBACK_TOKEN`: o mesmo valor salvo no Lovable Cloud como `MIRROR_WORKER_CALLBACK_TOKEN`.

## Token usado pelo app para despachar o workflow

O secret `GITHUB_DISPATCH_TOKEN` no Lovable Cloud deve ser um Fine-grained PAT com acesso ao repositório do worker e permissões:

- **Actions: Read and write**
- **Metadata: Read**

O app usa `workflow_dispatch` no workflow `.github/workflows/mirror.yml`. Se você marcou só **Contents: Read and write**, o GitHub pode responder:

```txt
Resource not accessible by personal access token
```

## Secret do nome do repositório

No Lovable Cloud, `GITHUB_WORKER_REPO` deve estar no formato:

```txt
usuario-ou-org/nome-do-repo
```

Exemplo:

```txt
motonuvem/motonuvem-mirror-worker
```

## Teste

Depois de copiar os arquivos e configurar os secrets, vá em **Actions → mirror → Run workflow** no GitHub e confira se o workflow aparece. O app também irá disparar esse workflow automaticamente para arquivos maiores que o limite processável direto pelo Lovable Cloud.
