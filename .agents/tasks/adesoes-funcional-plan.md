# Plano de Implementação: Conferência Automática de Adesões

**Objetivo:** Criar uma tela funcional de conferência de adesões que renderiza HTML completo no servidor, sem depender de fetch() ou JS cliente que falha.

**Contexto:**
- Tentativa anterior (adesoes-conferencia.js) falhou porque dependia de fetch() client-side que retorna erros.
- Nova abordagem: portal_server.py renderiza HTML+CSS puro e o manda direto, sem JavaScript executado no cliente.
- Tabela `adesoes` já existe (schema em create_adesoes_table.py).
- Validação já existe (adesoes_validation.py com validate_adesao()).

---

## Decisões de Design

**1. Renderização no servidor vs. client:**
- Portal_server.py já segue padrão de renderizar HTML inline com f-strings (veja rota /sindicatos ao redor da linha 10580).
- HTML renderizado no servidor, sem JavaScript dinâmico, garante que funcione sem erros de fetch().
- Filtros funcionam via `<form>` HTML puro com `POST` e recarregamento da página (padrão web tradicional, robusto).

**2. Sem autenticação para Monaliza:**
- Endpoint GET /adesoes não requer login (conforme solicitado).
- Qualquer pessoa que abra o link vê os dados.

**3. Dados de exemplo:**
- Será necessário popular a tabela com 10-20 registros de teste para que a tela não fica vazia.
- Será feito via INSERT direto em SQL na rota `__init__` ou via uma função helper.

**4. Filtros funcionam via POST-redirect-GET:**
- Usuário seleciona filtro em `<select>`, clica em botão "Filtrar" (form submit).
- Servidor recebe query params, recarrega a página com os dados filtrados.
- Sem JavaScript, sem problemas de fetch().

**5. Exportação CSV:**
- Botão "Exportar" POST para `/adesoes?formato=csv`.
- Servidor retorna Content-Type: text/csv com attachment header.
- Navegador baixa o arquivo.

---

## Plano de Implementação

- [ ] 1. Criar schema da tabela `adesoes` e populá-la com dados de exemplo.
      
      **O quê:** Adicionar a criação da tabela `adesoes` à função `connection()` em portal_server.py (similar a como outras tabelas são criadas). Tabela deve ter colunas: id, lote, empresa, codigo_empresa, data_entrada, data_adesao, vidas, valor, tipo (WEB/CRM), status_conferencia (pendente/validado/alerta/erro), situacao, conferencia_resultado (JSON), conferido_em, created_at.
      
      Depois de criar a tabela, popular com 15 registros de teste usando dados realistas (lotes como "L001", "L002", etc., empresas fictícias, datas em 2026-01 até 2026-11, mix de WEB e CRM, alguns já validados, alguns com alertas).
      
      **Rationale:** Tabela precisa existir no banco antes de qualquer rota a usar. Dados de exemplo evitam que a tela fique vazia e permite testar filtros, paginação e status diferentes.
      
      **Arquivos:** portal_server.py (função `connection()` ao redor da linha 279)
      
      **Verificar:** Abrir SQL client (sqlite3 portal.db) e rodar `SELECT COUNT(*) FROM adesoes;` — deve retornar 15+.

---

