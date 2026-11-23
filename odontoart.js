/* Odontoart — controle mensal do plano PJ Top Individual com Odontologia.
   Lê /api/odontoart e /api/odontoart/exportar. Escopo: #odontoartScreen. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { dados: null, carregando: false };

  const esc = (valor) => String(valor ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cash = (valor) => (Number(valor) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  function headers() {
    const auth = window.PortalAccess;
    if (auth && typeof auth.authHeaders === 'function') return auth.authHeaders({});
    const token = localStorage.getItem('portalToken') || sessionStorage.getItem('portalToken') || '';
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function api(url) {
    const resposta = await fetch(`${window.PORTAL_API_BASE || ''}${url}`, { headers: headers() });
    if (!resposta.ok) throw new Error(resposta.status === 401 ? 'Sessão expirada. Entre novamente.' : 'Não foi possível montar o controle.');
    return resposta.json();
  }

  function classeFaixa(faixa) {
    if (!faixa) return '';
    if (faixa.indexOf('1º') === 0) return 'f1';
    if (faixa.indexOf('2º') === 0) return 'f2';
    if (faixa.indexOf('3º') === 0) return 'f3';
    return '';
  }

  function linhas(lista, comMotivo) {
    if (!lista || !lista.length) {
      return `<tr><td colspan="${comMotivo ? 7 : 6}" class="od-empty">Nenhuma vida nesta situação.</td></tr>`;
    }
    return lista.map((i) => `<tr>
      <td class="od-nome">${esc(i.nome)}</td>
      <td class="od-mono">${esc(i.cpf || '—')}</td>
      <td class="od-empresa">${esc(i.empresa)}</td>
      <td>${esc(i.parentesco || '—')}</td>
      <td><span class="od-faixa ${classeFaixa(i.faixa)}">${esc(i.faixa || '—')}</span></td>
      <td class="od-num">${cash(i.valor)}</td>
      ${comMotivo ? `<td>${i.motivo ? `<span class="od-motivo">${esc(i.motivo)}</span>` : '—'}</td>` : ''}
    </tr>`).join('');
  }

  function tabelaEmpresas(lista) {
    if (!lista || !lista.length) return '<tr><td colspan="6" class="od-empty">Nenhuma empresa no plano.</td></tr>';
    return lista.map((e) => {
      const semTitulo = !e.faturado;
      return `<tr class="${semTitulo ? 'od-sem-titulo' : ''}">
        <td class="od-empresa">${esc(e.empresa)}</td>
        <td class="od-num">${e.vidas}</td>
        <td class="od-num">${e.ativas ? `<b class="od-ok">${e.ativas}</b>` : '0'}</td>
        <td class="od-num">${e.atraso ? `<b class="od-warn">${e.atraso}</b>` : '0'}</td>
        <td class="od-num">${semTitulo ? '<span class="od-tag">não faturou</span>' : cash(e.faturado)}</td>
        <td class="od-num">${semTitulo ? '—' : cash(e.recebido)}</td>
      </tr>`;
    }).join('');
  }

  function tabelaConferencia(lista) {
    if (!lista || !lista.length) {
      return '<tr><td colspan="6" class="od-empty">Nenhum título do plano nesta competência — nada foi faturado.</td></tr>';
    }
    return lista.map((c) => `<tr>
      <td class="od-empresa">${esc(c.empresa)}</td>
      <td class="od-num">${c.vidas}</td>
      <td class="od-num">${cash(c.valor)}</td>
      <td class="od-num">${cash(c.recebido)}</td>
      <td><span class="od-selo ${c.pago ? 'is-pago' : 'is-aberto'}">${c.pago ? 'PAGO' : 'EM ABERTO'}</span></td>
      <td class="od-mono">${esc(c.vencimento || '—')}</td>
    </tr>`).join('');
  }

  function render() {
    const d = state.dados;
    if (!d) return;

    const comp = $('odComp');
    if (comp) {
      const lista = d.competencias || [];
      let opcoes = lista.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
      if (d.competencia && !lista.includes(d.competencia)) opcoes = `<option value="${esc(d.competencia)}">${esc(d.competencia)}</option>` + opcoes;
      comp.innerHTML = opcoes || '<option value="">—</option>';
      comp.value = d.competencia || '';
    }

    const ativos = d.resumoAtivos || { total: 0, valor: 0 };
    const atraso = d.resumoAtraso || { total: 0, valor: 0 };
    const cancelados = d.resumoCancelados || { total: 0, valor: 0 };

    $('odKpis').innerHTML = [
      ['Vidas ativas', ativos.total, cash(ativos.valor), 'is-ok'],
      ['Em atraso', atraso.total, cash(atraso.valor), 'is-warn'],
      ['Canceladas', cancelados.total, cash(cancelados.valor), ''],
      ['Empresas', d.empresas || 0, `${d.vidas || 0} vidas no plano`, ''],
    ].map(([rotulo, numero, detalhe, classe]) => `<article class="od-kpi ${classe}"><span>${rotulo}</span><strong>${numero}</strong><small>${detalhe}</small></article>`).join('');

    $('odNote').textContent = d.temTitulos
      ? `Competência ${d.competencia} · plano ${d.plano} · o atraso vem do título da empresa na competência: não faturado, ou faturado e em aberto no S4E.`
      : `Ainda não há apuração concluída de ${d.competencia || '—'}: o atraso não pôde ser calculado.`;

    $('odAtivosCount').textContent = `${ativos.total} vidas`;
    $('odAtrasoCount').textContent = `${atraso.total} vidas`;
    $('odCancelCount').textContent = `${cancelados.total} vidas`;

    $('odAtivos').innerHTML = linhas(d.ativos);
    $('odAtraso').innerHTML = linhas(d.atraso, true);
    $('odCancelados').innerHTML = linhas(d.cancelados);

    $('odEmpresas').innerHTML = tabelaEmpresas(d.porEmpresa);
    $('odConferencia').innerHTML = tabelaConferencia(d.conferencia);
    const conf = d.conferencia || [];
    $('odConfCount').textContent = conf.length
      ? `${conf.filter((c) => c.pago).length} de ${conf.length} pagos`
      : 'nenhum título';

    const faixas = ['1º PAGAMENTO', '2º PAGAMENTO', '3º OU MAIS PAGAMENTOS', 'SEM DATA DE ADESÃO'];
    let somaA = 0;
    let somaT = 0;
    let somaC = 0;
    const linhasResumo = faixas.map((f) => {
      const a = (ativos.faixas || {})[f] || 0;
      const t = (atraso.faixas || {})[f] || 0;
      const c = (cancelados.faixas || {})[f] || 0;
      somaA += a;
      somaT += t;
      somaC += c;
      return `<tr><td>${esc(f)}</td><td class="od-num">${a}</td><td class="od-num">${t}</td><td class="od-num">${c}</td><td class="od-num">${a + t + c}</td></tr>`;
    }).join('');
    $('odResumo').innerHTML = linhasResumo +
      `<tr class="od-total"><td>Total</td><td class="od-num">${somaA}</td><td class="od-num">${somaT}</td><td class="od-num">${somaC}</td><td class="od-num">${somaA + somaT + somaC}</td></tr>`;

    // O quadro RESUMO da planilha: quantidade por faixa e os dois valores fixos.
    const fin = d.resumoFinanceiro || { linhas: [], total: {} };
    const valores = d.valores || { odontoart: 8.98, redeSaude: 0.18 };
    $('odFinanceiro').innerHTML = (fin.linhas || []).map((l) => `<tr>
      <td>${esc(l.faixa)}</td>
      <td class="od-num">${l.quantidade}</td>
      <td class="od-num">${cash(l.odontoart)}</td>
      <td class="od-num">${cash(l.redeSaude)}</td>
    </tr>`).join('') + `<tr class="od-total">
      <td>Total</td>
      <td class="od-num">${fin.total?.quantidade ?? 0}</td>
      <td class="od-num">${cash(fin.total?.odontoart ?? 0)}</td>
      <td class="od-num">${cash(fin.total?.redeSaude ?? 0)}</td>
    </tr>`;
    $('odFinanceiroNota').textContent = `Conta da planilha: cada vida ativa vale ${cash(valores.odontoart)} para a Odontoart emitir a nota e o boleto, e ${cash(valores.redeSaude)} para a Rede Saúde. O total do mês é a soma das faixas.`;
  }

  async function carregar(competencia) {
    if (state.carregando) return;
    state.carregando = true;
    try {
      const alvo = competencia || '';
      state.dados = await api(`/api/odontoart${alvo ? `?competencia=${encodeURIComponent(alvo)}` : ''}`);
      render();
    } catch (erro) {
      const nota = $('odNote');
      if (nota) nota.textContent = erro.message || 'Não foi possível montar o controle.';
    } finally {
      state.carregando = false;
    }
  }

  async function exportar() {
    const competencia = $('odComp')?.value || '';
    const botao = $('odExport');
    if (botao) botao.disabled = true;
    try {
      const resposta = await fetch(`${window.PORTAL_API_BASE || ''}/api/odontoart/exportar?competencia=${encodeURIComponent(competencia)}`, { headers: headers() });
      if (!resposta.ok) throw new Error('Não foi possível gerar o Excel.');
      const url = URL.createObjectURL(await resposta.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `ODONTOART ${competencia.replace('/', '.')}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (erro) {
      const nota = $('odNote');
      if (nota) nota.textContent = erro.message || 'Não foi possível gerar o Excel.';
    } finally {
      if (botao) botao.disabled = false;
    }
  }

  function ligar() {
    const tela = $('odontoartScreen');
    if (!tela || tela.dataset.odontoartReady === '1') return;
    tela.dataset.odontoartReady = '1';
    $('odComp')?.addEventListener('change', () => carregar($('odComp').value));
    $('odExport')?.addEventListener('click', exportar);
  }

  // A tela é aberta pelo menu: busca os dados na primeira vez que fica visível.
  function aoTrocarTela() {
    const tela = $('odontoartScreen');
    if (!tela || tela.classList.contains('hidden')) return;
    ligar();
    if (!state.dados) carregar();
  }

  document.addEventListener('DOMContentLoaded', () => {
    ligar();
    document.querySelectorAll('[data-screen="odontoartScreen"]').forEach((botao) => {
      botao.addEventListener('click', () => setTimeout(aoTrocarTela, 30));
    });
    const observador = new MutationObserver(aoTrocarTela);
    const tela = $('odontoartScreen');
    if (tela) observador.observe(tela, { attributes: true, attributeFilter: ['class'] });
  });

  window.Odontoart = { carregar, render, exportar };
})();
