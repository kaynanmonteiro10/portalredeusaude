# Sistema de Planilhas — como usar

Interface pelo navegador, sem digitar nada no terminal.

## Pré-requisito (só na primeira vez)
Precisa ter o **Python 3** instalado no computador (baixe em python.org se ainda não tiver).

## Como abrir

- **Windows**: dê 2 cliques no arquivo `iniciar_windows.bat`
- **Mac**: dê 2 cliques no arquivo `iniciar_mac.command`
  (se o Mac bloquear por segurança na primeira vez: clique com o botão direito → Abrir)

Uma janela preta vai aparecer só por um instante para instalar o necessário — depois disso
**o navegador abre sozinho** em `http://127.0.0.1:5000` e todo o resto é feito ali, por telas.

Para usar de novo depois, é só clicar no mesmo arquivo outra vez.

## Passo a passo na tela

1. **Planilha 1** — envie o arquivo com os dados brutos (export do sistema).
2. **CPF/CNPJ** — escolha se quer manter só CNPJ, só CPF, ou os dois.
3. **Tipo Parcela** — marque quais tipos quer remover (a coluna Valor Parcela já é
   limpa automaticamente: remove "R$", e descarta linhas "R$ 0,00" / "R$ -").
4. **Planilha 2** — envie a planilha de controle (com as abas por grupo-mãe).
5. **Mapeamento** — para cada Grupo Empresa, escolha a aba de destino.
   - Dá pra marcar vários grupos e aplicar a mesma aba de uma vez ("aplicar em lote").
   - Grupos com pagamento por **depósito bancário** aparecem com um aviso — é só
     informativo, não muda o destino sozinho.
   - Deixe em branco ("— ignorar —") para não importar aquele grupo.
6. **Resultado** — baixe a planilha 2 já atualizada e o relatório de pagos/não pagos.

## O que o sistema NUNCA altera
- Cabeçalhos das abas
- A coluna "Valor Assoc" (ou "GRUPO"/"Responsavel", quando existir)
- A fórmula da coluna "Situação" (ex: `=SE(G32>1;"PAGO";"")`) — é sempre copiada
  da linha-modelo, só ajustando o número da linha
- A primeira linha de dados de cada aba (fica preservada como exemplo)
- Empresas cujo CNPJ já existe na aba não são duplicadas (ficam marcadas como
  "já existiam" no resumo final)

## Arquivos deste pacote
- `app.py` — interface web (Flask)
- `motor.py` — toda a lógica de limpeza/importação das planilhas
- `templates/`, `static/` — telas e estilo
- `iniciar_windows.bat` / `iniciar_mac.command` — atalhos para abrir sem terminal
- `uploads/`, `outputs/` — pastas usadas automaticamente pelo sistema