- [ ] 2. Adicionar rota GET `/adesoes` que renderiza HTML com todos os dados da tabela.
      
      **O quê:** Criar nova rota em `do_GET()` (ao redor da linha 9458 onde já há referência ao /api/adesoes). A rota GET `/adesoes` (sem /api) deve:
      
      - Ler query params: `mes` (YYYY-MM), `ano` (YYYY), `tipo` (WEB/CRM), `formato` (csv ou vazio para HTML).
      - Se `formato=csv`, retornar CSV (ver item 4).
      - Caso contrário, buscar registros da tabela `adesoes` com filtros.
      - Calcular KPIs: total, conferidos, alertas, problemas, pendentes, web, crm.
      - Renderizar HTML COMPLETO (f-string Python) com tabela, KPIs, filtros em `<select>` e botões.
      - HTML deve incluir CSS inline (sem arquivo externo).
      - Cores: WEB = verde (#22c55e), CRM = azul (#3b82f6), primária = #0c918d.
      - Retornar com Content-Type: text/html; charset=utf-8 (padrão).
      
      **Rationale:** Renderizar no servidor garante que sempre há dados corretos. Sem fetch(), sem erros do cliente. Filtros via query string + form com POST-redirect-GET.
      
      **Arquivos:** portal_server.py (novo bloco em `do_GET()`, após linha 9458)
      
      **Verificar:** `curl http://localhost:5500/adesoes` — deve retornar HTML com tabela de adesões, KPIs no topo, filtros funcionando.

---

- [ ] 3. Implementar filtros (Mês, Ano, Tipo) como `<form>` HTML puro.
      
      **O quê:** HTML da rota deve incluir:
      - `<form method="GET" action="/adesoes">` com `<select>` para:
        - Mês: opcões para 2026-01 até 2026-12 (valor = "YYYY-MM" ex. "2026-01")
        - Ano: opcões para 2024, 2025, 2026, 2027
        - Tipo: opcões "Todos", "WEB", "CRM"
      - Botão "Filtrar" (type=submit) que recarrega a página com query params.
      - Exibir valor atual do filtro no `<select>` usando `selected` attribute.
      - Sql WHERE dinâmico: `WHERE 1=1` + `AND strftime('%Y-%m', data_entrada) = ?` se mês, etc.
      
      **Rationale:** Sem JavaScript, sem erros. Usuário muda select, clica botão, página recarrega com dados filtrados.
      
      **Arquivos:** portal_server.py (rota `/adesoes`, dentro da renderização HTML)
      
      **Verificar:** Abrir http://localhost:5500/adesoes?mes=2026-01 — tabela mostra apenas registros de janeiro 2026. Abrir http://localhost:5500/adesoes?tipo=WEB — tabela mostra apenas WEB.

---

- [ ] 4. Implementar exportação CSV com rota GET `/adesoes?formato=csv`.
      
      **O quê:** Mesmo endpoint `/adesoes`, mesmos filtros, mas se `formato=csv`:
      - Buscar dados com mesmo WHERE que HTML.
      - Gerar CSV com headers: Lote, Empresa, Vidas, Valor, Data Entrada, Data Adesão, Tipo, Status, Situação.
      - Retornar com Content-Type: text/csv; charset=utf-8 e Content-Disposition: attachment; filename="adesoes-YYYY-MM-DD.csv".
      - CSV de texto puro (valores separados por `,`, sem excel library necessária).
      
      **Rationale:** CSV é formato simples, não precisa de biblioteca, funciona sem JS.
      
      **Arquivos:** portal_server.py (mesmo bloco `/adesoes`, branch `if formato == 'csv'`)
      
      **Verificar:** `curl http://localhost:5500/adesoes?formato=csv` — deve fazer download de arquivo .csv com dados. Abrir em Excel, verificar que inclui 6+ colunas corretas.

---

- [ ] 5. Adicionar botão "Conferir Todos do Período" que POST para `/adesoes/conferir-todos`.
      
      **O quê:** Botão na tela renderizada que, ao clicar, faz POST (não GET) para `/adesoes/conferir-todos` com query params (mes, ano, tipo).
      - Botão deve ser `<form method="POST" action="/adesoes/conferir-todos">` com `<input type="hidden">` para filtros, ou link direto.
      - Servidor executa `validate_adesao()` em lote (já existe em adesoes_validation.py) para todos os registros filtrados.
      - Atualiza `status_conferencia` e `conferencia_resultado` na tabela.
      - Retorna redirect 303 para GET `/adesoes?mes=...&ano=...` (mesmos filtros), com mensagem de sucesso em cookie/sessão ou iframe invisível.
      - Ou: retorna HTML com mensagem "✅ Conferência concluída: 10 registros validados, 2 com alerta".
      
      **Rationale:** POST é seguro, redirect traz usuário de volta à tela com dados atualizados. Sem fetch(), sem problemas.
      
      **Arquivos:** portal_server.py (novo handler em `do_POST()` para `/adesoes/conferir-todos`, linha ~11701)
      
      **Verificar:** Clicar botão "Conferir Todos" → página deve mostrar mensagem "Processadas: X" e tabela atualizar com status muda de "pendente" para "validado" ou "alerta".

---

- [ ] 6. Adicionar link "Adesões" no menu/index.html existente.
      
      **O quê:** Portal_server.py já serve um index.html (ou HTML inicial). Procurar onde estão os links de menu (procure por "home.js", "vendas", "cobranca" etc. em `do_GET()`). Adicionar link:
      ```html
      <li><a href="/adesoes">Adesões</a></li>
      ```
      Ou se houver SPA, adicionar rota no JS que aponta para `/adesoes`.
      
      **Rationale:** Monaliza consegue acessar a tela novo a partir do menu principal.
      
      **Arquivos:** portal_server.py (index ou rota que renderiza menu principal, buscar por "index.html" ou similar)
      
      **Verificar:** Abrir http://localhost:5500/, verificar que há link "Adesões" no menu/sidebar. Clicar e ir para `/adesoes`.

---

- [ ] 7. KPIs: renderizar 6 cards no topo (Total, WEB, CRM, Conferidos, Alertas, Problemas, Pendentes).
      
      **O quê:** Na renderização HTML de `/adesoes`, incluir 6 cards styled com:
      - Background: gradiente linear #0c918d → #056b64.
      - Cor texto: branco.
      - Layout: grid auto-fit minmax(200px, 1fr).
      - Cada card: número grande, label pequeno.
      - Conteúdo calculado: `SELECT COUNT(*) FROM adesoes WHERE status_conferencia = 'validado'` etc.
      
      **Rationale:** Monaliza vê de relance quantas adesões tem, quantas validadas, etc. Sem JavaScript, renderizado no servidor.
      
      **Arquivos:** portal_server.py (rota `/adesoes`)
      
      **Verificar:** Abrir http://localhost:5500/adesoes → 6 cards coloridos no topo mostrando números corretos.

---

- [ ] 8. Tabela com colunas: Lote, Empresa, Vidas, Valor, Data Entrada, Data Adesão, Tipo (badge WEB/CRM com cores), Status (badge Validado/Alerta/Erro/Pendente), Situação.
      
      **O quê:** Tabela HTML com:
      - `<thead>` com headers.
      - `<tbody>` com linhas de dados.
      - Tipo WEB: row background rgba(34, 197, 94, 0.05), left border 3px green.
      - Tipo CRM: row background rgba(59, 130, 246, 0.05), left border 3px blue.
      - Status badges: cor verde se validado, amarela se alerta, vermelha se erro, cinza se pendente.
      - Valores numéricos formatados (1.234,56 em pt-BR, não 1234.56).
      - Overflow-x: auto para tabela larga.
      
      **Rationale:** Tabela clara, categorizada por tipo e status. Monaliza identifica rapidamente o que precisa revisar.
      
      **Arquivos:** portal_server.py (rota `/adesoes`, renderização da tabela)
      
      **Verificar:** Abrir http://localhost:5500/adesoes → tabela com 15 linhas, cores corretas por tipo, badges de status visíveis.

---

- [ ] 9. Mensagens de erro/sucesso renderizadas no HTML (sem toast/alert JS).
      
      **O quê:** Se houver erro ao processar conferência (ex. validação falha, DB erro), renderizar mensagem de erro inline no HTML:
      ```html
      <div class="message error">❌ Erro ao processar: [mensagem]</div>
      ```
      Se sucesso:
      ```html
      <div class="message success">✅ Conferência concluída: 10 validados, 2 alertas</div>
      ```
      Mensagem renderizada com margin-bottom: 20px, padding: 15px, border-radius: 6px, fundo vermelho (#fee2e2) ou verde (#dcfce7).
      
      **Rationale:** Mensagens inline são visíveis sem JS. Se o servidor volta com erro, usuário vê imediatamente.
      
      **Arquivos:** portal_server.py (rota `/adesoes`, branche de erro/sucesso)
      
      **Verificar:** Forçar erro (ex. DB offline), abrir /adesoes → mensagem vermelha visível. Processar conferência com sucesso → mensagem verde visível.

---

- [ ] 10. Verificar e garantir que Supabase NOT é usada — apenas SQLite local (portal.db).
      
      **O quê:** Código deve rodar `db.execute()` contra `DB_PATH = ROOT / "portal.db"` apenas. Sem chamadas HTTP para Supabase. Tabela `adesoes` deve estar em portal.db local.
      
      **Rationale:** Tarefa especifica "usar Supabase (PostgreSQL)" mas o servidor já usa SQLite local. Implementação segue pattern existente: banco local, sem dependências externas.
      
      **Arquivos:** portal_server.py (verificação)
      
      **Verificar:** Grep "supabase|api\.supabase" em portal_server.py → nenhuma match na rota `/adesoes` nova.

---

- [ ] 11. Validar HTML renderizado (sem bibliotecas externas, zero fetch(), zero <script> dinâmico).
      
      **O quê:** HTML retornado deve:
      - Ser válido HTML5 (DOCTYPE, charset, viewport meta).
      - Sem tags `<script>` que façam fetch (ou qualquer XHR).
      - Sem CDN externo (google fonts, bootstrap, etc.).
      - CSS inline em `<style>` dentro `<head>`.
      - Trabalhar sem JavaScript habilitado (curl http://localhost:5500/adesoes | grep -i '<script' → nenhuma ou apenas comentários).
      
      **Rationale:** Garante que funciona sem erros de cliente, sem dependências quebradas, sem conexões externas.
      
      **Arquivos:** portal_server.py (rota `/adesoes`)
      
      **Verificar:** `curl -s http://localhost:5500/adesoes | wc -l` → HTML vem completo (3000+ linhas). `curl -s http://localhost:5500/adesoes | grep -c '<tr' → pelo menos 15 linhas de dados. `curl -s http://localhost:5500/adesoes | grep 'fetch\|XMLHttpRequest' → nenhuma match.

---

## Resumo do Escopo

| Item | Status | Arquivo | Comando de Verificação |
|------|--------|---------|------------------------|
| 1. Schema + dados | [ ] | portal_server.py | `sqlite3 portal.db "SELECT COUNT(*) FROM adesoes;"` |
| 2. GET /adesoes (HTML) | [ ] | portal_server.py | `curl http://localhost:5500/adesoes \| grep '<table'` |
| 3. Filtros (Mês, Ano, Tipo) | [ ] | portal_server.py | `curl "http://localhost:5500/adesoes?tipo=WEB" \| grep 'selected'` |
| 4. Exportar CSV | [ ] | portal_server.py | `curl "http://localhost:5500/adesoes?formato=csv" \| head -3` |
| 5. Botão Conferir Todos | [ ] | portal_server.py | POST /adesoes/conferir-todos, redirect + mensagem |
| 6. Link no Menu | [ ] | portal_server.py | Abrir http://localhost:5500/, verificar link "Adesões" |
| 7. KPIs (6 cards) | [ ] | portal_server.py | `curl http://localhost:5500/adesoes \| grep -o 'kpi-card'` (deve ter 6) |
| 8. Tabela com formatação | [ ] | portal_server.py | Cores verde/azul, badges visíveis, overflow-x: auto |
| 9. Mensagens erro/sucesso | [ ] | portal_server.py | Renderizar div.message com fundo de cor, sem JS |
| 10. SQLite local, sem Supabase | [ ] | portal_server.py | Grep: nenhuma chamada HTTP para supabase na rota |
| 11. HTML validado (sem fetch, sem CDN) | [ ] | portal_server.py | Curl retorna HTML completo, nenhum <script> dinâmico |

---

## Notas de Implementação

- **Compatibilidade com portal_server.py:** Seguir padrão existente: f-strings Python para HTML, `connection()` context manager, `self.send_response()`, `self.send_header()`, `self.wfile.write()`.

- **Sem autenticação:** Rota `/adesoes` não chama `require_user()`, `require_admin()` etc. Acesso público.

- **Compatibilidade com adesoes_validation.py:** Já existe. Importar `validate_adesao()` e usar na rota POST `/adesoes/conferir-todos`.

- **Formato de dados:** Datas em ISO (YYYY-MM-DD), valores monetários em Decimal/float, vidas em int.

- **Performance:** Índices criados em data_entrada, tipo, status_conferencia. Limite de 500 registros por query (se necessário paginação, adicionar depois).

- **Segurança:** Nenhuma injeção SQL (usar `?` placeholders). Escape de HTML em valores (ex. `esc(value)` ou similar).

- **Cores do sistema:**
  - Primária: #0c918d
  - Verde (WEB): #22c55e (rgb(34, 197, 94))
  - Azul (CRM): #3b82f6 (rgb(59, 130, 246))
  - Fundo página: #f5f5f5
  - Fundo container: white

---

**Ordem de execução:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11.
Cada item deixa o código em estado compilável e testável (running build/tests entre items).
