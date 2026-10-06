# Plantão de Demandas

Sistema local e simples para organizar as demandas de uma dupla.

## Como usar

1. Abra `index.html` no navegador (ou use a extensão **Live Server** no VS Code).
2. Cadastre demandas pelo botão **Nova demanda**.
3. Use a aba **Hoje** para decidir o foco imediato.
4. Marque o círculo ao concluir uma atividade.
5. Use **Depois** para visualizar o que ainda não vence hoje.
6. Abra **Relatórios** para ver gráficos de status, prioridades e distribuição entre você e Pedro.
7. Use **Exportar** para baixar um checklist TXT executivo ou um relatório Excel verdadeiro em `.xlsx`, com aba detalhada e gráficos incorporados.
8. Em cada demanda, use **Iniciar** e **Pausar** para registrar o tempo; use **Editar** para corrigir dados e **×** para excluir.
9. O popup de check-in aparece após alguns segundos e depois a cada 15 minutos enquanto houver atividade vencida ou de hoje.
10. Ao pausar, informe o motivo. Você pode iniciar outra atividade já cadastrada ou escolher **Cadastrar nova atividade**.

O cronômetro registra horas, minutos e segundos (`HH:MM:SS`). A exportação Excel usa a biblioteca ExcelJS carregada pelo navegador, portanto é necessário estar conectado à internet na primeira abertura para o botão `.xlsx` funcionar.

## Mala direta

1. Informe `Empresa` e `E-mail`.
2. Cole o texto financeiro com os campos `Vencimento`, `Título` e `Valor final`.
3. Clique em **Identificar competências**. O mês atual usa o valor de `Título`; meses anteriores usam `Valor final`.
4. Carregue o modelo `.xlsx` com as colunas `EMPRESA`, `EMAIL`, `COMP1`, `COMP2`, `COMP3`.
5. Clique em **Baixar planilha de mala direta**. As novas linhas serão acrescentadas depois das linhas já existentes no modelo.

Os relatórios aceitam as datas `De` e `Até`. O botão de exportação respeita esse período e baixa somente as demandas selecionadas.

O checklist exportado identifica cada atividade como `[PENDENTE]`, `[EM ANDAMENTO]` ou `[CONCLUÍDA]`. Uma atividade só aparece como concluída depois que o círculo de conclusão ou o botão **Sim, concluí** for acionado.

## Telas do setor

- **Plantão de Demandas**: atividades, prioridades, responsáveis, cronômetro e relatórios operacionais.
- **Mala Direta**: processamento financeiro, planilha de competências e histórico de cobranças.

Na tela **Mala Direta**, cole a página completa do sistema financeiro. O sistema identifica a `Razão Social` e todos os endereços que aparecem depois de `E-mail`, reunindo-os no campo `EMAIL` separados por vírgula. Ao baixar a planilha, a cobrança é registrada no histórico com a data do dia, empresa, e-mail, competências enviadas e quantidade acumulada de cobranças.

O nome da planilha pode ser escolhido entre o nome comercial, sem a numeração da empresa, ou a razão social completa. O e-mail `carla.vieira@appredesaude.com.br` é ignorado e endereços repetidos dentro da mesma empresa aparecem apenas uma vez. A prévia da fila exibe todas as linhas já adicionadas.

Antes de baixar, cada linha da fila pode ser revisada diretamente nos campos `EMPRESA`, `EMAIL`, `COMP1`, `COMP2` e `COMP3`. Use `↑` e `↓` para mudar a ordem ou **Excluir** para remover uma linha.

Para vencimentos anteriores ao dia atual, o sistema usa `Valor final`; para vencimentos de hoje ou futuros, usa `Título`. Um bloco que contenha somente dados financeiros não possui informação suficiente para descobrir a razão social: nesse caso, cole também o cabeçalho da empresa ou preencha o campo `Empresa` manualmente.

Os dados ficam salvos automaticamente no `localStorage` do navegador. Não é necessário instalar banco de dados ou servidor.

## Banco de dados

Para usar o banco SQLite, abra `iniciar_portal.bat`. Ele inicia o portal em `http://127.0.0.1:5500` e cria o arquivo `portal.db` na pasta do sistema. Nesse modo, demandas, fila da mala direta, histórico e treinamentos são sincronizados com o banco.

O arquivo `portal.db` pode ser copiado como backup. O endpoint `http://127.0.0.1:5500/api/backup` também permite baixar uma cópia do banco. Abrir o `index.html` diretamente continua funcionando, mas nesse modo o navegador usa apenas o `localStorage`.

No menu **Exportar**, use **Baixar backup JSON** para levar demandas, histórico, fila da mala direta e treinamentos para outro computador. No outro notebook, abra o portal e use **Restaurar backup JSON**. Esse modo funciona abrindo o `index.html` diretamente, sem instalar servidor.

## Docker

Com o Docker Desktop instalado, na pasta `Organizacao` execute:

```powershell
docker compose up -d --build
```

Abra `http://127.0.0.1:5500`. O arquivo `portal.db` da pasta é montado no container e continua persistente. Para parar o portal:

```powershell
docker compose down
```

O HTTPS continua disponível em `https://127.0.0.1:5443` quando os certificados estiverem presentes.

## Vercel + Supabase

O projeto Supabase já possui o schema inicial e a API serverless está em `api/[...path].py`. Na Vercel, configure `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` como variáveis de ambiente e publique a pasta como projeto Vercel. Para importar o estado atual do SQLite, configure essas duas variáveis localmente e execute `python migrate_to_supabase.py` uma vez.

## Atualizações recentes

- Demandas possuem categoria **Cadastro** ou **Faturamento** e registram data/hora de criação e conclusão.
- Ao concluir uma demanda, o portal emite um som curto e pode mostrar uma notificação do navegador. A permissão precisa ser autorizada pelo usuário; notificações não aparecem quando o navegador bloqueia permissões.
- Treinamentos podem ter vários fluxogramas salvos, com etapas arrastáveis e setas entre etapas.
- Os atalhos do sistema Python ficam na área de Treinamentos. Como não foram encontrados executáveis `.exe`, o portal oferece os arquivos `.bat` e `.py` para download; o Windows exige confirmação manual para executar o `.bat`.
- Os aplicativos `AUTOMAÇÃO CANCELAMENTO EM MASSA.exe`, `recibo.exe` e `Gerador de Planilhas de Importação/main.exe` também ficam disponíveis na área de atalhos. O navegador baixa os executáveis; para abrir, execute o arquivo baixado pelo Windows.

## Quadro de Planilhas

O sistema Python existente foi incorporado ao portal pela tela **Quadro de Planilhas**. Para visualizar o quadro dentro do portal:

1. Abra `sistema_planilhas (1)/webapp/iniciar_windows.bat`.
2. O servidor Flask será iniciado e o `index.html` do portal abrirá automaticamente.
3. Entre em **Quadro de Planilhas**. O sistema Python será carregado dentro do portal.

O botão de nova aba continua disponível caso o navegador bloqueie o iframe. O portal não inicia processos Python sozinho por segurança do navegador; o `.bat` é o único clique necessário para iniciar o servidor e abrir o portal.
