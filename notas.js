(function () {
  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const api = (path, options) => window.PortalAccess.api(path, options);
  const number = new Intl.NumberFormat('pt-BR');
  const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const state = { active: false, timer: null, sequence: 0, data: null, starting: false, loading: false, exporting: false, downloadUrl: '' };
  const stamp = value => value ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza', dateStyle: 'short', timeStyle: 'short' }) : '—';
  const brDate = value => /^\d{4}-\d{2}-\d{2}/.test(String(value || '')) ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : (value || '—');
  const visible = () => state.active && window.PortalAccess?.Access.user && !document.body.classList.contains('locked');
  const searchText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]/g, '');
  const papelLabel = { correta: 'Correta (provável)', duplicada: 'Duplicada (provável)', revisar: 'Revisar' };

  function message(text = '', error = false, download = null) {
    const box = byId('ntMessage');
    if (state.downloadUrl) {
      URL.revokeObjectURL(state.downloadUrl);
      state.downloadUrl = '';
    }
    box.replaceChildren();
    if (text) box.appendChild(document.createTextNode(text));
    if (download?.blob) {
      state.downloadUrl = URL.createObjectURL(download.blob);
      const link = document.createElement('a');
      link.className = 'nt-link';
      link.href = state.downloadUrl;
      link.download = download.filename;
      link.textContent = 'Baixar arquivo';
      box.appendChild(document.createTextNode(' '));
      box.appendChild(link);
    }
    box.hidden = !text;
    box.classList.toggle('nt-error', error);
  }

  function controls() {
    const busy = state.starting || state.data?.job?.running;
    byId('ntRun').disabled = Boolean(busy || state.loading);
    byId('ntRun').textContent = busy ? 'Conferindo…' : 'Conferir agora';
    byId('ntExport').disabled = state.exporting || !state.data?.run || state.data.run.status !== 'done';
    byId('ntStart').disabled = Boolean(busy);
    byId('ntEnd').disabled = Boolean(busy);
  }

  function invoice(item) {
    const text = esc(item.nf || 'Sem NF');
    if (!item.nfUrl) return `<span title="Nota ainda não emitida ou link não confirmado nesta conferência.">${text}</span>`;
    let url;
    try {
      url = new URL(item.nfUrl);
    } catch {
      return text;
    }
    if (url.protocol !== 'https:' || url.host !== 'www.nfse.gov.br' || url.pathname !== '/ConsultaPublica/' || url.username || url.password) return text;
    return `<a class="nt-link" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer" title="Abrir esta nota fiscal na consulta oficial">${text}</a>`;
  }

  function taxTotals(detail) {
    if (!detail) return null;
    const keys = [['cofins', 'COFINS', 'cofinsRet'], ['csll', 'CSLL', 'csllRet'], ['inss', 'INSS', 'inssRet'], ['ir', 'IR', 'irRet'], ['iss', 'ISS', 'issRet'], ['pis', 'PIS', 'pisRet']];
    let total = 0;
    let retention = 0;
    for (const [key, , ret] of keys) {
      total += Number(detail[key] || 0);
      retention += Number(detail[ret] || 0);
    }
    return { total, retention, keys };
  }

  function taxText(item) {
    const detail = item.tributos;
    const totals = taxTotals(detail);
    if (!detail || !totals) return '';
    const parts = totals.keys.map(([key, label, ret]) => {
      const retention = Number(detail[ret] || 0);
      return `${label} <b>${money.format(Number(detail[key] || 0))}</b>${retention ? ` (ret. ${money.format(retention)})` : ''}`;
    });
    parts.push(`Retenções <b>${money.format(totals.retention)}</b>`);
    parts.push(`Tributos do lote <b>${money.format(totals.total)}</b>`);
    if (Number(detail.fatura || 0)) parts.push(`Fatura <b>${money.format(detail.fatura)}</b>`);
    if (Number(detail.refImp || 0)) parts.push(`Referência imposto <b>${money.format(detail.refImp)}</b>`);
    if (Number(detail.plano || 0)) parts.push(`Plano <b>${money.format(detail.plano)}</b>`);
    if (Number(detail.orto || 0)) parts.push(`Orto <b>${money.format(detail.orto)}</b>`);
    return parts.join(' · ');
  }

  function table(group) {
    const rows = group.itens.map(item => {
      const extras = Number(item.acrescimo || 0) + Number(item.acrescimoAvulso || 0);
      const discounts = Number(item.desconto || 0) + Number(item.descontoPagamento || 0);
      const totals = taxTotals(item.tributos);
      const main = `<tr data-papel="${esc(item.papel)}">
        <td><span class="nt-papel" data-kind="${esc(item.papel)}">${esc(papelLabel[item.papel] || 'Revisar')}</span></td>
        <td>${esc(item.parcela || '—')}</td>
        <td class="nf">${invoice(item)}</td>
        <td>${esc(item.lote || '—')}</td>
        <td>${esc(item.emissao || '—')}</td>
        <td>${esc(item.vencimento || '—')}</td>
        <td class="num">${money.format(Number(item.valor || 0))}</td>
        <td class="num">${money.format(Number(item.imposto || 0))}</td>
        <td class="num">${money.format(Number(item.taxa || 0))}</td>
        <td class="num">${money.format(Number(item.tarifa || 0))}</td>
        <td class="num">${money.format(Number(item.multa || 0))}</td>
        <td class="num">${money.format(extras)}</td>
        <td class="num">${money.format(discounts)}</td>
        <td class="num">${money.format(Number(item.valorPago || 0))}</td>
        <td>${esc(item.dataPagamento || '—')}</td>
        <td>${esc(item.situacao || '—')}</td>
        <td class="num">${totals ? money.format(totals.total) : '—'}</td>
      </tr>`;
      return totals ? `${main}<tr class="nt-taxes"><td colspan="17">${taxText(item)}</td></tr>` : main;
    }).join('');
    return `<div class="nt-table-wrap"><table class="nt-table">
      <thead><tr><th>Papel</th><th>Parcela</th><th>NF</th><th>Lote</th><th>Emissão</th><th>Vencimento</th><th>Valor</th><th>Imposto</th><th>Taxa</th><th>Tarifa</th><th>Multa</th><th>Acréscimos</th><th>Descontos</th><th>Valor pago</th><th>Pagamento</th><th>Situação</th><th>Tributos do lote</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function card(group, index) {
    const titles = group.itens.length;
    return `<details class="nt-group" data-class="${esc(group.classificacao)}" ${index === 0 ? 'open' : ''}>
      <summary>
        <span class="nt-badge" data-kind="${esc(group.classificacao)}">${esc(group.rotulo)}</span>
        <span class="nt-group-title"><strong>${esc(group.empresa || 'Empresa não informada')}</strong><small>${esc(group.documento || '—')} · ${esc(group.competencia || '—')} · ${esc(group.tipoParcela || '—')} · ${titles} título(s)</small></span>
        <span class="nt-group-values"><span>Valor do grupo<strong>${money.format(Number(group.valor || 0))}</strong></span><span class="nt-risk">Sob revisão<strong>${money.format(Number(group.valorRisco || 0))}</strong></span></span>
      </summary>
      <div class="nt-group-body">
        <ul class="nt-motivos">${(group.motivos || []).map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>
        <p class="nt-callout">${esc(group.justificativa || 'Confira os títulos antes de cancelar qualquer nota.')}</p>
        ${table(group)}
      </div>
    </details>`;
  }

  function renderGroups() {
    const data = state.data;
    const query = searchText(byId('ntSearch').value);
    const filter = byId('ntFilter').value;
    const groups = (data?.grupos || []).filter(group => {
      if (filter && group.classificacao !== filter) return false;
      if (!query) return true;
      const values = [group.id, group.empresa, group.documento, group.competencia, group.tipoParcela];
      for (const item of group.itens || []) values.push(item.nf, item.parcela, item.lote, item.situacao, item.emissao);
      return values.some(value => searchText(value).includes(query));
    });
    byId('ntCount').textContent = `${number.format(groups.length)} de ${number.format(data?.grupos?.length || 0)} grupo(s)`;
    const empty = byId('ntEmpty');
    empty.hidden = Boolean(groups.length);
    if (!groups.length) {
      if (!data?.run) empty.textContent = 'Nenhuma conferência ainda. Escolha o período e clique em “Conferir agora”. A conferência não altera nada no S4E.';
      else if (data.grupos?.length) empty.textContent = 'Nenhum grupo de duplicidade encontrado para esta pesquisa ou classificação.';
      else empty.textContent = 'Nenhuma duplicidade encontrada no período. Os títulos continuam disponíveis na planilha exportada.';
    }
    byId('ntGroups').innerHTML = groups.map(card).join('');
  }

  function renderJob() {
    const job = state.data?.job || {};
    byId('ntJob').hidden = !job.running;
    if (!job.running) return;
    const elapsed = Math.max(0, Math.floor((Date.now() - new Date(job.startedAt || Date.now()).getTime()) / 1000));
    const duration = value => `${Math.floor(value / 60)}min ${String(value % 60).padStart(2, '0')}s`;
    const descriptions = {
      inicio: 'Preparando a conferência.',
      s4e: 'O S4E está gerando o relatório de faturamento. Em períodos grandes ele pode levar alguns minutos e não informa o progresso.',
      grupos: 'Comparando títulos, parcelas e notas fiscais do período.',
      tributos: 'Lendo no S4E os tributos detalhados dos lotes que têm duplicidade.',
      salvar: 'Salvando a conferência e os totais.',
      erro: 'A conferência não foi concluída. Nenhum dado do S4E foi alterado.',
      fim: 'Conferência concluída.'
    };
    byId('ntJobText').textContent = job.message || 'Conferindo as notas no S4E…';
    byId('ntJobDetail').textContent = descriptions[job.phase] || 'Finalizando a conferência.';
    byId('ntJobTime').textContent = `Decorrido: ${duration(elapsed)}${job.total ? ` · ${number.format(job.done || 0)} de ${number.format(job.total)} lote(s)` : ''}`;
    byId('ntJobProgress').value = job.percent || 0;
    byId('ntJobProgress').setAttribute('aria-valuetext', `${job.percent || 0}% das etapas concluídas`);
  }

  function render() {
    const data = state.data || {};
    const run = data.run;
    const resumo = data.resumo || {};
    byId('ntTitles').textContent = run ? number.format(resumo.totalTitulos || 0) : '—';
    byId('ntNotes').textContent = run ? number.format(resumo.totalNotas || 0) : '—';
    byId('ntGroupsCount').textContent = run ? number.format(resumo.grupos || 0) : '—';
    byId('ntRisk').textContent = run ? money.format(Number(resumo.valorRisco || 0)) : '—';
    byId('ntTaxes').textContent = run ? money.format(Number(resumo.impostos || 0)) : '—';
    byId('ntCharges').textContent = run ? money.format(Number(resumo.multas || 0) + Number(resumo.acrescimos || 0)) : '—';
    byId('ntPeriod').textContent = run
      ? `Período ${brDate(run.inicio)} a ${brDate(run.fim)} · executada em ${stamp(run.finishedAt || run.startedAt)}${run.createdBy ? ` · ${run.createdBy}` : ''} · ${number.format(resumo.confirmadas || 0)} confirmada(s), ${number.format(resumo.provaveis || 0)} provável(is) e ${number.format(resumo.suspeitas || 0)} suspeita(s).`
      : 'Nenhuma conferência ainda. Escolha o período e clique em “Conferir agora”.';
    renderGroups();
    renderJob();
    controls();
  }

  function schedule() {
    clearTimeout(state.timer);
    if (visible()) state.timer = setTimeout(() => load(), state.data?.job?.running ? 2500 : 60000);
  }

  async function load() {
    if (!visible()) return;
    const sequence = ++state.sequence;
    state.loading = true;
    controls();
    try {
      if (state.data?.job?.running) {
        const job = await api('/api/notas/job');
        if (sequence !== state.sequence || !visible()) return;
        state.data.job = job;
        renderJob();
        if (job.running) return;
      }
      const selected = byId('ntHistory').value;
      const data = await api(`/api/notas${selected ? `?run=${encodeURIComponent(selected)}` : ''}`);
      if (sequence !== state.sequence || !visible()) return;
      state.data = data;
      render();
      const job = data.job || {};
      if (job.error && !job.running) message(`A última conferência falhou: ${job.error}. Os dados anteriores foram preservados.`, true);
      else message();
      await loadHistory();
    } catch (error) {
      if (sequence === state.sequence && visible()) message(error.message, true);
    } finally {
      if (sequence === state.sequence) {
        state.loading = false;
        controls();
        schedule();
      }
    }
  }

  async function loadHistory() {
    try {
      const data = await api('/api/notas/runs');
      const select = byId('ntHistory');
      const current = select.value;
      const runs = data.runs || [];
      select.innerHTML = '<option value="">Última conferência</option>' + runs.map(run => `<option value="${esc(run.id)}">${brDate(run.inicio)} a ${brDate(run.fim)} · ${number.format(run.grupos || 0)} grupo(s) · ${stamp(run.finishedAt || run.startedAt)}</option>`).join('');
      if ([...select.options].some(option => option.value === current)) select.value = current;
    } catch {
      /* histórico é opcional para a conferência atual */
    }
  }

  async function run() {
    if (state.starting || state.data?.job?.running) return;
    const start = byId('ntStart').value;
    const end = byId('ntEnd').value;
    if (!start || !end) return message('Informe a data inicial e a data final.', true);
    if (start > end) return message('A data inicial não pode ser maior que a data final.', true);
    state.starting = true;
    message();
    controls();
    try {
      const result = await api('/api/notas/conferir', { method: 'POST', body: JSON.stringify({ start, end }) });
      state.data = state.data || { run: null, grupos: [], resumo: {} };
      state.data.job = result.job;
      byId('ntHistory').value = '';
      await load();
    } catch (error) {
      message(error.message, true);
    } finally {
      state.starting = false;
      controls();
    }
  }

  async function exportXlsx() {
    const runId = state.data?.run?.id;
    if (!runId || state.exporting) return;
    state.exporting = true;
    controls();
    try {
      const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/notas/export?run=${encodeURIComponent(runId)}`, { headers: window.PortalAccess.authHeaders() });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Não foi possível exportar a conferência.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const match = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/);
      anchor.href = url;
      anchor.download = match ? match[1] : 'conferencia_notas.xlsx';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message('Planilha pronta. Se o download não aparecer, use o link:', false, {
        blob,
        filename: match ? match[1] : 'conferencia_notas.xlsx',
      });
    } catch (error) {
      message(error.message, true);
    } finally {
      state.exporting = false;
      controls();
    }
  }

  function enter() {
    state.active = true;
    loadHistory();
    load();
  }

  function leave() {
    state.active = false;
    state.sequence += 1;
    clearTimeout(state.timer);
  }

  const today = new Date();
  const iso = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  byId('ntStart').value = iso(new Date(today.getFullYear(), today.getMonth(), 1));
  byId('ntEnd').value = iso(today);
  byId('ntForm').addEventListener('submit', event => { event.preventDefault(); run(); });
  byId('ntExport').addEventListener('click', exportXlsx);
  byId('ntSearch').addEventListener('input', () => { if (state.data) renderGroups(); });
  byId('ntFilter').addEventListener('change', () => { if (state.data) renderGroups(); });
  byId('ntHistory').addEventListener('change', () => {
    state.data = null;
    message();
    load();
  });
  setInterval(() => {
    if (visible() && state.data?.job?.running) renderJob();
  }, 1000);
  window.enterNotasScreen = enter;
  window.leaveNotasScreen = leave;
})();
