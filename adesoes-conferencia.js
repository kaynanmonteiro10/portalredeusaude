/* Conferência de Adesões — zero trabalho manual na conferência.
   A tela mostra o dia, o lote e o resultado da conferência automática.
   O backend (adesoes_conferencia.py) confere contra a Entrada de Contratos,
   a Movimentação de Vidas, o Faturamento e as Notas do S4E. */
(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const api = (path, options) => window.PortalAccess.api(path, options);
  const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const inteiro = new Intl.NumberFormat('pt-BR');
  const state = { data: null, dia: '', page: 1, conferindo: false, gerando: false, ativo: false, equipes: [] };

  const STATUS_BADGE = {
    conferido: '<span class="ad-badge conferido">✅ Conferido</span>',
    divergente: '<span class="ad-badge divergente">⚠️ Divergente</span>',
    pendente: '<span class="ad-badge pendente">⏳ Pendente</span>',
  };

  function badge(status) {
    return STATUS_BADGE[status] || STATUS_BADGE.pendente;
  }

  function tipoBadge(tipo) {
    const value = (tipo || '').toUpperCase();
    return `<span class="ad-tipo ${value === 'CRM' ? 'CRM' : 'WEB'}">${value === 'CRM' ? 'CRM' : 'WEB'}</span>`;
  }

  function filtros() {
    const params = new URLSearchParams();
    const inicio = byId('adInicio')?.value || '';
    const fim = byId('adFim')?.value || '';
    const tipo = byId('adTipo')?.value || '';
    const status = byId('adStatus')?.value || '';
    const busca = (byId('adSearch')?.value || '').trim();
    if (state.dia) params.set('dia', state.dia);
    if (inicio) params.set('inicio', inicio);
    if (fim) params.set('fim', fim);
    if (tipo) params.set('tipo', tipo);
    (state.equipes || []).forEach(equipe => params.append('equipe', equipe));
    if (status) params.set('status', status);
    if (busca) params.set('busca', busca);
    params.set('page', String(state.page));
    params.set('pageSize', '60');
    return params;
  }

  function dataIso(data) {
    return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}-${String(data.getDate()).padStart(2, '0')}`;
  }

  function dataHora(iso) {
    const data = new Date(iso || '');
    if (!iso || Number.isNaN(data.getTime())) return '';
    return data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function preencherFiltros() {
    const inicio = byId('adInicio');
    const fim = byId('adFim');
    if (inicio && !inicio.value && fim && !fim.value) {
      const hoje = new Date();
      inicio.value = dataIso(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
      fim.value = dataIso(hoje);
    }
  }

  function renderFontes(fontes) {
    const host = byId('adFontes');
    if (!host) return;
    fontes = fontes || {};
    const vendas = fontes.vendas || {};
    const faturamento = fontes.faturamento || {};
    const vidas = fontes.vidas || {};
    const auto = fontes.auto || {};
    const horarios = (auto.horarios || [10, 16]).map(hora => `${hora}h`).join(' e ');
    const ultima = dataHora(auto.at);
    const autoDetalhe = auto.erro
      ? 'falhou — vale a última cópia'
      : (ultima ? `última ${ultima}` : 'aguardando a próxima');
    host.innerHTML = [
      `<span class="ad-fonte ${vendas.ok ? '' : 'off'}"><i></i>Entrada de Contratos <small>${vendas.ok ? `${inteiro.format(vendas.lotes || 0)} lote(s) até ${esc(vendas.ate ? vendas.ate.split('-').reverse().join('/') : '')}` : 'consulte em Vendas'}</small></span>`,
      `<span class="ad-fonte ${faturamento.ok ? '' : 'off'}"><i></i>Faturamento (parcela) <small>${faturamento.ok ? `${inteiro.format(faturamento.linhas || 0)} títulos` : 'importe na Cobrança'}</small></span>`,
      `<span class="ad-fonte ${vidas.ok ? '' : 'off'}"><i></i>Movimentação de Vidas <small>${vidas.ok ? `${inteiro.format(vidas.registros || 0)} vidas` : 'sem importação'}</small></span>`,
      `<span class="ad-fonte ${auto.erro || !ultima ? 'off' : ''}"><i></i>Atualização automática <small>${horarios} · ${esc(autoDetalhe)}</small></span>`,
    ].join('');
  }

  function renderAviso(cobertura) {
    const host = byId('adAviso');
    if (!host) return;
    cobertura = cobertura || {};
    const faltando = cobertura.faltando || [];
    const faturamento = cobertura.faturamento || {};
    const auto = cobertura.auto || {};
    const partes = [];
    if (faltando.length) {
      const nomes = faltando.map(item => item.mes).join(', ');
      partes.push(`A Entrada de Contratos do S4E ainda não cobre ${nomes}. Consulte esses meses em <strong>Vendas → Consultar S4E</strong> e clique em <strong>Gerar do S4E</strong> de novo.`);
    }
    if (!faturamento.ok) {
      partes.push('A cópia do faturamento do S4E não está neste servidor — sem ela a data de adesão e a parcela não entram. Baixe em <strong>Cobrança → Importar do S4E</strong>.');
    }
    if (auto.erro) {
      const tentativa = dataHora(auto.tentativa);
      const motivo = String(auto.erro).replace(/\.+$/, '');
      partes.push(`A atualização automática do S4E falhou${tentativa ? ` em ${esc(tentativa)}` : ''}: ${esc(motivo)}. A cópia anterior continua valendo.`);
    }
    host.hidden = !partes.length;
    host.innerHTML = partes.join('<br>');
  }

  function renderKpis(resumo) {
    const host = byId('adKpis');
    if (!host) return;
    resumo = resumo || {};
    host.innerHTML = [
      `<article class="ad-kpi info"><span>Adesões</span><strong>${inteiro.format(resumo.total || 0)}</strong><small>${inteiro.format(resumo.vidas || 0)} vidas · ${money.format(resumo.valor || 0)}</small></article>`,
      `<article class="ad-kpi ok"><span>Conferidas</span><strong>${inteiro.format(resumo.conferido || 0)}</strong><small>sem pendência</small></article>`,
      `<article class="ad-kpi bad"><span>Divergentes</span><strong>${inteiro.format(resumo.divergente || 0)}</strong><small>precisa corrigir</small></article>`,
      `<article class="ad-kpi warn"><span>Pendentes</span><strong>${inteiro.format(resumo.pendente || 0)}</strong><small>falta uma fonte</small></article>`,
      `<article class="ad-kpi"><span>WEB</span><strong>${inteiro.format(resumo.web || 0)}</strong><small>adesões web</small></article>`,
      `<article class="ad-kpi"><span>CRM</span><strong>${inteiro.format(resumo.crm || 0)}</strong><small>adesões CRM</small></article>`,
    ].join('');
  }

  function renderEquipes(equipes) {
    const host = byId('adTeamChips');
    if (!host) return;
    equipes = equipes || [];
    state.equipes = (state.equipes || []).filter(item => equipes.includes(item));
    const todas = state.equipes.length === 0;
    host.innerHTML = [
      `<button type="button" class="ad-team-chip ${todas ? 'active' : ''}" data-ad-team="" aria-pressed="${todas}">Todas</button>`,
      ...equipes.map(item => {
        const ativa = state.equipes.includes(item);
        return `<button type="button" class="ad-team-chip ${ativa ? 'active' : ''}" data-ad-team="${esc(item)}" aria-pressed="${ativa}">${esc(item)}</button>`;
      }),
    ].join('');
  }

  function renderDias(dias) {
    const host = byId('adDays');
    const contador = byId('adDaysCount');
    if (!host) return;
    dias = dias || [];
    if (contador) contador.textContent = `${dias.length} dia${dias.length === 1 ? '' : 's'}`;
    if (!dias.length) {
      host.innerHTML = '<p class="ad-empty">Nenhum dia com adesão neste filtro.</p>';
      return;
    }
    host.innerHTML = dias.map(dia => {
      const pendentes = dia.pendente || 0;
      const divergentes = dia.divergente || 0;
      const conferidos = dia.conferido || 0;
      const estado = divergentes ? 'bad' : (pendentes ? 'warn' : 'ok');
      const etiqueta = divergentes ? `${divergentes} divergente${divergentes === 1 ? '' : 's'}`
        : (pendentes ? `${pendentes} pendente${pendentes === 1 ? '' : 's'}` : 'conferido');
      return `<button type="button" class="ad-day ${state.dia === dia.dia ? 'active' : ''}" data-ad-day="${esc(dia.dia)}">
        <b>${esc(dia.dia)}</b>
        <em class="${estado}">${etiqueta}</em>
        <small>${inteiro.format(dia.total)} adesão(ões) · ${conferidos} conferida(s) · WEB ${dia.web} · CRM ${dia.crm}</small>
      </button>`;
    }).join('');
  }

  function renderDiaBar() {
    const bar = byId('adDayBar');
    if (!bar) return;
    if (!state.dia) {
      bar.hidden = true;
      return;
    }
    const dias = state.data?.dias || [];
    const info = dias.find(item => item.dia === state.dia);
    bar.hidden = false;
    byId('adDayLabel').textContent = `Dia ${state.dia}`;
    byId('adDayInfo').textContent = info
      ? `${inteiro.format(info.total)} adesão(ões) · lotes ${info.lotes.slice(0, 8).join(', ')}${info.lotes.length > 8 ? '…' : ''}`
      : 'Sem adesões neste dia';
  }

  function renderTabela(registros) {
    const body = byId('adTableBody');
    if (!body) return;
    if (!registros || !registros.length) {
      body.innerHTML = '<tr><td colspan="11" class="ad-empty">Nenhuma adesão neste filtro. Escolha outro período, outra equipe ou clique em um dia da lista.</td></tr>';
      return;
    }
    body.innerHTML = registros.map(item => {
      const motivo = item.motivo ? `<span class="ad-motivo">${esc(item.motivo)}</span>` : '';
      const parcela = item.parcela
        ? `<span class="ad-parcela">${esc(item.parcela)}</span>`
        : '<span class="ad-parcela vazia">sem parcela</span>';
      const datas = [item.dataEntrada, item.dataAdesao].filter(Boolean).map(esc).join(' → ');
      return `<tr class="ad-row" data-ad-detail="${esc(item.id)}" tabindex="0"
                  title="Abrir a conferência deste lote">
        <td class="ad-diadata">${esc(item.dia)}</td>
        <td class="ad-statuscell">${badge(item.status)}</td>
        <td><strong>${esc(item.lote)}</strong></td>
        <td class="ad-empresa">
          <strong>${esc(item.empregadora || item.empresa)}</strong>
          <small>${item.codigo ? `código ${esc(item.codigo)}` : 'sem código'} · ${esc(item.situacao || '—')}${item.empresaVenda && item.empresaVenda !== item.empregadora ? ` · venda: ${esc(item.empresaVenda)}` : ''}</small>
          ${motivo}
        </td>
        <td class="num">${item.vidas ? inteiro.format(item.vidas) : '—'}</td>
        <td class="num">${item.valor ? money.format(item.valor) : '—'}</td>
        <td class="ad-datas">${datas || '—'}</td>
        <td>${parcela}</td>
        <td>${tipoBadge(item.tipo)}</td>
        <td class="ad-equipe" title="${esc(item.equipe || '')}">${esc(item.equipe || '—')}</td>
        <td class="ad-open" aria-hidden="true">›</td>
      </tr>`;
    }).join('');
  }

  function renderPaginacao(data) {
    const hosts = [byId('adPaginationTop'), byId('adPaginationContainer')].filter(Boolean);
    const info = byId('adTableInfo');
    const total = data.resumo ? data.resumo.total : (data.registros || []).length;
    const pages = data.pages || 1;
    const atual = data.page || 1;
    if (info) {
      info.textContent = total
        ? `${inteiro.format(total)} ${total === 1 ? 'adesão' : 'adesões'} · página ${atual} de ${pages}`
        : '';
    }
    if (pages <= 1) {
      hosts.forEach(host => { host.innerHTML = ''; });
      return;
    }
    const botoes = [];
    botoes.push(`<button type="button" data-ad-page="1" ${atual === 1 ? 'disabled' : ''}>« Primeira</button>`);
    botoes.push(`<button type="button" data-ad-page="${atual - 1}" ${atual === 1 ? 'disabled' : ''}>‹ Anterior</button>`);
    for (let page = Math.max(1, atual - 2); page <= Math.min(pages, atual + 2); page += 1) {
      botoes.push(`<button type="button" data-ad-page="${page}" ${page === atual ? 'aria-current="page"' : ''}>${page}</button>`);
    }
    botoes.push(`<button type="button" data-ad-page="${atual + 1}" ${atual === pages ? 'disabled' : ''}>Próxima ›</button>`);
    botoes.push(`<button type="button" data-ad-page="${pages}" ${atual === pages ? 'disabled' : ''}>Última »</button>`);
    hosts.forEach(host => { host.innerHTML = botoes.join(''); });
  }

  async function carregar() {
    const body = byId('adTableBody');
    if (body) body.innerHTML = '<tr><td colspan="11" class="ad-loading">Lendo as adesões e a conferência…</td></tr>';
    try {
      const data = await api(`/api/adesoes?${filtros().toString()}`);
      state.data = data;
      renderAviso(data.cobertura);
      renderFontes(data.fontes);
      renderKpis(data.resumo);
      renderEquipes(data.resumo?.equipes);
      renderDias(data.dias || data.resumo?.dias);
      renderDiaBar();
      renderTabela(data.registros);
      renderPaginacao(data);
    } catch (error) {
      if (error.message === 'auth') return;
      if (body) {
        body.innerHTML = `<tr><td colspan="11" class="ad-empty">Não foi possível carregar: ${esc(error.message)}<br><small>Tente novamente em alguns segundos.</small></td></tr>`;
      }
    }
  }

  function mostrarConferindo(botoes, textos) {
    botoes.forEach((botao, index) => {
      botao.disabled = true;
      botao.textContent = index === 0 ? 'Conferindo…' : 'Aguarde…';
    });
  }

  function resumoConferencia(resumo) {
    if (!resumo) return 'Conferência concluída.';
    const linhas = [
      `Adesões conferidas: ${inteiro.format(resumo.total || 0)}`,
      `✅ Conferidas: ${inteiro.format(resumo.conferido || 0)}`,
      `⚠️ Divergentes: ${inteiro.format(resumo.divergente || 0)}`,
      `⏳ Pendentes: ${inteiro.format(resumo.pendente || 0)}`,
    ];
    if (resumo.avisoS4e) linhas.push('', resumo.avisoS4e);
    return linhas.join('\n');
  }

  function resumoGeracao(resumo) {
    if (!resumo) return 'Adesões atualizadas a partir do S4E.';
    const linhas = [
      `Adesões novas: ${inteiro.format(resumo.geradas || 0)}`,
      `Adesões atualizadas: ${inteiro.format(resumo.atualizadas || 0)}`,
    ];
    if (resumo.lotesCorrigidos) linhas.push(`Lotes corrigidos: ${inteiro.format(resumo.lotesCorrigidos)}`);
    if (resumo.semCodigo) linhas.push(`Sem código da empresa: ${inteiro.format(resumo.semCodigo)}`);
    if (resumo.semParcela) linhas.push(`Sem parcela no faturamento: ${inteiro.format(resumo.semParcela)}`);
    if (resumo.faltando?.length) {
      linhas.push('', `Falta consultar no S4E: ${resumo.faltando.map(item => item.mes).join(', ')}`);
    }
    linhas.push('', 'Conferindo agora…');
    return linhas.join('\n');
  }

  function gerar() {
    if (state.gerando) return;
    const botao = byId('adGerarBtn');
    const texto = botao ? botao.textContent : '';
    state.gerando = true;
    if (botao) { botao.disabled = true; botao.textContent = 'Montando as adesões…'; }
    api('/api/adesoes/gerar', { method: 'POST', body: JSON.stringify({}) })
      .then(async resposta => {
        const resumo = resposta.resumo || {};
        const mensagem = resumoGeracao(resumo);
        window.notify?.(mensagem, 'success');
        if (!window.notify) alert(mensagem);
        state.page = 1;
        state.dia = '';
        await carregar();
        await conferir();
      })
      .catch(error => {
        if (error.message === 'auth') return;
        const mensagem = `Não foi possível gerar do S4E: ${error.message}`;
        window.notify?.(mensagem, 'warning');
        if (!window.notify) alert(mensagem);
      })
      .finally(() => {
        state.gerando = false;
        if (botao) { botao.disabled = false; botao.textContent = texto; }
      });
  }

  function conferir(extra = {}) {
    if (state.conferindo) return;
    const botoes = [byId('adConferirTodosBtn'), byId('adConferirDiaBtn')].filter(Boolean);
    const textos = botoes.map(botao => botao.textContent);
    {
      const payload = {};
      const inicio = byId('adInicio')?.value || '';
      const fim = byId('adFim')?.value || '';
      const tipo = byId('adTipo')?.value || '';
      const status = byId('adStatus')?.value || '';
      const busca = (byId('adSearch')?.value || '').trim();
      if (state.dia) payload.dia = state.dia;
      if (inicio) payload.inicio = inicio;
      if (fim) payload.fim = fim;
      if (tipo) payload.tipo = tipo;
      if (state.equipes.length) payload.equipe = state.equipes;
      if (status) payload.status = status;
      if (busca) payload.busca = busca;
      Object.assign(payload, extra);
      // A conferência usa as cópias do S4E já guardadas no servidor: responde na
      // hora. Assim que volta, a lista e os números se atualizam sozinhos.
      state.conferindo = true;
      mostrarConferindo(botoes, textos);
      api('/api/adesoes/conferir', { method: 'POST', body: JSON.stringify(payload) })
        .then(async resumo => {
          const texto = resumoConferencia(resumo);
          window.notify?.(texto, resumo.divergente ? 'warning' : 'success');
          if (!window.notify) alert(texto);
          state.page = 1;
          await carregar();
        })
        .catch(error => {
          if (error.message === 'auth') return;
          const texto = `Não foi possível conferir: ${error.message}`;
          window.notify?.(texto, 'warning');
          if (!window.notify) alert(texto);
        })
        .finally(() => {
          state.conferindo = false;
          botoes.forEach((botao, index) => { botao.disabled = false; botao.textContent = textos[index]; });
        });
    }
  }

  function abrirDetalhe(id) {
    const item = (state.data?.registros || []).find(row => row.id === id);
    if (!item) return;
    const resultado = item.resultado || {};
    const checks = resultado.checks || [];
    const linhas = checks.length
      ? checks.map(check => {
        const classe = check.ok === true ? 'ok' : (check.ok === false ? 'bad' : 'pend');
        const marca = check.ok === true ? '✔' : (check.ok === false ? '✖' : '•');
        return `<div class="ad-check ${classe}"><span>${esc(check.fonte)}</span><b>${marca} ${esc(check.detalhe)}</b></div>`;
      }).join('')
      : '<p class="ad-empty">Esta adesão ainda não foi conferida. Use <strong>Conferir este dia</strong> ou <strong>Conferir tudo agora</strong>.</p>';

    const vidasFonte = (resultado.fontes || {}).vidas || {};
    const pessoas = vidasFonte.pessoas || [];
    let semPessoas = '';
    if (vidasFonte.situacao === 'ausente') {
      semPessoas = `A Movimentação de Vidas não encontrou ${vidasFonte.empresa || 'a empresa'} em ${vidasFonte.dia || '—'}.`;
    } else if (vidasFonte.situacao === 'fora_do_periodo') {
      semPessoas = `O relatório de vidas cobre ${vidasFonte.periodo}.`;
    } else {
      semPessoas = 'Confira este lote de novo para a lista de vidas aparecer.';
    }
    const pessoasHtml = pessoas.length
      ? `<div class="ad-results ad-lives">
          <h3>Quem são as vidas (${inteiro.format(pessoas.length)})</h3>
          <ul>${pessoas.map(pessoa => {
            const situacao = String(pessoa.situacao || '');
            const ativa = situacao.toUpperCase().startsWith('ATIV');
            return `<li><span>${esc(pessoa.nome || '—')}</span><em class="${ativa ? 'ok' : 'off'}">${esc(situacao || '—')}</em></li>`;
          }).join('')}</ul>
        </div>`
      : (checks.length
        ? `<div class="ad-results ad-lives">
            <h3>Quem são as vidas</h3>
            <p class="ad-empty">${esc(semPessoas)}</p>
          </div>`
        : '');

    const pagamentoFonte = item.pagamento || {};
    let pagamentoTexto = '—';
    let pagamentoClasse = '';
    if (pagamentoFonte.situacao === 'pago') {
      pagamentoTexto = `Pago em ${pagamentoFonte.pagoEm}${pagamentoFonte.recebidoTexto ? ` · ${pagamentoFonte.recebidoTexto}` : ''}`;
      pagamentoClasse = 'pago';
    } else if (pagamentoFonte.situacao === 'cancelado') {
      pagamentoTexto = 'Parcela cancelada no faturamento';
      pagamentoClasse = 'cancelado';
    } else if (pagamentoFonte.situacao === 'em_aberto') {
      pagamentoTexto = `Em aberto${pagamentoFonte.vencimento ? ` · vence ${pagamentoFonte.vencimento}` : ''}`;
      pagamentoClasse = 'em-aberto';
    }

    byId('adDetailBody').innerHTML = `
      <div class="ad-modal-title">
        <div>
          <p class="ad-eyebrow">LOTE ${esc(item.lote)}</p>
          <h2>${esc(item.empregadora || item.empresa)}</h2>
          <p class="ad-modal-sub">${esc(item.dia)} · ${item.codigo ? `código ${esc(item.codigo)}` : 'sem código'} · ${esc(item.tipo || '—')}${item.empresaVenda && item.empresaVenda !== item.empregadora ? ` · venda em nome de ${esc(item.empresaVenda)}` : ''}</p>
        </div>
        ${badge(item.status)}
      </div>
      <div class="ad-info-grid">
        <div class="ad-info-item"><span>Vidas</span><strong>${inteiro.format(item.vidas || 0)}</strong></div>
        <div class="ad-info-item"><span>Valor</span><strong>${item.valor ? money.format(item.valor) : '—'}</strong></div>
        <div class="ad-info-item"><span>Data de entrada</span><strong>${esc(item.dataEntrada || '—')}</strong></div>
        <div class="ad-info-item"><span>Data de adesão</span><strong>${esc(item.dataAdesao || '—')}</strong></div>
        <div class="ad-info-item"><span>Parcela</span><strong>${esc(item.parcela || '—')}</strong></div>
        <div class="ad-info-item"><span>Pagamento</span><strong class="${pagamentoClasse}">${esc(pagamentoTexto)}</strong></div>
        <div class="ad-info-item"><span>Situação</span><strong>${esc(item.situacao || '—')}</strong></div>
        <div class="ad-info-item"><span>Origem</span><strong>${esc(item.origem === 's4e' ? 'Entrada de Contratos' : 'Planilha')}</strong></div>
        <div class="ad-info-item"><span>Conferido em</span><strong>${esc(item.conferidoEm ? item.conferidoEm.slice(0, 16).replace('T', ' ') : '—')}</strong></div>
      </div>
      <div class="ad-results">
        <h3>O que a conferência encontrou</h3>
        ${linhas}
      </div>
      ${pessoasHtml}
      <div class="ad-modal-actions">
        <button type="button" class="button button-secondary" id="adDetailClose">Fechar</button>
        <button type="button" class="button button-primary" id="adDetailConferir">Conferir este lote</button>
      </div>
    `;
    byId('adDetailClose').addEventListener('click', () => byId('adDetailModal')?.close?.());
    byId('adDetailConferir').addEventListener('click', async () => {
      byId('adDetailModal')?.close?.();
      await conferir({ id: item.id });
    });
    const modal = byId('adDetailModal');
    if (modal?.showModal) modal.showModal();
  }

  async function exportar() {
    try {
      const response = await fetch(`${window.API_BASE || ''}/api/adesoes/exportar?${filtros().toString()}`, {
        headers: window.PortalAccess?.authHeaders ? window.PortalAccess.authHeaders() : {},
      });
      if (!response.ok) throw new Error('O portal não conseguiu gerar a planilha.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `conferencia-adesoes-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      URL.revokeObjectURL(url);
      link.remove();
    } catch (error) {
      const texto = `Não foi possível baixar a planilha: ${error.message}`;
      window.notify?.(texto, 'warning');
      if (!window.notify) alert(texto);
    }
  }

  function selecionarDia(dia) {
    state.dia = state.dia === dia ? '' : dia;
    state.page = 1;
    carregar();
  }

  function ajustarPeriodo(origem) {
    const inicio = byId('adInicio');
    const fim = byId('adFim');
    if (inicio && fim && inicio.value && fim.value && inicio.value > fim.value) {
      if (origem === 'inicio') fim.value = inicio.value;
      else inicio.value = fim.value;
    }
    state.dia = '';
    state.page = 1;
    carregar();
  }

  function ligarEventos() {
    byId('adInicio')?.addEventListener('change', () => ajustarPeriodo('inicio'));
    byId('adFim')?.addEventListener('change', () => ajustarPeriodo('fim'));
    byId('adTipo')?.addEventListener('change', () => { state.page = 1; carregar(); });
    byId('adTeamChips')?.addEventListener('click', event => {
      const chip = event.target.closest('[data-ad-team]');
      if (!chip) return;
      const equipe = chip.dataset.adTeam || '';
      if (!equipe) state.equipes = [];
      else if (state.equipes.includes(equipe)) state.equipes = state.equipes.filter(item => item !== equipe);
      else state.equipes = [...state.equipes, equipe];
      renderEquipes(state.data?.resumo?.equipes || []);
      state.page = 1;
      carregar();
    });
    byId('adStatus')?.addEventListener('change', () => { state.page = 1; carregar(); });
    byId('adSearch')?.addEventListener('input', () => {
      clearTimeout(window.__adBusca);
      window.__adBusca = setTimeout(() => { state.page = 1; carregar(); }, 350);
    });
    byId('adSearchClear')?.addEventListener('click', () => {
      const input = byId('adSearch');
      if (input) input.value = '';
      state.page = 1;
      carregar();
    });
    byId('adGerarBtn')?.addEventListener('click', gerar);
    byId('adConferirTodosBtn')?.addEventListener('click', () => conferir());
    byId('adConferirDiaBtn')?.addEventListener('click', () => conferir());
    byId('adLimparDiaBtn')?.addEventListener('click', () => { state.dia = ''; state.page = 1; carregar(); });
    byId('adExportarBtn')?.addEventListener('click', exportar);
    byId('adDays')?.addEventListener('click', event => {
      const botao = event.target.closest('[data-ad-day]');
      if (botao) selecionarDia(botao.dataset.adDay);
    });
    byId('adTableBody')?.addEventListener('click', event => {
      const linha = event.target.closest('[data-ad-detail]');
      if (linha) abrirDetalhe(linha.dataset.adDetail);
    });
    byId('adTableBody')?.addEventListener('keydown', event => {
      const linha = event.target.closest('[data-ad-detail]');
      if (linha && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        abrirDetalhe(linha.dataset.adDetail);
      }
    });
    byId('adPaginationContainer')?.addEventListener('click', event => {
      const botao = event.target.closest('[data-ad-page]');
      if (!botao || botao.disabled) return;
      state.page = parseInt(botao.dataset.adPage, 10) || 1;
      carregar();
    });
    byId('adPaginationTop')?.addEventListener('click', event => {
      const botao = event.target.closest('[data-ad-page]');
      if (!botao || botao.disabled) return;
      state.page = parseInt(botao.dataset.adPage, 10) || 1;
      carregar();
      document.querySelector('.ad-tablewrap')?.scrollIntoView({ block: 'nearest' });
    });
  }

  function enter() {
    state.ativo = true;
    preencherFiltros();
    carregar();
  }

  function leave() {
    state.ativo = false;
  }

  window.enterAdesiScreen = enter;
  window.leaveAdesiScreen = leave;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ligarEventos, { once: true });
  } else {
    ligarEventos();
  }
})();
