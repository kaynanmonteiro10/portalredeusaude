(() => {
  'use strict';

  const IMAGE_VERSION = '20261118a';
  const SOUND_KEY = 'sabi-sound';
  const LOOKS = [
    { id: 'auto', name: 'Automático', note: 'segue a época do ano' },
    { id: 'classico', name: 'Clássico' },
    { id: 'verao', name: 'Verão' },
    { id: 'inverno', name: 'Inverno' },
    { id: 'junina', name: 'Junina' },
    { id: 'natal', name: 'Fim de ano' },
  ];
  const TIPS = {
    homeScreen: 'este é o seu painel do dia. Os cartões mostram o que está acontecendo no setor, e o mural reúne os avisos da equipe.',
    sabiCenterScreen: 'esta é a Central do Sabi: o resumo do que precisa de atenção, todos os relatórios e as rotinas automáticas em um só lugar. A leitura não consulta o S4E nem altera cadastros.',
    tasksScreen: 'aqui ficam as demandas. Os cartões do topo filtram a fila; o botão Nova demanda abre o formulário.',
    weeklyScreen: 'o Relatório Semanal lê os cadastros direto do S4E. Se os dados estiverem velhos, use Atualizar do S4E.',
    adesiScreen: 'a Conferência de Adesões compara lote, vidas e parcela. Clique em uma linha para ver o motivo de pendente ou divergente.',
    contractsScreen: 'em Contratos você consulta e inclui vidas. O cancelamento de verdade sai do portal.',
    commissionsScreen: 'Comissões cruzam contratos e vínculos do S4E por competência.',
    financeScreen: 'os Rateios P4X reúnem faturamento e recebimento; os valores seguem a data de crédito.',
    cobrancaScreen: 'a Cobrança monta os e-mails por modelo. O envio real só acontece depois da sua confirmação.',
    retornosScreen: 'Retornos conciliam o arquivo do banco; a diferença recebida tem explicação própria.',
    apuracaoScreen: 'a Apuração busca as notas oficiais e confere os lotes do mês.',
    rateioScreen: 'no Rateio de Faturamento, centro de custo é o grupo-mãe e grupo é o filho.',
    notasScreen: 'a Conferência de Notas procura NF e lote duplicados e marca os grupos suspeitos.',
    recibosScreen: 'Recibos geram o PDF a partir dos dados do S4E.',
    vendasScreen: 'o Acompanhamento de Vendas mostra as vendas e os cancelamentos do S4E, com os vínculos.',
    movimentacoesScreen: 'a Exclusão de Vidas mostra quem entrou e quem saiu. Nunca dispare um cancelamento sem conferir.',
    vidasScreen: 'Movimentação de Vidas mostra a carteira, as entradas e as saídas do período.',
    emailCenterScreen: 'a Central de E-mails guarda caixas, pastas e modelos.',
    adminScreen: 'o Admin controla acessos, telas e configurações do portal.',
    chatScreen: 'Conversas é o chat interno da equipe.',
    feedScreen: 'o Mural reúne os avisos e as novidades do portal.',
    birthdaysScreen: 'aqui ficam os aniversariantes do mês e a próxima comemoração.',
    learningScreen: 'Treinamentos do Setor reúne os materiais da equipe.',
    sindicatosScreen: 'Sindicatos mostra os vínculos usados nos contratos.',
    reportsScreen: 'Relatórios consolidam demanda e produtividade do setor.',
  };
  const DEFAULT_TIP = 'eu sou o Sabi, seu assistente. Posso abrir telas, ensinar o passo a passo, responder números do portal, baixar relatórios automaticamente e executar ações complexas como apuração e conferência de notas.';
  const SCREEN_LABELS = {
    homeScreen: 'Início', sabiCenterScreen: 'Central do Sabi', tasksScreen: 'Demandas', weeklyScreen: 'Relatório Semanal', adesiScreen: 'Conferência de Adesões',
    contractsScreen: 'Contratos', commissionsScreen: 'Comissões', financeScreen: 'Rateios P4X', cobrancaScreen: 'Cobranças',
    retornosScreen: 'Retorno Instituição', apuracaoScreen: 'Apuração', rateioScreen: 'Rateio de Faturamento',
    notasScreen: 'Conferência de Notas', recibosScreen: 'Recibos', vendasScreen: 'Acompanhamento de Vendas',
    movimentacoesScreen: 'Exclusão de Vidas', vidasScreen: 'Movimentação de Vidas', emailCenterScreen: 'Central de E-mails',
    adminScreen: 'Admin', chatScreen: 'Conversas', feedScreen: 'Mural da Equipe', birthdaysScreen: 'Aniversariantes',
    learningScreen: 'Treinamentos do Setor', sindicatosScreen: 'Sindicatos', reportsScreen: 'Relatórios',
  };
  const SCREEN_ALIASES = {
    homeScreen: ['inicio', 'painel', 'home', 'tela inicial'],
    sabiCenterScreen: ['central do sabi', 'central', 'painel do sabi', 'assistente'],
    tasksScreen: ['demanda', 'tarefa', 'quadro de demandas'],
    weeklyScreen: ['relatorio semanal', 'semanal', 'relatorio de cadastros'],
    adesiScreen: ['conferencia de adesoes', 'adesao', 'adesoes', 'conferencia de adesao'],
    contractsScreen: ['contrato', 'contratos'],
    commissionsScreen: ['comissao', 'comissoes'],
    financeScreen: ['rateio p4x', 'rateios p4x', 'financeiro'],
    cobrancaScreen: ['cobranca', 'cobrancas', 'cobranca em lote'],
    retornosScreen: ['retorno instituicao', 'retorno', 'retornos', 'instituicao'],
    apuracaoScreen: ['apuracao'],
    rateioScreen: ['rateio de faturamento', 'rateio'],
    notasScreen: ['conferencia de notas', 'notas', 'nota fiscal'],
    recibosScreen: ['recibo', 'recibos'],
    vendasScreen: ['acompanhamento de vendas', 'vendas', 'venda'],
    movimentacoesScreen: ['exclusao de vidas', 'movimentacoes', 'movimentacao de vidas'],
    vidasScreen: ['vidas', 'vida', 'carteira'],
    emailCenterScreen: ['central de emails', 'emails', 'email'],
    adminScreen: ['admin', 'administracao', 'usuarios'],
    chatScreen: ['conversas', 'chat'],
    feedScreen: ['mural da equipe', 'mural', 'feed'],
    birthdaysScreen: ['aniversariantes', 'aniversario de quem', 'aniversarios'],
    learningScreen: ['treinamentos', 'treinamento'],
    sindicatosScreen: ['sindicatos', 'sindicato'],
    reportsScreen: ['relatorios de demanda', 'relatorios'],
  };
  const TOURS = {
    homeScreen: [
      { sel: '#homeHero', text: 'Este é o painel do dia. O cartão do topo muda com o que a gestão publica para a equipe.' },
      { sel: '#homeBell', text: 'O sino reúne os avisos: mural, comunicados, conversas e novidades do sistema.' },
      { sel: '#homeQuick', text: 'Os atalhos abrem as telas que você mais usa. Eles mudam conforme o seu acesso.' },
      { sel: '#homeMural', text: 'O mural mostra as publicações da equipe. "Ver mural" abre a tela completa.' },
      { sel: '#homeUpdates', text: 'Aqui aparece o que mudou no sistema, com a data de cada novidade.' },
    ],
    sabiCenterScreen: [
      { sel: '#sabiCenterKpis', text: 'Os quatro cartões mostram o resumo do dia. Clique para abrir a tela que detalha cada pendência.' },
      { sel: '#sabiCenterPriorities', text: 'Esta fila reúne o que mais merece atenção, primeiro por urgência e depois pelo tipo de relatório.' },
      { sel: '#sabiCenterSearch', text: 'Use a busca e os filtros para encontrar qualquer relatório do setor sem navegar por vários menus.' },
      { sel: '#sabiCenterReports', text: 'Cada cartão mostra o último dado lido. Abrir tela leva ao relatório completo; Baixar exporta o que já está salvo.' },
      { sel: '#sabiCenterSchedules', text: 'As rotinas automáticas ficam aqui. Peça a mim para agendar uma exportação, sem alterar o S4E.' },
      { sel: '#sabiCenterAsk', text: 'Se quiser, peça em linguagem natural. Eu abro o assistente e preparo a pergunta para você.' },
    ],
    tasksScreen: [
      { sel: '[data-stat-filter="today"]', text: 'Os cartões do topo resumem a fila. Clique em um deles para filtrar a lista.' },
      { sel: '#newTaskButton', text: 'Nova demanda abre o formulário com título, prazo, responsável e prioridade.' },
      { sel: '#statusFilter', text: 'Aqui você filtra por status, responsável, prioridade e período.' },
      { sel: '#searchInput', text: 'A busca encontra pelo título, pela observação ou pelo responsável.' },
      { sel: '#taskList', text: 'Em cada cartão, o check conclui, Editar abre o formulário e o × exclui. Quem não é o responsável pode assumir.' },
    ],
    weeklyScreen: [
      { sel: '#weeklyRefresh', text: 'Atualizar do S4E faz a leitura dos cadastros. Pode levar alguns minutos; a barra mostra o progresso.' },
      { sel: '#weeklyCompanyCount', text: 'Os cartões mostram empresas, estabelecimentos e o total de cadastros da semana.' },
      { sel: '#weeklyBody', text: 'A tabela lista dia, tipo, cadastro e detalhes. É o mesmo conteúdo da mensagem pronta.' },
      { sel: '#copyWeeklyReport', text: 'Este botão monta a mensagem de envio já formatada, com empresas e estabelecimentos.' },
      { sel: '#exportWeeklyXlsx', text: 'Se preferir, baixe o Excel com o mesmo conteúdo.' },
    ],
    adesiScreen: [
      { sel: '#adGerarBtn', text: 'Gerar do S4E monta a conferência lendo a Entrada de Contratos e o Faturamento.' },
      { sel: '#adFontes', text: 'Aqui aparece a situação de cada fonte e o horário da última atualização automática, às 10h e às 16h.' },
      { sel: '#adDays', text: 'Os dias com adesão ficam à esquerda. Clique em um dia para ver só os lotes dele.' },
      { sel: '#adSearch', text: 'Busque por empresa ou lote. O período, o tipo e o status ficam ao lado.' },
      { sel: '#adTableBody', text: 'Cada linha é um lote. Clique na linha para abrir a conferência e ler o motivo de pendente ou divergente.' },
    ],
    contractsScreen: [
      { sel: '#contractsImportButton', text: 'Importar planilha traz as vidas para o portal.' },
      { sel: '#contractsSearch', text: 'A busca encontra a empresa por nome, CNPJ, contato ou e-mail.' },
      { sel: '#contractsKpis', text: 'Os cartões resumem vidas ativas, empresas e o que está por vencer.' },
      { sel: '#contractsList', text: 'Cada empresa abre a lista de vidas. O cancelamento de verdade é feito pelo portal.' },
    ],
    commissionsScreen: [
      { sel: '#commissionsRefreshButton', text: 'Atualizar sincroniza os dados de comissões com o que está em Contratos.' },
      { sel: '#commissionsSearch', text: 'Busque por empresa ou vendedor e refine por status e competência.' },
      { sel: '#commissionsKpis', text: 'Os cartões mostram o total, o que já foi pago e o que está pendente.' },
    ],
    financeScreen: [
      { sel: '#financeImportFromP4x', text: 'Importar do P4X traz o faturamento e o recebimento para o portal.' },
      { sel: '#financeKpis', text: 'Os cartões resumem faturado, recebido e a diferença do período.' },
      { sel: '#financeSearch', text: 'A busca e os filtros refinam por data, recebedor, ocorrência e importação.' },
    ],
    cobrancaScreen: [
      { sel: '#cobrancaImportS4e', text: 'Importar do S4E monta a fila de empresas em atraso.' },
      { sel: '#cobrancaBulkButton', text: 'A cobrança em lote prepara um e-mail por empresa. O envio real só acontece depois da sua confirmação.' },
      { sel: '#cobrancaTemplatesButton', text: 'Aqui ficam os modelos de e-mail usados nas cobranças.' },
      { sel: '#cobrancaKpis', text: 'Os cartões mostram quantas empresas estão na fila e o total em aberto.' },
    ],
    retornosScreen: [
      { sel: '#retornosApply', text: 'Consultar lê o período escolhido e o filtro de instituição.' },
      { sel: '#retornosInstitution', text: 'Escolha a instituição para ver só os retornos dela.' },
      { sel: '#retornosAlertsTitle', text: 'Os alertas mostram o que deu erro e o que já foi corrigido.' },
      { sel: '#retornosSearch', text: 'A busca encontra o lote, a empresa ou o motivo do incidente.' },
    ],
    apuracaoScreen: [
      { sel: '#apMonth', text: 'Escolha o mês e o ano da apuração.' },
      { sel: '#apRun', text: 'Apurar busca as notas oficiais e confere os lotes do período.' },
      { sel: '#apSearch', text: 'A busca encontra a empresa ou a nota na lista da apuração.' },
      { sel: '#apHistoryOpen', text: 'O histórico guarda as execuções anteriores para comparar.' },
    ],
    rateioScreen: [
      { sel: '#rfHeroRun', text: 'Atualizar roda a apuração e recalcula o rateio do período.' },
      { sel: '#rfBilling', text: 'Faturado, recebido e alocado ficam lado a lado, com a diferença.' },
      { sel: '#rfRules', text: 'As regras definem como o rateio é distribuído. Centro de custo é o grupo-mãe; grupo é o filho.' },
    ],
    notasScreen: [
      { sel: '#ntStart', text: 'Escolha o período que será conferido.' },
      { sel: '#ntRun', text: 'Conferir procura NF e lote repetidos no S4E e monta os grupos.' },
      { sel: '#ntGroupsCount', text: 'O resumo mostra quantos grupos prováveis e suspeitos foram encontrados.' },
      { sel: '#ntExport', text: 'Baixe a planilha para conferir fora do portal.' },
    ],
    recibosScreen: [
      { sel: '#rcStart', text: 'Escolha o período dos recibos.' },
      { sel: '#rcRun', text: 'Gerar lê os dados no S4E e prepara os recibos do período.' },
      { sel: '#rcDownload', text: 'Baixe o PDF com os recibos gerados.' },
    ],
    vendasScreen: [
      { sel: '#vendasStart', text: 'Escolha o período da venda ou do cancelamento.' },
      { sel: '#vendasConsult', text: 'Consultar período lê as vendas oficiais no S4E.' },
      { sel: '#vendasTotals', text: 'Os cartões resumem vidas, contratos, valor e cancelamentos.' },
      { sel: '#vendasTeam', text: 'Os filtros refinam por equipe, vendedor, situação e vínculo.' },
    ],
    movimentacoesScreen: [
      { sel: '#movCancelPane', text: 'A exclusão de vidas pode ser feita uma a uma ou em massa.' },
      { sel: '#movCancelForm', text: 'Aqui você informa a empresa, a data e a pessoa que será excluída.' },
      { sel: '#movCancelBulkForm', text: 'Em massa, cole a lista de códigos ou CPFs e confira a prévia antes de enviar.' },
      { sel: '#movNotice', text: 'Nada é enviado ao S4E sem a sua confirmação. Confira a prévia com atenção.' },
    ],
    vidasScreen: [
      { sel: '#vidasStart', text: 'Escolha o período da movimentação.' },
      { sel: '#vidasRefresh', text: 'Atualizar consulta o S4E e recalcula a carteira.' },
      { sel: '#vidasKpis', text: 'Os cartões mostram entradas, saídas e o saldo do período.' },
      { sel: '#vidasChart', text: 'O gráfico compara a carteira e mostra o motivo de cada movimento.' },
    ],
    adminScreen: [
      { sel: '#userForm', text: 'Aqui você cria e edita acessos, setores e telas de cada pessoa.' },
      { sel: '#adminKpis', text: 'Os cartões resumem usuários, acessos e a atividade recente.' },
      { sel: '#adminTabs', text: 'As abas separam pessoas, estrutura, eventos e configurações.' },
    ],
    birthdaysScreen: [
      { sel: '#bdNextCard', text: 'O próximo aniversário aparece em destaque, com a data e a idade.' },
      { sel: '#bdMonths', text: 'A lista é agrupada por mês. Clique em uma pessoa para ver a ficha.' },
      { sel: '#bdSearch', text: 'Busque pelo nome para achar alguém rapidamente.' },
    ],
    chatScreen: [
      { sel: '#chatTabs', text: 'As abas alternam entre conversas, pessoas e grupos.' },
      { sel: '#chatShell', text: 'A lista da esquerda mostra as conversas; a direita mostra as mensagens.' },
      { sel: '#chatInput', text: 'Digite aqui para conversar. O anexo fica ao lado do campo.' },
    ],
    learningScreen: [
      { sel: '#learningKpis', text: 'Os cartões resumem treinamentos, materiais e anotações.' },
      { sel: '#learningSearch', text: 'A busca encontra um treinamento ou material pelo nome.' },
      { sel: '#learningTrainings', text: 'Cada treinamento abre os materiais e o passo a passo.' },
    ],
    reportsScreen: [
      { sel: '#reportStart', text: 'Escolha o período e o setor do relatório.' },
      { sel: '#reportStats', text: 'Os cartões resumem o que foi concluído, o que está aberto e o que atrasou.' },
      { sel: '#reportCsv', text: 'Exporte a planilha para levar a análise para fora do portal.' },
    ],
    commissionsScreen: [
      { sel: '#commissionsRefreshButton', text: 'Atualizar sincroniza os dados de comissões com o que está em Contratos.' },
      { sel: '#commissionsSearch', text: 'Busque por empresa ou vendedor e refine por status e competência.' },
      { sel: '#commissionsKpis', text: 'Os cartões mostram o total, o que já foi pago e o que está pendente.' },
      { sel: '#commissionsExportButton', text: 'Exporte o relatório para análise fora do portal.' },
    ],
    financeScreen: [
      { sel: '#financeImportFromP4x', text: 'Importar do P4X traz o faturamento e o recebimento para o portal.' },
      { sel: '#financeKpis', text: 'Os cartões resumem faturado, recebido e a diferença do período.' },
      { sel: '#financeSearch', text: 'A busca e os filtros refinam por data, recebedor, ocorrência e importação.' },
      { sel: '#financeExportButton', text: 'Exporte o relatório consolidado para análise.' },
    ],
    apuracaoScreen: [
      { sel: '#apMonth', text: 'Escolha o mês e o ano da apuração.' },
      { sel: '#apRun', text: 'Apurar busca as notas oficiais e confere os lotes do período.' },
      { sel: '#apSearch', text: 'A busca encontra a empresa ou a nota na lista da apuração.' },
      { sel: '#apHistoryOpen', text: 'O histórico guarda as execuções anteriores para comparar.' },
      { sel: '#apExport', text: 'Baixe a planilha ou o relatório detalhado.' },
    ],
    rateioScreen: [
      { sel: '#rfHeroRun', text: 'Atualizar roda a apuração e recalcula o rateio do período.' },
      { sel: '#rfBilling', text: 'Faturado, recebido e alocado ficam lado a lado, com a diferença.' },
      { sel: '#rfRules', text: 'As regras definem como o rateio é distribuído. Centro de custo é o grupo-mãe; grupo é o filho.' },
      { sel: '#rfExport', text: 'Exporte o rateio para análise ou envio.' },
    ],
    notasScreen: [
      { sel: '#ntStart', text: 'Escolha o período que será conferido.' },
      { sel: '#ntRun', text: 'Conferir procura NF e lote repetidos no S4E e monta os grupos.' },
      { sel: '#ntGroupsCount', text: 'O resumo mostra quantos grupos prováveis e suspeitos foram encontrados.' },
      { sel: '#ntExport', text: 'Baixe a planilha para conferir fora do portal.' },
    ],
    recibosScreen: [
      { sel: '#rcStart', text: 'Escolha o período dos recibos.' },
      { sel: '#rcRun', text: 'Gerar lê os dados no S4E e prepara os recibos do período.' },
      { sel: '#rcDownload', text: 'Baixe o PDF com os recibos gerados.' },
    ],
    vendasScreen: [
      { sel: '#vendasStart', text: 'Escolha o período da venda ou do cancelamento.' },
      { sel: '#vendasConsult', text: 'Consultar período lê as vendas oficiais no S4E.' },
      { sel: '#vendasTotals', text: 'Os cartões resumem vidas, contratos, valor e cancelamentos.' },
      { sel: '#vendasTeam', text: 'Os filtros refinam por equipe, vendedor, situação e vínculo.' },
      { sel: '#vendasExport', text: 'Exporte o relatório para análise.' },
    ],
    movimentacoesScreen: [
      { sel: '#movCancelPane', text: 'A exclusão de vidas pode ser feita uma a uma ou em massa.' },
      { sel: '#movCancelForm', text: 'Aqui você informa a empresa, a data e a pessoa que será excluída.' },
      { sel: '#movCancelBulkForm', text: 'Em massa, cole a lista de códigos ou CPFs e confira a prévia antes de enviar.' },
      { sel: '#movNotice', text: 'Nada é enviado ao S4E sem a sua confirmação. Confira a prévia com atenção.' },
    ],
    vidasScreen: [
      { sel: '#vidasStart', text: 'Escolha o período da movimentação.' },
      { sel: '#vidasRefresh', text: 'Atualizar consulta o S4E e recalcula a carteira.' },
      { sel: '#vidasKpis', text: 'Os cartões mostram entradas, saídas e o saldo do período.' },
      { sel: '#vidasChart', text: 'O gráfico compara a carteira e mostra o motivo de cada movimento.' },
    ],
    retornosScreen: [
      { sel: '#retornosApply', text: 'Consultar lê o período escolhido e o filtro de instituição.' },
      { sel: '#retornosInstitution', text: 'Escolha a instituição para ver só os retornos dela.' },
      { sel: '#retornosAlertsTitle', text: 'Os alertas mostram o que deu erro e o que já foi corrigido.' },
      { sel: '#retornosSearch', text: 'A busca encontra o lote, a empresa ou o motivo do incidente.' },
      { sel: '#retornosExport', text: 'Exporte o relatório para análise.' },
    ],
    cobrancaScreen: [
      { sel: '#cobrancaImportS4e', text: 'Importar do S4E monta a fila de empresas em atraso.' },
      { sel: '#cobrancaBulkButton', text: 'A cobrança em lote prepara um e-mail por empresa. O envio real só acontece depois da sua confirmação.' },
      { sel: '#cobrancaTemplatesButton', text: 'Aqui ficam os modelos de e-mail usados nas cobranças.' },
      { sel: '#cobrancaKpis', text: 'Os cartões mostram quantas empresas estão na fila e o total em aberto.' },
      { sel: '#cobrancaExport', text: 'Exporte o relatório para análise.' },
    ],
    emailCenterScreen: [
      { sel: '#ecKpis', text: 'Os cartões mostram o volume e o que precisa de resposta.' },
      { sel: '#ecMailboxes', text: 'As caixas configuradas aparecem aqui, com o status de cada uma.' },
      { sel: '#ecSearch', text: 'Busque por assunto, pessoa ou caixa e refine por status e prioridade.' },
    ],
    managementScreen: [
      { sel: '#managementSector', text: 'Escolha o setor para ver as métricas dele.' },
      { sel: '#managementKpis', text: 'Os cartões mostram demandas, produtividade e status do setor.' },
      { sel: '#managementDrill', text: 'Clique em um cartão para ver os detalhes da métrica.' },
    ],
    mergeScreen: [
      { sel: '#mergeStart', text: 'Escolha a competência para a mala direta.' },
      { sel: '#mergeTemplate', text: 'Selecione o modelo de e-mail ou crie um novo.' },
      { sel: '#mergeRun', text: 'Gerar prepara os e-mails com os dados do período.' },
      { sel: '#mergePreview', text: 'Revise a prévia antes de enviar.' },
    ],
    boardScreen: [
      { sel: '#boardUpload', text: 'Carregue a planilha para processar.' },
      { sel: '#boardQueue', text: 'A fila mostra as planilhas aguardando processamento.' },
      { sel: '#boardHistory', text: 'O histórico guarda os processamentos anteriores.' },
    ],
  };

  const state = {
    look: 'auto', effective: 'classico', open: false, saving: false, loaded: false, failedAt: 0,
    muted: localStorage.getItem(SOUND_KEY) === 'off', pending: null, busy: false, tour: null,
    watchTimer: null, moodTimer: null, lastJobLine: '',
  };
  const num = new Intl.NumberFormat('pt-BR');
  const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

  let root = null;
  let panel = null;
  let fab = null;
  let portrait = null;
  let stage = null;
  let tip = null;
  let answerNode = null;
  let errorNode = null;
  let askForm = null;
  let inputNode = null;
  let confirmBox = null;
  let confirmText = null;
  let soundBtn = null;
  let lookNote = null;
  let lookButtons = [];
  let overlay = null;
  let spot = null;
  let coach = null;
  let coachText = null;
  let coachStep = null;
  let coachPrev = null;
  let coachNext = null;
  let coachImage = null;
  let rafPending = false;

  function adminUser() {
    const access = window.PortalAccess?.Access;
    if (!access || access.offline) return null;
    const user = access.user;
    return user && user.role === 'admin' ? user : null;
  }

  function imageUrl(look, stage = false) {
    return `assets/sabi/${look}${stage ? '-stage' : ''}.jpg?v=${IMAGE_VERSION}`;
  }

  function greeting() {
    const hour = new Date().getHours();
    return hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  }

  function activeScreen() {
    return document.querySelector('.screen:not(.hidden)')?.id || 'homeScreen';
  }

  function norm(value) {
    return String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function todayISO() {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function brDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return value || '';
    const [year, month, day] = value.split('-');
    return `${day}/${month}`;
  }

  function brFullDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return value || '';
    const [year, month, day] = value.split('-');
    return `${day}/${month}/${year}`;
  }

  function stamp(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function longToday() {
    return new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function visible(element) {
    if (!element || !element.isConnected) return false;
    if (element.closest('.screen.hidden')) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 6 || rect.height < 6) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  async function waitFor(selector, timeout = 7000, ready = () => true) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const element = document.querySelector(selector);
      if (element && visible(element) && ready(element)) return element;
      await sleep(140);
    }
    return null;
  }

  function assertAuthed() {
    if (!adminUser()) throw new Error('O Sabi é exclusivo dos administradores. Entre com a sua conta de admin.');
  }

  async function apiFetch(path, options = {}) {
    assertAuthed();
    let response;
    try {
      response = await fetch(`${window.PORTAL_API_BASE || ''}${path}`, {
        ...options,
        headers: window.PortalAccess.authHeaders(options.headers || {}),
      });
    } catch {
      throw new Error('Não consegui falar com o portal agora. Verifique a conexão.');
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error('Sua sessão terminou. Entre novamente para eu continuar.');
    if (response.status === 423) throw new Error('O portal está bloqueado pela administração.');
    if (!response.ok) throw new Error(data.error || 'O portal não respondeu como esperado.');
    return data;
  }

  // ── Som ──────────────────────────────────────────────────────────────────
  const Sound = (() => {
    let context = null;

    function audio() {
      if (state.muted) return null;
      try {
        if (!context) context = new (window.AudioContext || window.webkitAudioContext)();
        if (context.state === 'suspended') context.resume().catch(() => {});
        return context;
      } catch {
        return null;
      }
    }

    function note({ at = 0, freq = 880, dur = 0.12, type = 'sine', gain = 0.05, slide = 0, vibrato = 0 }) {
      const ac = audio();
      if (!ac) return;
      const start = ac.currentTime + at;
      const oscillator = ac.createOscillator();
      const volume = ac.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(freq, start);
      if (slide) oscillator.frequency.exponentialRampToValueAtTime(slide, start + dur);
      if (vibrato) {
        const lfo = ac.createOscillator();
        const depth = ac.createGain();
        lfo.frequency.value = 5.5;
        depth.gain.value = vibrato;
        lfo.connect(depth);
        depth.connect(oscillator.frequency);
        lfo.start(start);
        lfo.stop(start + dur + 0.05);
      }
      volume.gain.setValueAtTime(0.0001, start);
      volume.gain.exponentialRampToValueAtTime(gain, start + 0.015);
      volume.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      oscillator.connect(volume);
      volume.connect(ac.destination);
      oscillator.start(start);
      oscillator.stop(start + dur + 0.03);
    }

    return {
      chirp() {
        note({ freq: 880, dur: 0.09, gain: 0.045, slide: 1320 });
        note({ at: 0.09, freq: 1320, dur: 0.12, gain: 0.04, slide: 1760 });
      },
      pop() {
        note({ freq: 640, dur: 0.07, type: 'triangle', gain: 0.035 });
      },
      tick() {
        note({ freq: 1040, dur: 0.045, gain: 0.018 });
      },
      error() {
        note({ freq: 320, dur: 0.16, type: 'triangle', gain: 0.04, slide: 220 });
      },
      whistle() {
        note({ freq: 1046, dur: 0.28, gain: 0.05, slide: 1568, vibrato: 8 });
        note({ at: 0.3, freq: 1568, dur: 0.22, gain: 0.045, slide: 1318, vibrato: 10 });
        note({ at: 0.56, freq: 1318, dur: 0.4, gain: 0.04, slide: 2093, vibrato: 12 });
      },
      sing() {
        const melody = [
          [523.25, 0, 0.16], [587.33, 0.18, 0.16], [659.25, 0.36, 0.22],
          [783.99, 0.62, 0.26], [659.25, 0.92, 0.18], [587.33, 1.12, 0.3],
        ];
        melody.forEach(([freq, at, dur]) => note({ freq, at, dur, type: 'triangle', gain: 0.045, vibrato: 4 }));
        note({ freq: 1046.5, at: 1.52, dur: 0.45, gain: 0.03, slide: 1318, vibrato: 6 });
      },
    };
  })();

  function mood(name, ms = 1700) {
    if (!stage) return;
    stage.dataset.mood = name;
    clearTimeout(state.moodTimer);
    state.moodTimer = setTimeout(() => {
      if (stage) stage.dataset.mood = 'idle';
    }, ms);
  }

  function setMuted(muted, silent = false) {
    state.muted = Boolean(muted);
    try { localStorage.setItem(SOUND_KEY, state.muted ? 'off' : 'on'); } catch {}
    if (soundBtn) {
      soundBtn.setAttribute('aria-pressed', String(!state.muted));
      soundBtn.classList.toggle('is-muted', state.muted);
      soundBtn.title = state.muted ? 'Ligar som' : 'Desligar som';
      soundBtn.setAttribute('aria-label', state.muted ? 'Ligar som do Sabi' : 'Desligar som do Sabi');
    }
    if (!state.muted && !silent) Sound.pop();
  }

  function sing() {
    Sound.sing();
    Sound.chirp();
    mood('sing', 2800);
    say('Lá lá lá… essa é a minha música de trabalho. Se quiser, eu também assobio.');
  }

  function whistle() {
    Sound.whistle();
    mood('whistle', 2600);
    say('Fiu-fiu! Estou aqui. Pode pedir "resumo do dia", "quantas demandas" ou "me ensine esta tela".');
  }

  function celebrate() {
    Sound.chirp();
    mood('wave', 1500);
    if (Math.random() < 0.18) {
      setTimeout(() => {
        Sound.whistle();
        mood('whistle', 2400);
      }, 380);
    }
  }

  // ── Painel ───────────────────────────────────────────────────────────────
  function build() {
    root = document.createElement('div');
    root.className = 'sabi-root';
    root.hidden = true;
    root.innerHTML = `
      <section class="sabi-panel" id="sabiPanel" hidden role="dialog" aria-label="Assistente Sabi">
        <header class="sabi-head">
          <div class="sabi-title"><strong>Sabi</strong><small>assistente do portal</small></div>
          <div class="sabi-head-actions">
            <button type="button" class="sabi-icon sabi-sound" id="sabiSound" aria-pressed="true" aria-label="Desligar som do Sabi" title="Desligar som">♪</button>
            <button type="button" class="sabi-icon sabi-close" id="sabiClose" aria-label="Fechar assistente">×</button>
          </div>
        </header>
        <div class="sabi-stage" id="sabiStage" data-mood="idle">
          <span class="sabi-halo" aria-hidden="true"></span>
          <span class="sabi-notes" aria-hidden="true"><i>♪</i><i>♫</i><i>♩</i></span>
          <img id="sabiPortrait" alt="Sabi, o assistente do portal" width="640" height="640">
        </div>
        <div class="sabi-bubble">
          <p class="sabi-tip" id="sabiTip" aria-live="polite"></p>
          <div class="sabi-answer" id="sabiAnswer" aria-live="polite" hidden></div>
        </div>
        <div class="sabi-confirm" id="sabiConfirm" hidden>
          <p id="sabiConfirmText"></p>
          <div class="sabi-confirm-row">
            <button type="button" class="sabi-primary" id="sabiConfirmYes">Sim, executar</button>
            <button type="button" class="sabi-ghost" id="sabiConfirmNo">Cancelar</button>
          </div>
        </div>
        <form class="sabi-ask" id="sabiAsk" autocomplete="off">
          <input id="sabiInput" type="text" maxlength="220" placeholder="Peça algo ao Sabi…" aria-label="Peça algo ao Sabi">
          <button type="submit" aria-label="Enviar pedido ao Sabi">Enviar</button>
        </form>
        <nav class="sabi-actions" aria-label="Atalhos do Sabi">
          <button type="button" data-action="tour">Me ensine esta tela</button>
          <button type="button" data-action="summary">Resumo do dia</button>
          <button type="button" data-action="insights">Análise</button>
          <button type="button" data-action="sing">Cantar</button>
          <button type="button" data-action="whistle">Assobiar</button>
          <a href="manual-do-portal.html" target="_blank" rel="noreferrer">Manual</a>
        </nav>
        <div class="sabi-error" id="sabiError" hidden></div>
        <details class="sabi-looks">
          <summary><span>Looks do Sabi</span><small id="sabiLookNote">automático</small></summary>
          <div class="sabi-look-list" id="sabiLooks"></div>
        </details>
        <p class="sabi-note">Prévia para administradores — a equipe ainda não vê o Sabi.</p>
      </section>
      <button type="button" class="sabi-fab" id="sabiFab" aria-label="Abrir assistente Sabi" aria-expanded="false" aria-controls="sabiPanel"></button>`;
    document.body.appendChild(root);

    panel = root.querySelector('#sabiPanel');
    fab = root.querySelector('#sabiFab');
    portrait = root.querySelector('#sabiPortrait');
    stage = root.querySelector('#sabiStage');
    tip = root.querySelector('#sabiTip');
    answerNode = root.querySelector('#sabiAnswer');
    errorNode = root.querySelector('#sabiError');
    askForm = root.querySelector('#sabiAsk');
    inputNode = root.querySelector('#sabiInput');
    confirmBox = root.querySelector('#sabiConfirm');
    confirmText = root.querySelector('#sabiConfirmText');
    soundBtn = root.querySelector('#sabiSound');
    lookNote = root.querySelector('#sabiLookNote');

    fab.addEventListener('click', () => toggle());
    root.querySelector('#sabiClose').addEventListener('click', () => close());
    soundBtn.addEventListener('click', () => setMuted(!state.muted));
    root.querySelector('#sabiConfirmYes').addEventListener('click', () => resolveConfirm(true));
    root.querySelector('#sabiConfirmNo').addEventListener('click', () => resolveConfirm(false));
    askForm.addEventListener('submit', event => {
      event.preventDefault();
      handleCommand(inputNode.value);
    });
    root.querySelectorAll('.sabi-actions [data-action]').forEach(button => {
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'tour') startTour(activeScreen());
        else if (action === 'summary') handleCommand('resumo do dia');
        else if (action === 'insights') handleCommand('análise');
        else if (action === 'sing') sing();
        else if (action === 'whistle') whistle();
      });
    });
    document.addEventListener('keydown', event => {
      if (state.tour) {
        if (event.key === 'Escape') { event.preventDefault(); endTour(); }
        else if (event.key === 'ArrowRight') { event.preventDefault(); showStep(state.tour.index + 1); }
        else if (event.key === 'ArrowLeft') { event.preventDefault(); showStep(state.tour.index - 1); }
        return;
      }
      if (event.key === 'Escape' && state.open) close();
    });
    document.addEventListener('click', event => {
      if (state.open && !root.contains(event.target)) close();
    });
    document.querySelector('.sidebar-nav')?.addEventListener('click', () => close(), true);
    document.querySelector('#customScreens')?.addEventListener('click', () => close(), true);
    document.addEventListener('scroll', () => schedulePlace(), true);
    window.addEventListener('resize', () => schedulePlace());

    setMuted(state.muted, true);
    renderLooks();
    render();
  }

  function updateTip() {
    if (!tip) return;
    tip.innerHTML = `<strong>${greeting()}!</strong> ${TIPS[activeScreen()] || DEFAULT_TIP}`;
  }

  function say(text) {
    if (!answerNode) return;
    answerNode.replaceChildren();
    let list = null;
    for (const raw of String(text || '').split('\n')) {
      const line = raw.trim();
      if (!line) { list = null; continue; }
      if (line.startsWith('- ')) {
        if (!list) {
          list = document.createElement('ul');
          answerNode.appendChild(list);
        }
        const item = document.createElement('li');
        item.textContent = line.slice(2);
        list.appendChild(item);
        continue;
      }
      list = null;
      const paragraph = document.createElement('p');
      paragraph.textContent = line;
      answerNode.appendChild(paragraph);
    }
    answerNode.hidden = !answerNode.childElementCount;
    panel?.scrollTo?.({ top: panel.scrollHeight, behavior: 'smooth' });
  }

  function showError(message) {
    if (!errorNode) return;
    errorNode.textContent = message || '';
    errorNode.hidden = !message;
  }

  function renderLooks() {
    const box = root.querySelector('#sabiLooks');
    box.innerHTML = LOOKS.map(look => `
      <button type="button" class="sabi-look" data-look="${look.id}" aria-pressed="false" title="${look.name}${look.note ? ` — ${look.note}` : ''}">
        <img alt="" width="40" height="40"><span>${look.name}</span>
      </button>`).join('');
    lookButtons = [...box.querySelectorAll('.sabi-look')];
    lookButtons.forEach(button => {
      button.addEventListener('click', () => choose(button.dataset.look));
    });
    paintLooks();
  }

  function paintLooks() {
    for (const button of lookButtons) {
      const id = button.dataset.look;
      button.setAttribute('aria-pressed', state.look === id ? 'true' : 'false');
      button.disabled = state.saving;
      const source = imageUrl(id === 'auto' ? state.effective : id);
      const img = button.querySelector('img');
      if (img.getAttribute('src') !== source) img.src = source;
    }
    if (lookNote) {
      lookNote.textContent = state.look === 'auto'
        ? `automático · agora: ${LOOKS.find(look => look.id === state.effective)?.name || 'Clássico'}`
        : LOOKS.find(look => look.id === state.look)?.name || 'look escolhido';
    }
  }

  function render() {
    const source = imageUrl(state.effective);
    const stageSource = imageUrl(state.effective, true);
    fab.style.backgroundImage = `url("${source}")`;
    if (portrait.getAttribute('src') !== stageSource) portrait.src = stageSource;
    updateTip();
    paintLooks();
  }

  function toggle() {
    state.open ? close() : open();
  }

  function open() {
    state.open = true;
    panel.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    updateTip();
    Sound.chirp();
    mood('wave', 1400);
  }

  function close() {
    state.open = false;
    panel.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
    clearConfirm();
  }

  async function choose(look) {
    if (state.saving || look === state.look) return;
    state.saving = true;
    showError('');
    paintLooks();
    try {
      const data = await window.PortalAccess.api('/api/sabi', {
        method: 'PUT',
        body: JSON.stringify({ look }),
      });
      apply(data);
      Sound.pop();
      mood('wave', 1400);
    } catch (error) {
      showError(error?.message && error.message !== 'auth'
        ? error.message
        : 'Não foi possível salvar o look agora.');
    } finally {
      state.saving = false;
      paintLooks();
    }
  }

  function apply(data) {
    if (!data || typeof data !== 'object') return;
    if (LOOKS.some(look => look.id === data.look)) state.look = data.look;
    if (LOOKS.some(look => look.id === data.effective) && data.effective !== 'auto') state.effective = data.effective;
    render();
  }

  async function load() {
    state.loaded = true;
    try {
      apply(await window.PortalAccess.api('/api/sabi'));
    } catch {
      state.failedAt = Date.now();
    }
    render();
  }

  function clearConfirm() {
    state.pending = null;
    if (confirmBox) confirmBox.hidden = true;
  }

  function askConfirm(text, action) {
    state.pending = action;
    confirmText.textContent = text;
    confirmBox.hidden = false;
    say('Só faço isso com a sua confirmação.');
    Sound.pop();
  }

  function resolveConfirm(ok) {
    const action = state.pending;
    clearConfirm();
    if (!action) return;
    if (!ok) {
      say('Tudo bem, não fiz nada.');
      Sound.pop();
      return;
    }
    runSafely(action);
  }

  async function runSafely(action) {
    if (state.busy) return;
    state.busy = true;
    inputNode.disabled = true;
    askForm.classList.add('is-busy');
    stage.classList.add('is-thinking');
    showError('');
    try {
      await action();
    } catch (error) {
      Sound.error();
      say(`Não consegui concluir: ${error?.message || 'erro inesperado.'}`);
    } finally {
      state.busy = false;
      inputNode.disabled = false;
      askForm.classList.remove('is-busy');
      stage.classList.remove('is-thinking');
    }
  }

  // ── Telas e dados ────────────────────────────────────────────────────────
  function detectScreen(query) {
    let best = null;
    for (const [id, aliases] of Object.entries(SCREEN_ALIASES)) {
      for (const alias of aliases) {
        if (query.includes(alias) && (!best || alias.length > best.length)) best = { id, length: alias.length };
      }
    }
    return best?.id || null;
  }

  function detectLook(query) {
    if (/natal|fim de ano/.test(query)) return 'natal';
    if (/junin|arraia|festival/.test(query)) return 'junina';
    if (/inverno|frio/.test(query)) return 'inverno';
    if (/verao|calor/.test(query)) return 'verao';
    if (/classic|padrao/.test(query)) return 'classico';
    if (/automatic|epoca do ano/.test(query)) return 'auto';
    return null;
  }

  function openScreen(screenId) {
    window.PortalAccess?.openScreen?.(screenId);
  }

  function currentWeekRange() {
    const base = new Date();
    const shift = (base.getDay() + 6) % 7;
    const start = new Date(base);
    start.setDate(base.getDate() - shift);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const today = new Date();
    const last = end > today ? today : end;
    const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { start: iso(start), end: iso(last) };
  }

  function taskPeriod(task) {
    return { start: task.periodStart || task.due || '', end: task.periodEnd || task.due || '' };
  }

  async function taskSnapshot() {
    const data = await apiFetch('/api/state');
    const tasks = Array.isArray(data.tasks) ? data.tasks.filter(task => task && typeof task === 'object') : [];
    const today = todayISO();
    const open = tasks.filter(task => task.status !== 'done');
    const started = open.filter(task => taskPeriod(task).start && taskPeriod(task).start <= today);
    const overdue = open.filter(task => {
      const period = taskPeriod(task);
      return period.end && period.end < today;
    });
    return {
      total: tasks.length,
      open: open.length,
      today: started.length,
      overdue,
      progress: open.filter(task => task.status === 'progress').length,
      done: tasks.filter(task => task.status === 'done').length,
    };
  }

  function taskLines(snapshot) {
    const lines = [
      `Demandas: ${num.format(snapshot.open)} em aberto de ${num.format(snapshot.total)} no total.`,
      `- Para hoje: ${num.format(snapshot.today)}`,
      `- Atrasadas: ${num.format(snapshot.overdue.length)}`,
      `- Em andamento: ${num.format(snapshot.progress)}`,
      `- Concluídas: ${num.format(snapshot.done)}`,
    ];
    if (snapshot.overdue.length) {
      lines.push('', 'Precisam de decisão:');
      snapshot.overdue.slice(0, 3).forEach(task => {
        lines.push(`- ${task.title || 'Demanda sem título'} — ${task.owner || 'sem responsável'}`);
      });
      if (snapshot.overdue.length > 3) lines.push(`- e mais ${snapshot.overdue.length - 3} atrasada(s).`);
    }
    return lines;
  }

  async function weeklySnapshot() {
    const data = await apiFetch('/api/semanal');
    const companies = Array.isArray(data.empresas) ? data.empresas : [];
    const establishments = Array.isArray(data.estabelecimentos) ? data.estabelecimentos : [];
    const byDay = new Map();
    [...companies, ...establishments].forEach(item => {
      if (!item?.data) return;
      byDay.set(item.data, (byDay.get(item.data) || 0) + 1);
    });
    const stamps = [data.empresasConsultadoEm, data.estabelecimentosConsultadoEm].filter(Boolean).sort();
    return {
      inicio: data.inicio,
      fim: data.fim,
      companies,
      establishments,
      known: Number(data.totalEmpresasConhecidas) || 0,
      at: stamps[stamps.length - 1] || '',
      stale: Boolean(data.empresasDesatualizadas || data.estabelecimentosDesatualizadas),
      byDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    };
  }

  function weeklyLines(snapshot) {
    const period = snapshot.inicio === snapshot.fim
      ? brFullDate(snapshot.inicio)
      : `${brFullDate(snapshot.inicio)} a ${brFullDate(snapshot.fim)}`;
    const lines = [
      `Relatório Semanal (${period}):`,
      `- ${num.format(snapshot.companies.length)} empresa(s) cadastrada(s)`,
      `- ${num.format(snapshot.establishments.length)} estabelecimento(s)`,
      `- ${num.format(snapshot.companies.length + snapshot.establishments.length)} cadastro(s) no período`,
    ];
    if (snapshot.byDay.length) {
      lines.push('', 'Por dia:');
      snapshot.byDay.slice(-6).forEach(([day, count]) => lines.push(`- ${brDate(day)}: ${num.format(count)}`));
    }
    if (snapshot.at) lines.push('', `Leitura do S4E: ${stamp(snapshot.at)}.`);
    if (snapshot.stale) lines.push('Os dados estão desatualizados. Posso consultar o S4E agora — é só pedir "atualizar do S4E".');
    return lines;
  }

  async function adesoesSnapshot() {
    const dia = todayISO();
    const data = await apiFetch(`/api/adesoes?dia=${dia}&pageSize=1`);
    const auto = data.fontes?.auto || {};
    return { dia, resumo: data.resumo || {}, autoAt: auto.at || '', autoError: auto.erro || '' };
  }

  function adesoesLines(snapshot) {
    const resumo = snapshot.resumo || {};
    const total = Number(resumo.total) || 0;
    if (!total) {
      return [
        `Adesões de hoje (${brFullDate(snapshot.dia)}): nenhum lote encontrado na Entrada de Contratos.`,
        'Se a entrada acabou de sair no S4E, abra a Conferência de Adesões e use Gerar do S4E.',
      ];
    }
    const lines = [
      `Adesões de hoje (${brFullDate(snapshot.dia)}): ${num.format(total)} lote(s), ${num.format(Number(resumo.vidas) || 0)} vida(s), ${money.format(Number(resumo.valor) || 0)}.`,
      `- Conferidos: ${num.format(Number(resumo.conferido) || 0)}`,
      `- Pendentes: ${num.format(Number(resumo.pendente) || 0)}`,
      `- Divergentes: ${num.format(Number(resumo.divergente) || 0)}`,
    ];
    if (snapshot.autoAt) lines.push('', `Última leitura automática: ${stamp(snapshot.autoAt)}.`);
    if (snapshot.autoError) lines.push('A atualização automática falhou; vale a última cópia.');
    return lines;
  }

  async function birthdaysSnapshot() {
    const data = await apiFetch('/api/birthdays');
    const items = Array.isArray(data.birthdays) ? data.birthdays : [];
    const today = items.filter(item => Number(item.daysUntil) === 0);
    const next = items.filter(item => Number(item.daysUntil) > 0)
      .sort((a, b) => Number(a.daysUntil) - Number(b.daysUntil))[0] || null;
    return { total: items.length, today, next };
  }

  function birthdaysLines(snapshot) {
    if (snapshot.today.length) {
      return [
        `Aniversariantes de hoje: ${snapshot.today.length}.`,
        ...snapshot.today.map(item => `- ${item.name}${item.sector ? ` · ${item.sector}` : ''}`),
      ];
    }
    const lines = ['Hoje não há aniversário no setor.'];
    if (snapshot.next) {
      lines.push(`O próximo é ${snapshot.next.name}${snapshot.next.sector ? ` (${snapshot.next.sector})` : ''} em ${snapshot.next.daysUntil} dia(s), em ${brFullDate(snapshot.next.nextDate || snapshot.next.birthday)}.`);
    }
    return lines;
  }

  // ── Snapshots para novas telas ────────────────────────────────────────────
  async function commissionsSnapshot() {
    const data = await apiFetch('/api/commissions');
    const items = Array.isArray(data.items) ? data.items : [];
    const total = Number(data.total) || 0;
    const pending = items.filter(item => item.status === 'pending').length;
    const paid = items.filter(item => item.status === 'paid').length;
    return { total, pending, paid, items };
  }

  function commissionsLines(snapshot) {
    return [
      `Comissões: ${num.format(snapshot.total)} contrato(s) no total.`,
      `- Pendentes: ${num.format(snapshot.pending)}`,
      `- Pagos: ${num.format(snapshot.paid)}`,
      '',
      'Diga "abrir comissões" para ver os detalhes ou "baixar o relatório de comissões" para exportar.',
    ];
  }

  async function financeSnapshot() {
    const today = todayISO();
    const month = today.slice(0, 7);
    const data = await apiFetch(`/api/finance?competencia=${month}`);
    const items = Array.isArray(data.items) ? data.items : [];
    const billed = items.reduce((sum, item) => sum + (Number(item.billed) || 0), 0);
    const received = items.reduce((sum, item) => sum + (Number(item.received) || 0), 0);
    const diff = billed - received;
    return { billed, received, diff, items, competencia: month };
  }

  function financeLines(snapshot) {
    return [
      `Rateios P4X (${snapshot.competencia}):`,
      `- Faturado: ${money.format(snapshot.billed)}`,
      `- Recebido: ${money.format(snapshot.received)}`,
      `- Diferença: ${money.format(snapshot.diff)}`,
      '',
      'Diga "abrir rateios" para ver os detalhes ou "baixar o relatório de rateios" para exportar.',
    ];
  }

  async function apuracaoSnapshot() {
    const today = new Date();
    const competencia = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const data = await apiFetch(`/api/apuracao?competencia=${competencia}`);
    const job = data.job || {};
    return { competencia, empresas: Number(data.empresas) || 0, pagas: Number(data.pagas) || 0, job };
  }

  function apuracaoLines(snapshot) {
    const lines = [
      `Apuração (${snapshot.competencia}):`,
      `- Empresas totais: ${num.format(snapshot.empresas)}`,
      `- Empresas pagas: ${num.format(snapshot.pagas)}`,
    ];
    if (snapshot.job.running) {
      lines.push('', 'Apuração em andamento. Posso acompanhar e te aviso quando terminar.');
    }
    lines.push('', 'Diga "rodar apuração" para iniciar ou "baixar o relatório de apuração" para exportar.');
    return lines;
  }

  async function rateioSnapshot() {
    const today = new Date();
    const competLabel = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const data = await apiFetch(`/api/rateios-faturamento?competencia=${competLabel}`);
    const items = Array.isArray(data.items) ? data.items : [];
    const total = items.reduce((sum, item) => sum + (Number(item.alocado) || 0), 0);
    return { competencia: competLabel, total, items };
  }

  function rateioLines(snapshot) {
    return [
      `Rateio de Faturamento (${snapshot.competencia}):`,
      `- Total alocado: ${money.format(snapshot.total)}`,
      '',
      'Diga "abrir rateio de faturamento" para ver os detalhes ou "baixar o relatório de rateio" para exportar.',
    ];
  }

  async function notasSnapshot() {
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const data = await apiFetch(`/api/notas?mes=${month}`);
    const grupos = Array.isArray(data.grupos) ? data.grupos : [];
    const suspeitos = grupos.filter(g => g.tipo === 'suspeito').length;
    const provaveis = grupos.filter(g => g.tipo === 'provavel').length;
    return { mes: month, suspeitos, provaveis, grupos };
  }

  function notasLines(snapshot) {
    return [
      `Conferência de Notas (${snapshot.mes}):`,
      `- Grupos prováveis: ${num.format(snapshot.provaveis)}`,
      `- Grupos suspeitos: ${num.format(snapshot.suspeitos)}`,
      '',
      'Diga "rodar conferência de notas" para verificar ou "baixar o relatório de notas" para exportar.',
    ];
  }

  async function recibosSnapshot() {
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const data = await apiFetch(`/api/recibos?mes=${month}`);
    const items = Array.isArray(data.items) ? data.items : [];
    return { mes: month, total: items.length, items };
  }

  function recibosLines(snapshot) {
    return [
      `Recibos (${snapshot.mes}): ${num.format(snapshot.total)} empresa(s) com recibos gerados.`,
      '',
      'Diga "gerar recibos" para criar novos ou "baixar os recibos" para exportar o PDF.',
    ];
  }

  async function vendasSnapshot() {
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const data = await apiFetch(`/api/vendas?periodo=${month}`);
    const vendas = Array.isArray(data.vendas) ? data.vendas : [];
    const cancelamentos = Array.isArray(data.cancelamentos) ? data.cancelamentos : [];
    const totalVidas = vendas.reduce((sum, v) => sum + (Number(v.vidas) || 0), 0);
    const totalCancel = cancelamentos.reduce((sum, c) => sum + (Number(c.vidas) || 0), 0);
    return { mes: month, vendas: vendas.length, cancelamentos: cancelamentos.length, totalVidas, totalCancel };
  }

  function vendasLines(snapshot) {
    return [
      `Acompanhamento de Vendas (${snapshot.mes}):`,
      `- Vendas: ${num.format(snapshot.vendas)} · ${num.format(snapshot.totalVidas)} vida(s)`,
      `- Cancelamentos: ${num.format(snapshot.cancelamentos)} · ${num.format(snapshot.totalCancel)} vida(s)`,
      '',
      'Diga "abrir vendas" para ver os detalhes ou "consultar vendas do S4E" para atualizar.',
    ];
  }

  async function retornosSnapshot() {
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const data = await apiFetch(`/api/retornos?start=${month}-01&end=${month}-31`);
    const items = Array.isArray(data.items) ? data.items : [];
    const erros = items.filter(i => i.status === 'erro').length;
    const corrigidos = items.filter(i => i.status === 'corrigido').length;
    return { mes: month, total: items.length, erros, corrigidos, items };
  }

  function retornosLines(snapshot) {
    return [
      `Retorno Instituição (${snapshot.mes}):`,
      `- Total de incidentes: ${num.format(snapshot.total)}`,
      `- Erros: ${num.format(snapshot.erros)}`,
      `- Corrigidos: ${num.format(snapshot.corrigidos)}`,
      '',
      'Diga "abrir retornos" para ver os detalhes.',
    ];
  }

  async function cobrancaSnapshot() {
    const data = await apiFetch('/api/cobranca');
    const items = Array.isArray(data.items) ? data.items : [];
    const total = items.reduce((sum, item) => sum + (Number(item.valor) || 0), 0);
    const atrasados = items.filter(i => i.diasAtraso > 0).length;
    return { total, atrasados, count: items.length, items };
  }

  function cobrancaLines(snapshot) {
    return [
      `Cobrança: ${num.format(snapshot.count)} empresa(s) na fila.`,
      `- Total em aberto: ${money.format(snapshot.total)}`,
      `- Em atraso: ${num.format(snapshot.atrasados)}`,
      '',
      'Diga "abrir cobrança" para ver os detalhes ou "preparar cobrança em lote" para gerar e-mails.',
    ];
  }

  async function answerTasks() {
    const snapshot = await taskSnapshot();
    say([...taskLines(snapshot), '', 'Diga "abrir demandas" para ver a fila ou "me ensine demandas".'].join('\n'));
    celebrate();
  }

  async function answerWeekly() {
    const snapshot = await weeklySnapshot();
    say([...weeklyLines(snapshot), '', 'Para baixar o Excel, peça "baixar o Excel do relatório".'].join('\n'));
    celebrate();
  }

  async function answerAdesoes() {
    const snapshot = await adesoesSnapshot();
    say([...adesoesLines(snapshot), '', 'Diga "abrir adesões" para ver a conferência completa.'].join('\n'));
    celebrate();
  }

  async function answerBirthdays() {
    const snapshot = await birthdaysSnapshot();
    say(birthdaysLines(snapshot).join('\n'));
    celebrate();
  }

  async function answerCommissions() {
    const snapshot = await commissionsSnapshot();
    say(commissionsLines(snapshot).join('\n'));
    celebrate();
  }

  async function answerFinance() {
    const snapshot = await financeSnapshot();
    say(financeLines(snapshot).join('\n'));
    celebrate();
  }

  async function answerApuracao() {
    const snapshot = await apuracaoSnapshot();
    say(apuracaoLines(snapshot).join('\n'));
    celebrate();
  }

  async function answerRateio() {
    const snapshot = await rateioSnapshot();
    say(rateioLines(snapshot).join('\n'));
    celebrate();
  }

  async function answerNotas() {
    const snapshot = await notasSnapshot();
    say(notasLines(snapshot).join('\n'));
    celebrate();
  }

  async function answerRecibos() {
    const snapshot = await recibosSnapshot();
    say(recibosLines(snapshot).join('\n'));
    celebrate();
  }

  async function answerVendas() {
    const snapshot = await vendasSnapshot();
    say(vendasLines(snapshot).join('\n'));
    celebrate();
  }

  async function answerRetornos() {
    const snapshot = await retornosSnapshot();
    say(retornosLines(snapshot).join('\n'));
    celebrate();
  }

  async function answerCobranca() {
    const snapshot = await cobrancaSnapshot();
    say(cobrancaLines(snapshot).join('\n'));
    celebrate();
  }

  async function answerSummary() {
    say('Puxando o resumo do portal…');
    const [tasks, week, ades, birthdays, commissions, finance, cobranca] = await Promise.allSettled([
      taskSnapshot(), weeklySnapshot(), adesoesSnapshot(), birthdaysSnapshot(),
      commissionsSnapshot(), financeSnapshot(), cobrancaSnapshot(),
    ]);
    const lines = [`Resumo de ${longToday()}.`, ''];
    if (tasks.status === 'fulfilled') {
      const value = tasks.value;
      lines.push(`Demandas: ${num.format(value.open)} em aberto · ${num.format(value.overdue.length)} atrasada(s) · ${num.format(value.today)} para hoje.`);
    } else {
      lines.push('Demandas: não consegui ler agora.');
    }
    if (week.status === 'fulfilled') {
      const value = week.value;
      lines.push(`Relatório Semanal: ${num.format(value.companies.length)} empresa(s) e ${num.format(value.establishments.length)} estabelecimento(s) na semana.`);
    } else {
      lines.push('Relatório Semanal: não consegui ler agora.');
    }
    if (ades.status === 'fulfilled') {
      const value = ades.value;
      const total = Number(value.resumo.total) || 0;
      lines.push(total
        ? `Adesões de hoje: ${num.format(total)} lote(s), ${num.format(Number(value.resumo.vidas) || 0)} vida(s), ${money.format(Number(value.resumo.valor) || 0)}.`
        : 'Adesões de hoje: nenhum lote encontrado.');
    } else {
      lines.push('Adesões de hoje: não consegui ler agora.');
    }
    if (commissions.status === 'fulfilled') {
      const value = commissions.value;
      lines.push(`Comissões: ${num.format(value.pending)} pendente(s) de ${num.format(value.total)} contrato(s).`);
    } else {
      lines.push('Comissões: não consegui ler agora.');
    }
    if (finance.status === 'fulfilled') {
      const value = finance.value;
      lines.push(`Rateios P4X: faturado ${money.format(value.billed)}, recebido ${money.format(value.received)}.`);
    } else {
      lines.push('Rateios P4X: não consegui ler agora.');
    }
    if (cobranca.status === 'fulfilled') {
      const value = cobranca.value;
      lines.push(`Cobrança: ${num.format(value.count)} empresa(s) na fila, ${money.format(value.total)} em aberto.`);
    } else {
      lines.push('Cobrança: não consegui ler agora.');
    }
    if (birthdays.status === 'fulfilled') {
      const value = birthdays.value;
      lines.push(value.today.length
        ? `Aniversariantes de hoje: ${value.today.map(item => item.name).join(', ')}.`
        : 'Aniversariantes: nenhum hoje.');
    } else {
      lines.push('Aniversariantes: não consegui ler agora.');
    }

    // Análise proativa
    const alerts = [];
    if (tasks.status === 'fulfilled' && tasks.value.overdue.length > 0) {
      alerts.push(`${tasks.value.overdue.length} demanda(s) atrasada(s) precisam de atenção.`);
    }
    if (week.status === 'fulfilled' && week.value.stale) {
      alerts.push('O Relatório Semanal está desatualizado. Considere atualizar do S4E.');
    }
    if (ades.status === 'fulfilled') {
      const divergentes = Number(ades.value.resumo.divergente) || 0;
      if (divergentes > 0) {
        alerts.push(`${divergentes} lote(s) divergente(s) na Conferência de Adesões.`);
      }
    }
    if (commissions.status === 'fulfilled' && commissions.value.pending > 5) {
      alerts.push(`${commissions.value.pending} comissões pendentes. Vale verificar.`);
    }
    if (finance.status === 'fulfilled' && Math.abs(finance.value.diff) > 10000) {
      alerts.push(`Diferença significativa entre faturado e recebido: ${money.format(finance.value.diff)}.`);
    }
    if (cobranca.status === 'fulfilled' && cobranca.value.atrasados > 0) {
      alerts.push(`${cobranca.value.atrasados} empresa(s) com cobrança em atraso.`);
    }

    if (alerts.length > 0) {
      lines.push('', '⚠️ Atenção:');
      alerts.forEach(alert => lines.push(`- ${alert}`));
    }

    lines.push('', 'Quer que eu abra alguma tela, baixe algum relatório ou execute alguma ação?');
    say(lines.join('\n'));
    celebrate();
  }

  async function proactiveInsights() {
    say('Analisando o portal para alertas e sugestões…');
    const [tasks, week, ades, commissions, finance, cobranca] = await Promise.allSettled([
      taskSnapshot(), weeklySnapshot(), adesoesSnapshot(),
      commissionsSnapshot(), financeSnapshot(), cobrancaSnapshot(),
    ]);

    const insights = [];
    if (tasks.status === 'fulfilled' && tasks.value.overdue.length > 0) {
      insights.push(`🔴 ${tasks.value.overdue.length} demanda(s) atrasada(s). Diga "abrir demandas" para ver.`);
    }
    if (week.status === 'fulfilled' && week.value.stale) {
      insights.push('🟡 Relatório Semanal desatualizado. Diga "atualizar do S4E" para atualizar.');
    }
    if (ades.status === 'fulfilled') {
      const divergentes = Number(ades.value.resumo.divergente) || 0;
      if (divergentes > 0) {
        insights.push(`🟡 ${divergentes} lote(s) divergente(s) em adesões. Diga "abrir adesões" para conferir.`);
      }
    }
    if (commissions.status === 'fulfilled' && commissions.value.pending > 5) {
      insights.push(`🟡 ${commissions.value.pending} comissões pendentes. Diga "baixar relatório de comissões" para analisar.`);
    }
    if (finance.status === 'fulfilled' && Math.abs(finance.value.diff) > 10000) {
      insights.push(`🟡 Diferença de ${money.format(finance.value.diff)} entre faturado e recebido. Diga "abrir rateios" para investigar.`);
    }
    if (cobranca.status === 'fulfilled' && cobranca.value.atrasados > 0) {
      insights.push(`🔴 ${cobranca.value.atrasados} empresa(s) em atraso. Diga "preparar cobrança em lote" para agir.`);
    }

    if (insights.length === 0) {
      say('Tudo parece em ordem por aqui! Continue assim.');
      celebrate();
    } else {
      say(['Encontrei alguns pontos de atenção:', '', ...insights, '', 'Quer que eu abra alguma tela para você?'].join('\n'));
    }
  }

  // ── Ações seguras ────────────────────────────────────────────────────────
  function watchWeekly() {
    clearInterval(state.watchTimer);
    state.lastJobLine = '';
    const started = Date.now();
    state.watchTimer = setInterval(async () => {
      try {
        const data = await apiFetch('/api/semanal');
        const job = data.job || {};
        if (!job.running) {
          clearInterval(state.watchTimer);
          state.watchTimer = null;
          if (job.error) {
            Sound.error();
            say(`A atualização não terminou: ${job.error}`);
            return;
          }
          const companies = (data.empresas || []).length;
          const establishments = (data.estabelecimentos || []).length;
          say(`Atualização concluída. Semana de ${brDate(data.inicio)} a ${brDate(data.fim)}: ${num.format(companies)} empresa(s) e ${num.format(establishments)} estabelecimento(s).\nOs cartões e a tabela do Relatório Semanal já estão atualizados.`);
          celebrate();
          return;
        }
        if (Date.now() - started > 8 * 60 * 1000) {
          clearInterval(state.watchTimer);
          state.watchTimer = null;
          say('A consulta continua em andamento. A barra do Relatório Semanal mostra o progresso; posso verificar de novo quando você pedir.');
          return;
        }
        const line = `${job.message || 'Consultando o S4E…'}${job.total ? ` (${job.done || 0}/${job.total})` : ''}`;
        if (line !== state.lastJobLine) {
          state.lastJobLine = line;
          say(`Atualizando do S4E…\n${line}\nA barra na tela mostra o progresso. Eu aviso quando terminar.`);
        }
      } catch {
        /* tenta de novo na próxima volta */
      }
    }, 5000);
  }

  async function refreshWeekly() {
    openScreen('weeklyScreen');
    const range = currentWeekRange();
    say(`Consultando o S4E para a semana de ${brDate(range.start)} a ${brDate(range.end)}. Vou acompanhar aqui e te aviso quando terminar.`);
    try {
      await apiFetch('/api/semanal/atualizar', {
        method: 'POST',
        body: JSON.stringify({ start: range.start, end: range.end, force: true }),
      });
      watchWeekly();
    } catch (error) {
      if (/já está em andamento/i.test(error.message || '')) {
        say('Já existe uma atualização em andamento. Vou acompanhar e te aviso quando terminar.');
        watchWeekly();
        return;
      }
      throw error;
    }
  }

  async function copyWeekly() {
    openScreen('weeklyScreen');
    say('Abrindo o Relatório Semanal e preparando a mensagem…');
    const button = await waitFor('#copyWeeklyReport', 12000, element => !element.disabled);
    if (!button) {
      say('Ainda não há cadastros nesta semana para copiar. Se quiser, peça "atualizar do S4E".');
      return;
    }
    button.click();
    await sleep(300);
    celebrate();
    say('Mensagem copiada para a área de transferência. Agora é só colar no e-mail ou no WhatsApp.');
  }

  async function exportFile(kind) {
    if (kind === 'demandas') {
      openScreen('reportsScreen');
      say('Preparando o relatório de demandas…');
      const button = await waitFor('#reportCsv', 8000);
      if (!button) {
        say('Não encontrei o botão de exportar em Relatórios.');
        return;
      }
      button.click();
      await sleep(250);
      celebrate();
      say('Relatório de demandas solicitado. O download começa em instantes.');
      return;
    }
    if (kind === 'adesoes') {
      openScreen('adesiScreen');
      say('Gerando a planilha da Conferência de Adesões…');
      const button = await waitFor('#adExportarBtn', 8000);
      if (!button) {
        say('Não encontrei o botão de exportar na Conferência de Adesões.');
        return;
      }
      button.click();
      await sleep(250);
      celebrate();
      say('Planilha solicitada. O download começa em instantes.');
      return;
    }
    if (kind === 'semanal') {
      openScreen('weeklyScreen');
      say('Preparando o Excel do Relatório Semanal…');
      const button = await waitFor('#exportWeeklyXlsx', 12000, element => !element.disabled);
      if (!button) {
        say('Ainda não há cadastros nesta semana para exportar. Se quiser, peça "atualizar do S4E".');
        return;
      }
      button.click();
      await sleep(250);
      celebrate();
      say('Excel solicitado. O download começa em instantes.');
      return;
    }
    if (kind === 'comissoes') {
      openScreen('commissionsScreen');
      say('Preparando o relatório de Comissões…');
      const button = await waitFor('#commissionsExportButton', 8000);
      if (!button) {
        say('Não encontrei o botão de exportar em Comissões.');
        return;
      }
      button.click();
      await sleep(250);
      celebrate();
      say('Relatório solicitado. O download começa em instantes.');
      return;
    }
    if (kind === 'financeiro') {
      openScreen('financeScreen');
      say('Preparando o relatório de Rateios P4X…');
      const button = await waitFor('#financeExportButton', 8000);
      if (!button) {
        say('Não encontrei o botão de exportar em Rateios P4X.');
        return;
      }
      button.click();
      await sleep(250);
      celebrate();
      say('Relatório solicitado. O download começa em instantes.');
      return;
    }
    if (kind === 'apuracao') {
      openScreen('apuracaoScreen');
      say('Preparando o relatório de Apuração…');
      const button = await waitFor('#apExport', 8000);
      if (!button) {
        say('Não encontrei o botão de exportar em Apuração. Rode a apuração primeiro.');
        return;
      }
      button.click();
      await sleep(250);
      celebrate();
      say('Relatório solicitado. O download começa em instantes.');
      return;
    }
    if (kind === 'rateio') {
      openScreen('rateioScreen');
      say('Preparando o relatório de Rateio de Faturamento…');
      const button = await waitFor('#rfExport', 8000);
      if (!button) {
        say('Não encontrei o botão de exportar em Rateio de Faturamento.');
        return;
      }
      button.click();
      await sleep(250);
      celebrate();
      say('Relatório solicitado. O download começa em instantes.');
      return;
    }
    if (kind === 'notas') {
      openScreen('notasScreen');
      say('Preparando o relatório de Conferência de Notas…');
      const button = await waitFor('#ntExport', 8000);
      if (!button) {
        say('Não encontrei o botão de exportar em Conferência de Notas. Rode a conferência primeiro.');
        return;
      }
      button.click();
      await sleep(250);
      celebrate();
      say('Relatório solicitado. O download começa em instantes.');
      return;
    }
    if (kind === 'recibos') {
      openScreen('recibosScreen');
      say('Preparando o PDF dos Recibos…');
      const button = await waitFor('#rcDownload', 8000);
      if (!button) {
        say('Não encontrei o botão de download em Recibos. Gere os recibos primeiro.');
        return;
      }
      button.click();
      await sleep(250);
      celebrate();
      say('PDF solicitado. O download começa em instantes.');
      return;
    }
    if (kind === 'vendas') {
      openScreen('vendasScreen');
      say('Preparando o relatório de Acompanhamento de Vendas…');
      const button = await waitFor('#vendasExport', 8000);
      if (!button) {
        say('Não encontrei o botão de exportar em Acompanhamento de Vendas.');
        return;
      }
      button.click();
      await sleep(250);
      celebrate();
      say('Relatório solicitado. O download começa em instantes.');
      return;
    }
    if (kind === 'retornos') {
      openScreen('retornosScreen');
      say('Preparando o relatório de Retorno Instituição…');
      const button = await waitFor('#retornosExport', 8000);
      if (!button) {
        say('Não encontrei o botão de exportar em Retorno Instituição.');
        return;
      }
      button.click();
      await sleep(250);
      celebrate();
      say('Relatório solicitado. O download começa em instantes.');
      return;
    }
    if (kind === 'cobranca') {
      openScreen('cobrancaScreen');
      say('Preparando o relatório de Cobrança…');
      const button = await waitFor('#cobrancaExport', 8000);
      if (!button) {
        say('Não encontrei o botão de exportar em Cobrança.');
        return;
      }
      button.click();
      await sleep(250);
      celebrate();
      say('Relatório solicitado. O download começa em instantes.');
      return;
    }
    say('Posso baixar relatórios de: adesões, relatório semanal, comissões, financeiro, apuração, rateio, notas, recibos, vendas, retornos e cobrança. Qual você quer?');
  }

  async function openNewTask() {
    openScreen('tasksScreen');
    const button = await waitFor('#newTaskButton', 6000);
    if (!button) {
      say('Não encontrei o botão de nova demanda.');
      return;
    }
    say('Abri o formulário de nova demanda. Preencha título, prazo e responsável; eu posso te ensinar o resto.');
    Sound.pop();
    button.click();
  }

  // ── Ações complexas ───────────────────────────────────────────────────────
  async function runApuracao() {
    openScreen('apuracaoScreen');
    const today = new Date();
    const competLabel = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    say(`Iniciando apuração para ${competLabel}. Vou acompanhar e te aviso quando terminar.`);
    try {
      await apiFetch('/api/apuracao/run', {
        method: 'POST',
        body: JSON.stringify({ competencia: competLabel }),
      });
      watchApuracao();
    } catch (error) {
      if (/já está em andamento/i.test(error.message || '')) {
        say('Já existe uma apuração em andamento. Vou acompanhar e te aviso quando terminar.');
        watchApuracao();
        return;
      }
      throw error;
    }
  }

  function watchApuracao() {
    clearInterval(state.watchTimer);
    state.lastJobLine = '';
    const started = Date.now();
    state.watchTimer = setInterval(async () => {
      try {
        const data = await apiFetch('/api/apuracao/job');
        const job = data.job || {};
        if (!job.running) {
          clearInterval(state.watchTimer);
          state.watchTimer = null;
          if (job.error) {
            Sound.error();
            say(`A apuração não terminou: ${job.error}`);
            return;
          }
          say(`Apuração concluída. ${num.format(job.empresas || 0)} empresa(s) totais, ${num.format(job.pagas || 0)} paga(s).`);
          celebrate();
          return;
        }
        if (Date.now() - started > 15 * 60 * 1000) {
          clearInterval(state.watchTimer);
          state.watchTimer = null;
          say('A apuração continua em andamento. Posso verificar de novo quando você pedir.');
          return;
        }
        const line = `${job.message || 'Apurando…'}${job.total ? ` (${job.done || 0}/${job.total})` : ''}`;
        if (line !== state.lastJobLine) {
          state.lastJobLine = line;
          say(`Apurando…\n${line}\nPosso continuar acompanhando.`);
        }
      } catch {
        /* tenta de novo na próxima volta */
      }
    }, 5000);
  }

  async function runNotas() {
    openScreen('notasScreen');
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    say(`Iniciando conferência de notas para ${month}.`);
    try {
      await apiFetch('/api/notas/run', {
        method: 'POST',
        body: JSON.stringify({ mes: month }),
      });
      watchNotas();
    } catch (error) {
      if (/já está em andamento/i.test(error.message || '')) {
        say('Já existe uma conferência em andamento. Vou acompanhar e te aviso quando terminar.');
        watchNotas();
        return;
      }
      throw error;
    }
  }

  function watchNotas() {
    clearInterval(state.watchTimer);
    state.lastJobLine = '';
    const started = Date.now();
    state.watchTimer = setInterval(async () => {
      try {
        const data = await apiFetch('/api/notas/job');
        const job = data.job || {};
        if (!job.running) {
          clearInterval(state.watchTimer);
          state.watchTimer = null;
          if (job.error) {
            Sound.error();
            say(`A conferência não terminou: ${job.error}`);
            return;
          }
          say(`Conferência concluída. ${num.format(job.provaveis || 0)} grupo(s) provável(is), ${num.format(job.suspeitos || 0)} suspeito(s).`);
          celebrate();
          return;
        }
        if (Date.now() - started > 10 * 60 * 1000) {
          clearInterval(state.watchTimer);
          state.watchTimer = null;
          say('A conferência continua em andamento. Posso verificar de novo quando você pedir.');
          return;
        }
        const line = `${job.message || 'Conferindo…'}${job.total ? ` (${job.done || 0}/${job.total})` : ''}`;
        if (line !== state.lastJobLine) {
          state.lastJobLine = line;
          say(`Conferindo…\n${line}`);
        }
      } catch {
        /* tenta de novo na próxima volta */
      }
    }, 5000);
  }

  async function runRateio() {
    openScreen('rateioScreen');
    const today = new Date();
    const competLabel = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    say(`Atualizando rateio de faturamento para ${competLabel}.`);
    try {
      await apiFetch('/api/rateios-faturamento/run', {
        method: 'POST',
        body: JSON.stringify({ competencia: competLabel }),
      });
      say('Rateio atualizado. Os dados da tela já estão recalculados.');
      celebrate();
    } catch (error) {
      throw error;
    }
  }

  async function runRecibos() {
    openScreen('recibosScreen');
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    say(`Gerando recibos para ${month}.`);
    try {
      await apiFetch('/api/recibos/run', {
        method: 'POST',
        body: JSON.stringify({ mes: month }),
      });
      say('Recibos gerados. Use "baixar os recibos" para baixar o PDF.');
      celebrate();
    } catch (error) {
      throw error;
    }
  }

  async function consultVendas() {
    openScreen('vendasScreen');
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    say(`Consultando vendas do S4E para ${month}.`);
    try {
      await apiFetch('/api/vendas/run', {
        method: 'POST',
        body: JSON.stringify({ periodo: month }),
      });
      watchVendas();
    } catch (error) {
      if (/já está em andamento/i.test(error.message || '')) {
        say('Já existe uma consulta em andamento. Vou acompanhar e te aviso quando terminar.');
        watchVendas();
        return;
      }
      throw error;
    }
  }

  function watchVendas() {
    clearInterval(state.watchTimer);
    state.lastJobLine = '';
    const started = Date.now();
    state.watchTimer = setInterval(async () => {
      try {
        const data = await apiFetch('/api/vendas/job');
        const job = data.job || {};
        if (!job.running) {
          clearInterval(state.watchTimer);
          state.watchTimer = null;
          if (job.error) {
            Sound.error();
            say(`A consulta não terminou: ${job.error}`);
            return;
          }
          say(`Consulta concluída. ${num.format(job.vendas || 0)} venda(s), ${num.format(job.cancelamentos || 0)} cancelamento(s).`);
          celebrate();
          return;
        }
        if (Date.now() - started > 10 * 60 * 1000) {
          clearInterval(state.watchTimer);
          state.watchTimer = null;
          say('A consulta continua em andamento. Posso verificar de novo quando você pedir.');
          return;
        }
        const line = `${job.message || 'Consultando…'}${job.total ? ` (${job.done || 0}/${job.total})` : ''}`;
        if (line !== state.lastJobLine) {
          state.lastJobLine = line;
          say(`Consultando S4E…\n${line}`);
        }
      } catch {
        /* tenta de novo na próxima volta */
      }
    }, 5000);
  }

  async function prepareCobranca() {
    openScreen('cobrancaScreen');
    say('Preparando cobrança em lote. Abri a tela de Cobrança para você configurar os e-mails.');
    const button = await waitFor('#cobrancaBulkButton', 8000);
    if (!button) {
      say('Não encontrei o botão de cobrança em lote.');
      return;
    }
    button.click();
    say('Cobrança em lote iniciada. Revise os e-mails antes de enviar.');
    celebrate();
  }

  // ── Agendamentos ─────────────────────────────────────────────────────────
  async function listSchedules() {
    const data = await apiFetch('/api/sabi/schedules');
    const schedules = data.schedules || [];
    if (schedules.length === 0) {
      say('Você não tem nenhum agendamento configurado. Para criar, diga algo como "baixar relatório de comissões todo dia às 9h".');
      return;
    }
    const lines = ['Seus agendamentos:'];
    schedules.forEach(s => {
      const status = s.enabled ? '✓ Ativo' : '✗ Inativo';
      lines.push(`- ${s.action} ${s.kind} às ${s.time} (${status})`);
    });
    say(lines.join('\n'));
  }

  async function addSchedule(action, kind, timeStr) {
    try {
      const data = await apiFetch('/api/sabi/schedules', {
        method: 'POST',
        body: JSON.stringify({ action, kind, time: timeStr, enabled: true }),
      });
      const schedule = data.schedule;
      say(`Agendamento criado: ${schedule.action} ${schedule.kind} às ${schedule.time}.`);
      celebrate();
    } catch (error) {
      say(`Não consegui criar o agendamento: ${error?.message || 'erro desconhecido'}.`);
    }
  }

  async function removeSchedule(scheduleId) {
    try {
      await apiFetch(`/api/sabi/schedules/${scheduleId}`, { method: 'DELETE' });
      say('Agendamento removido.');
      celebrate();
    } catch (error) {
      say(`Não consegui remover o agendamento: ${error?.message || 'erro desconhecido'}.`);
    }
  }

  function parseScheduleRequest(text) {
    const patterns = [
      /(?:baixar|exportar|gerar).*(?:relatorio|relatório|planilha|excel)\s+(?:de\s+)?(\w+)\s*(?:todo dia|diariamente|todos os dias)?\s*(?:às|as)\s*(\d{1,2}:\d{2})/i,
      /(?:agendar|programar|configurar).*(?:baixar|exportar|gerar).*(?:relatorio|relatório|planilha|excel)\s+(?:de\s+)?(\w+)\s*(?:todo dia|diariamente|todos os dias)?\s*(?:às|as)\s*(\d{1,2}:\d{2})/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const kindMap = {
          'demandas': 'demandas',
          'demanda': 'demandas',
          'tarefa': 'demandas',
          'tarefas': 'demandas',
          'adesoes': 'adesoes',
          'adesão': 'adesoes',
          'comissoes': 'comissoes',
          'comissao': 'comissoes',
          'financeiro': 'financeiro',
          'rateios': 'financeiro',
          'apuracao': 'apuracao',
          'apuração': 'apuracao',
          'rateio': 'rateio',
          'notas': 'notas',
          'recibos': 'recibos',
          'vendas': 'vendas',
          'retornos': 'retornos',
          'cobranca': 'cobranca',
          'cobrança': 'cobranca',
          'semanal': 'semanal',
        };
        const kind = kindMap[match[1].toLowerCase()] || match[1].toLowerCase();
        return { action: 'export', kind, time: match[2] };
      }
    }
    return null;
  }

  function searchRequest(raw) {
    const match = raw.match(/(?:buscar|busca|procurar|procura|pesquisar|pesquisa)\s+(?:por\s+)?(.+?)\s+(?:em|na|no|nas|nos)\s+(ades\w*|confer\w*|lotes?|contratos?|contrato)/i);
    if (!match) return null;
    const term = match[1].replace(/^["'“”]+|["'“”]+$/g, '').trim();
    if (term.length < 2) return null;
    return { term, screen: /contrat/i.test(match[2]) ? 'contractsScreen' : 'adesiScreen' };
  }

  async function runSearch(screenId, term) {
    openScreen(screenId);
    const selector = screenId === 'adesiScreen' ? '#adSearch' : '#contractsSearch';
    const field = await waitFor(selector, 6000);
    if (!field) {
      say('Não encontrei o campo de busca desta tela.');
      return;
    }
    field.value = term;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    celebrate();
    say(`Busquei "${term}" em ${SCREEN_LABELS[screenId]}.`);
  }

  // ── Passo a passo ────────────────────────────────────────────────────────
  function buildTour() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'sabi-tour';
    overlay.innerHTML = `
      <div class="sabi-spot" id="sabiSpot" aria-hidden="true"></div>
      <section class="sabi-coach" id="sabiCoach" role="dialog" aria-label="Passo a passo do Sabi">
        <div class="sabi-coach-head">
          <img id="sabiCoachImage" alt="" width="44" height="44">
          <div><strong>Sabi</strong><small id="sabiCoachStep">Passo 1</small></div>
          <button type="button" class="sabi-coach-close" id="sabiCoachClose" aria-label="Fechar passo a passo">×</button>
        </div>
        <p id="sabiCoachText" aria-live="polite"></p>
        <div class="sabi-coach-actions">
          <button type="button" class="sabi-ghost" id="sabiCoachPrev">Voltar</button>
          <button type="button" class="sabi-primary" id="sabiCoachNext">Próximo</button>
        </div>
      </section>`;
    document.body.appendChild(overlay);
    spot = overlay.querySelector('#sabiSpot');
    coach = overlay.querySelector('#sabiCoach');
    coachText = overlay.querySelector('#sabiCoachText');
    coachStep = overlay.querySelector('#sabiCoachStep');
    coachPrev = overlay.querySelector('#sabiCoachPrev');
    coachNext = overlay.querySelector('#sabiCoachNext');
    coachImage = overlay.querySelector('#sabiCoachImage');
    coachImage.src = imageUrl(state.effective);
    overlay.querySelector('#sabiCoachClose').addEventListener('click', () => endTour());
    coachPrev.addEventListener('click', () => showStep(state.tour.index - 1));
    coachNext.addEventListener('click', () => showStep(state.tour.index + 1));
  }

  function startTour(requested) {
    const screenId = requested || activeScreen();
    const steps = TOURS[screenId];
    if (!steps) {
      say(`Ainda não tenho um passo a passo pronto para ${SCREEN_LABELS[screenId] || 'esta tela'}. Posso ensinar todas as telas do portal: Início, Demandas, Relatórios, Painel da Gestão, Mala Direta, Quadro de Planilhas, Relatório Semanal, Sindicatos, Contratos, Vendas, Vidas, Comissões, Rateios P4X, Retornos, Cobrança, Apuração, Rateio de Faturamento, Recibos, Adesões, Aniversariantes, Conversas, Mural da Equipe e Central de E-mails.`);
      Sound.error();
      return;
    }
    close();
    buildTour();
    state.tour = { screenId, steps, index: -1, token: 0, target: null };
    overlay.hidden = false;
    coachImage.src = imageUrl(state.effective);
    openScreen(screenId);
    setTimeout(() => showStep(0), 320);
  }

  async function showStep(index) {
    const tour = state.tour;
    if (!tour) return;
    if (index < 0) index = 0;
    if (index >= tour.steps.length) {
      endTour(true);
      open();
      say('Passo a passo concluído. Se quiser repetir, é só pedir "me ensine esta tela".');
      Sound.chirp();
      mood('wave', 1600);
      return;
    }
    const token = ++tour.token;
    tour.index = index;
    const step = tour.steps[index];
    coach.classList.add('is-loading');
    coachPrev.disabled = true;
    coachNext.disabled = true;
    if (activeScreen() !== tour.screenId) openScreen(tour.screenId);
    const target = await waitForTourTarget(step.sel, token);
    if (!state.tour || token !== tour.token) return;
    if (!target) {
      coach.classList.remove('is-loading');
      coachPrev.disabled = false;
      coachNext.disabled = false;
      showStep(index + 1);
      return;
    }
    tour.target = target;
    coachText.textContent = step.text;
    coachStep.textContent = `Passo ${index + 1} de ${tour.steps.length} · ${SCREEN_LABELS[tour.screenId] || ''}`;
    coachPrev.hidden = index === 0;
    coachNext.textContent = index === tour.steps.length - 1 ? 'Concluir' : 'Próximo';
    coachPrev.disabled = false;
    coachNext.disabled = false;
    coach.classList.remove('is-loading');
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    place(target);
    setTimeout(() => {
      if (state.tour && token === tour.token) place(target);
    }, reduce ? 0 : 280);
    Sound.tick();
  }

  async function waitForTourTarget(selector, token) {
    const tour = state.tour;
    const started = Date.now();
    while (Date.now() - started < 2600) {
      if (!state.tour || state.tour !== tour || state.tour.token !== token) return null;
      const element = document.querySelector(selector);
      if (element && visible(element)) return element;
      await sleep(120);
    }
    return null;
  }

  function place(target) {
    if (!state.tour || !target || !target.isConnected) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const raw = target.getBoundingClientRect();
    const pad = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const top = Math.max(6, raw.top - pad);
    const bottom = Math.min(viewportHeight - 6, raw.bottom + pad);
    const left = Math.max(6, raw.left - pad);
    const right = Math.min(viewportWidth - 6, raw.right + pad);
    spot.style.transition = reduce ? 'none' : 'all .22s ease';
    spot.style.top = `${top}px`;
    spot.style.left = `${left}px`;
    spot.style.width = `${Math.max(10, right - left)}px`;
    spot.style.height = `${Math.max(10, bottom - top)}px`;

    const gap = 14;
    const coachWidth = coach.offsetWidth;
    const coachHeight = coach.offsetHeight;
    let coachTop = bottom + gap;
    if (coachTop + coachHeight > viewportHeight - 12) coachTop = top - gap - coachHeight;
    if (coachTop < 12) coachTop = Math.min(viewportHeight - coachHeight - 12, Math.max(12, bottom + gap));
    let coachLeft = left + (right - left) / 2 - coachWidth / 2;
    coachLeft = Math.max(12, Math.min(coachLeft, viewportWidth - coachWidth - 12));
    coach.style.top = `${Math.max(12, coachTop)}px`;
    coach.style.left = `${coachLeft}px`;
  }

  function schedulePlace() {
    if (!state.tour || rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      place(state.tour?.target);
    });
  }

  function endTour(quiet = false) {
    if (!state.tour) return;
    state.tour = null;
    if (overlay) overlay.hidden = true;
    if (!quiet) {
      open();
      say('Passo a passo fechado. Quando quiser, é só pedir "me ensine esta tela".');
    }
  }

  // ── Comandos ─────────────────────────────────────────────────────────────
  function handleCommand(raw) {
    const text = String(raw || '').trim();
    if (!text) return;
    const query = norm(text);
    inputNode.value = '';
    showError('');

    if (state.pending) {
      if (/^(sim|pode|executar|executa|confirma|confirmo|manda|vai)\b/.test(query)) {
        resolveConfirm(true);
        return;
      }
      if (/^(nao|cancela|cancelar|deixa|depois)\b/.test(query)) {
        resolveConfirm(false);
        return;
      }
      clearConfirm();
    }

    if (/^(oi|ola|opa|bom dia|boa tarde|boa noite|e ai|tudo bem|tudo bom)\b/.test(query)) {
      say(`${greeting()}! Que bom te ver. Quer o resumo do dia, um passo a passo ou uma música?`);
      Sound.chirp();
      mood('wave', 1400);
      return;
    }

    if (/(quem e voce|seu nome|qual seu nome|o que voce (faz|sabe|pode)|se apresenta)/.test(query)) {
      say('Sou o Sabi, o assistente do portal. Eu abro telas, ensino o passo a passo, respondo com os dados do portal, baixo relatórios automaticamente e executo ações complexas como apuração e conferência de notas — sempre com a sua confirmação quando a ação mexe em alguma coisa.');
      Sound.pop();
      return;
    }

    if (/^(obrigad|valeu|agradec)/.test(query)) {
      say('De nada! Estou aqui se precisar.');
      Sound.chirp();
      return;
    }

    if (/(^|\b)(ajuda|comandos|me ajuda|o que voce pode fazer|como funciona)\b/.test(query)) {
      say([
        'Posso fazer isto:',
        '- abrir telas: "abrir adesões", "abrir demandas", "abrir comissões", "abrir rateios", etc.',
        '- ensinar: "me ensine o relatório semanal", "me ensine esta tela"',
        '- responder números: "quantas demandas", "comissões pendentes", "rateios do mês", "cobrança em aberto"',
        '- resumo do dia: "resumo do dia"',
        '- baixar relatórios: "baixar relatório de comissões", "exportar rateios", "baixar apuração"',
        '- executar ações: "rodar apuração", "conferir notas", "gerar recibos", "consultar vendas S4E"',
        '- agendar downloads: "baixar relatório de comissões todo dia às 9h"',
        '- ver agendamentos: "listar agendamentos"',
        '- atalhos seguros: "atualizar do S4E" (com confirmação), "copiar mensagem do relatório", "nova demanda"',
        '- buscar: "buscar ACME em adesões"',
        '- cantar e assobiar',
      ].join('\n'));
      Sound.pop();
      return;
    }

    if (/(desliga|desligar|tira|tirar) o som|sem som|silencio|silenciar|mutar/.test(query)) {
      setMuted(true);
      say('Som desligado. É só pedir para ligar de novo.');
      return;
    }
    if (/^(liga|ligar|ativa|ativar|volta|voltar) o som|^com som/.test(query)) {
      setMuted(false);
      say('Som ligado.');
      return;
    }
    if (/\bcant(a|ar|e)\b|uma musica|melodia/.test(query)) {
      sing();
      return;
    }
    if (/\bassovi(a|ar|e)\b|assobiar|assobio/.test(query)) {
      whistle();
      return;
    }

    const look = detectLook(query);
    if (look && /look|roupa|traje|vestir|fantasia|troca/.test(query)) {
      choose(look);
      const name = LOOKS.find(item => item.id === look)?.name || look;
      say(`Trocando o look para ${name}.`);
      return;
    }

    if (/(ensina|ensinar|ensine|como (usar|mexer|faco|fazer|funciona)|tutorial|passo a passo|me guia|me acompanha)/.test(query)) {
      startTour(detectScreen(query) || activeScreen());
      return;
    }

    const search = searchRequest(text);
    if (search) {
      runSafely(() => runSearch(search.screen, search.term));
      return;
    }

    const screen = detectScreen(query);

    if (screen && /^(abrir|abre|ir para|vai para|ir|vai|levar|leva|mostrar|mostra|navegar)\b/.test(query)) {
      openScreen(screen);
      say(`Abri ${SCREEN_LABELS[screen] || 'a tela'}.`);
      Sound.pop();
      mood('wave', 1200);
      return;
    }

    if (/(atualiza|atualizar|consulta|consultar|puxa|puxar|sincroniza|sincronizar)/.test(query)
      && /(s4e|semanal|cadastro|relatorio)/.test(query) && !/adesao|adesoes|nota|apuracao|venda/.test(query)) {
      askConfirm('Vou consultar o S4E e atualizar o Relatório Semanal da semana atual. Pode levar alguns minutos. Executar agora?', refreshWeekly);
      return;
    }

    if (/(copia|copiar)/.test(query) && /(mensagem|relatorio|semanal)/.test(query)) {
      runSafely(copyWeekly);
      return;
    }

    if (/(baixa|baixar|exporta|exportar|planilha|excel|relatorio)/.test(query)) {
      if (/demanda|tarefa/.test(query)) {
        runSafely(() => exportFile('demandas'));
        return;
      }
      if (/adesao|adesoes|conferencia|lote/.test(query)) {
        runSafely(() => exportFile('adesoes'));
        return;
      }
      if (/semanal|cadastro|empresa/.test(query) && !/comissao|financeiro|apuracao|rateio|nota|recibo|venda|retorno|cobranca/.test(query)) {
        runSafely(() => exportFile('semanal'));
        return;
      }
      if (/comissao|comissoes/.test(query)) {
        runSafely(() => exportFile('comissoes'));
        return;
      }
      if (/financeiro|rateio p4x|rateios p4x/.test(query)) {
        runSafely(() => exportFile('financeiro'));
        return;
      }
      if (/apuracao/.test(query)) {
        runSafely(() => exportFile('apuracao'));
        return;
      }
      if (/rateio(?! p4x)/.test(query)) {
        runSafely(() => exportFile('rateio'));
        return;
      }
      if (/nota|notas|conferencia de notas/.test(query)) {
        runSafely(() => exportFile('notas'));
        return;
      }
      if (/recibo|recibos/.test(query)) {
        runSafely(() => exportFile('recibos'));
        return;
      }
      if (/venda|vendas/.test(query)) {
        runSafely(() => exportFile('vendas'));
        return;
      }
      if (/retorno|retornos/.test(query)) {
        runSafely(() => exportFile('retornos'));
        return;
      }
      if (/cobranca|cobrancas/.test(query)) {
        runSafely(() => exportFile('cobranca'));
        return;
      }
      say('Posso baixar relatórios de: demandas, adesões, relatório semanal, comissões, financeiro, apuração, rateio, notas, recibos, vendas, retornos e cobrança. Qual você quer?');
      return;
    }

    if (/(nova|criar|cria|formulario)/.test(query) && /(demanda|tarefa)/.test(query)) {
      runSafely(openNewTask);
      return;
    }

    if (/demanda|tarefa/.test(query) && /(quant|como (esta|estao)|resumo|atrasad|abert|hoje|pendente|andamento|conclu|fila)/.test(query)) {
      runSafely(answerTasks);
      return;
    }
    if (/(empresa|cadastro|semana|semanal)/.test(query) && /(quant|como (esta|estao)|resumo|atualiz|cadastr|empresa|semana)/.test(query)) {
      runSafely(answerWeekly);
      return;
    }
    if (/(adesao|adesoes|lote|conferencia)/.test(query) && /(hoje|quant|confer|resumo|status|como (esta|estao))/.test(query)) {
      runSafely(answerAdesoes);
      return;
    }
    if (/comissao|comissoes/.test(query) && /(quant|como (esta|estao)|resumo|pendente|pago|status)/.test(query)) {
      runSafely(answerCommissions);
      return;
    }
    if (/financeiro|rateio p4x|rateios p4x/.test(query) && /(quant|como (esta|estao)|resumo|faturado|recebido)/.test(query)) {
      runSafely(answerFinance);
      return;
    }
    if (/apuracao/.test(query) && /(quant|como (esta|estao)|resumo|empresa|paga)/.test(query)) {
      runSafely(answerApuracao);
      return;
    }
    if (/rateio(?! p4x)/.test(query) && /(quant|como (esta|estao)|resumo|alocado)/.test(query)) {
      runSafely(answerRateio);
      return;
    }
    if (/nota|notas|conferencia de notas/.test(query) && /(quant|como (esta|estao)|resumo|grupo|suspeito|provavel)/.test(query)) {
      runSafely(answerNotas);
      return;
    }
    if (/recibo|recibos/.test(query) && /(quant|como (esta|estao)|resumo|empresa)/.test(query)) {
      runSafely(answerRecibos);
      return;
    }
    if (/venda|vendas/.test(query) && /(quant|como (esta|estao)|resumo|cancelamento)/.test(query)) {
      runSafely(answerVendas);
      return;
    }
    if (/retorno|retornos/.test(query) && /(quant|como (esta|estao)|resumo|erro|corrigido)/.test(query)) {
      runSafely(answerRetornos);
      return;
    }
    if (/cobranca|cobrancas/.test(query) && /(quant|como (esta|estao)|resumo|fila|aberto|atraso)/.test(query)) {
      runSafely(answerCobranca);
      return;
    }
    if (/aniversari/.test(query)) {
      runSafely(answerBirthdays);
      return;
    }
    if (/(resumo|panorama|visao geral|como estamos|o que tem hoje|o que temos hoje)/.test(query)) {
      runSafely(answerSummary);
      return;
    }
    if (/(alerta|analise|insight|atencao|o que precisa|revisar|verificar)/.test(query)) {
      runSafely(proactiveInsights);
      return;
    }

    // Agendamentos
    const schedule = parseScheduleRequest(text);
    if (schedule) {
      askConfirm(`Vou agendar: ${schedule.action} ${schedule.kind} todo dia às ${schedule.time}. Confirmar?`, () => addSchedule(schedule.action, schedule.kind, schedule.time));
      return;
    }
    if (/(agendamento|schedule|programa|configuracao)/.test(query) && /(listar|ver|mostrar|quais|meus)/.test(query)) {
      runSafely(listSchedules);
      return;
    }
    if (/(remover|deletar|apagar|cancelar)/.test(query) && /agendamento/.test(query)) {
      say('Para remover um agendamento, peça "listar agendamentos" primeiro e depois me diga qual remover pelo índice.');
      return;
    }

    // Ações complexas
    if (/(rodar|executar|iniciar|correr|run)/.test(query) && /apuracao/.test(query)) {
      askConfirm('Vou rodar a apuração mensal. Isso vai buscar as notas oficiais e conferir os lotes. Pode levar alguns minutos. Executar agora?', runApuracao);
      return;
    }
    if (/(rodar|executar|iniciar|correr|conferir|verificar)/.test(query) && /nota|notas/.test(query)) {
      askConfirm('Vou rodar a conferência de notas. Isso vai procurar NF e lote duplicados no S4E. Executar agora?', runNotas);
      return;
    }
    if (/(rodar|executar|iniciar|correr|atualizar|recalcular)/.test(query) && /rateio(?! p4x)/.test(query)) {
      askConfirm('Vou atualizar o rateio de faturamento. Isso vai recalcular a distribuição. Executar agora?', runRateio);
      return;
    }
    if (/(gerar|criar)/.test(query) && /recibo|recibos/.test(query)) {
      askConfirm('Vou gerar os recibos do período atual. Isso vai ler os dados do S4E e preparar os PDFs. Executar agora?', runRecibos);
      return;
    }
    if (/(consultar|puxar|atualizar|buscar)/.test(query) && /venda|vendas/.test(query) && /s4e/.test(query)) {
      askConfirm('Vou consultar as vendas e cancelamentos do S4E. Isso pode levar alguns minutos. Executar agora?', consultVendas);
      return;
    }
    if (/(preparar|montar|iniciar)/.test(query) && /cobranca|cobrancas/.test(query)) {
      runSafely(prepareCobranca);
      return;
    }

    if (screen) {
      openScreen(screen);
      say(`Abri ${SCREEN_LABELS[screen] || 'a tela'}.`);
      Sound.pop();
      mood('wave', 1200);
      return;
    }

    say('Ainda não entendi esse pedido. Posso abrir telas, ensinar o passo a passo, responder números do portal e executar atalhos seguros.\nExperimente: "resumo do dia", "quantas demandas", "abrir adesões", "me ensine o relatório semanal" ou "cantar".');
    Sound.error();
  }

  async function sync() {
    const user = adminUser();
    if (!user) {
      if (root && !root.hidden) {
        close();
        endTour(true);
        clearInterval(state.watchTimer);
        state.watchTimer = null;
        root.hidden = true;
      }
      state.loaded = false;
      return;
    }
    if (!state.loaded && Date.now() - state.failedAt > 15000) await load();
    if (root.hidden) {
      root.hidden = false;
      render();
    }
  }

  function trackScreens() {
    const portal = window.PortalAccess;
    if (!portal || portal.__sabiScreens) return;
    const original = portal.openScreen;
    if (typeof original !== 'function') return;
    portal.openScreen = screenId => {
      original(screenId);
      if (state.open) updateTip();
    };
    portal.__sabiScreens = true;
  }

  build();
  trackScreens();
  setInterval(trackScreens, 2000);
  setInterval(sync, 1500);
  sync();
})();
