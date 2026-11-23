(function () {
  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const api = (path, options) => window.PortalAccess.api(path, options);
  const number = new Intl.NumberFormat('pt-BR');
  const months = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const state = { active: false, timer: null, sequence: 0, data: null, starting: false, loading: false, exporting: false, mapa: [], details: [], selectedGroup: '', downloadUrl: '' };
  const stamp = value => value ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza', dateStyle: 'short', timeStyle: 'short' }) : '—';
  const label = () => byId('apMonth').value && byId('apYear').value ? `${byId('apMonth').value}/${byId('apYear').value}` : '';
  const visible = () => state.active && window.PortalAccess?.Access.user && !document.body.classList.contains('locked');
  const phaseNames = { relatorio: 'S4E', notas: 'notas fiscais', apuracao: 'apuração', planilha: 'planilha' };

  function secondsText(value) {
    const seconds = Math.max(0, Math.round(Number(value) || 0));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}min ${String(seconds % 60).padStart(2, '0')}s`;
  }

  function timingSummary(timings) {
    if (!timings || !timings.total) return '';
    const parts = Object.entries(phaseNames)
      .filter(([key]) => Number(timings[key]) > 0)
      .map(([key, name]) => `${name} ${secondsText(timings[key])}`);
    return ` · levou ${secondsText(timings.total)}${parts.length ? ` (${parts.join(' · ')})` : ''}`;
  }

  function message(text = '', error = false, download = null) {
    const box = byId('apMessage');
    if (state.downloadUrl) {
      URL.revokeObjectURL(state.downloadUrl);
      state.downloadUrl = '';
    }
    box.replaceChildren();
    if (text) box.appendChild(document.createTextNode(text));
    if (download?.blob) {
      state.downloadUrl = URL.createObjectURL(download.blob);
      const link = document.createElement('a');
      link.className = 'ap-link';
      link.href = state.downloadUrl;
      link.download = download.filename;
      link.textContent = 'Baixar arquivo';
      box.appendChild(document.createTextNode(' '));
      box.appendChild(link);
    }
    box.hidden = !text;
    box.classList.toggle('ap-error', error);
  }

  function controls() {
    const busy = state.starting || state.data?.job?.running;
    byId('apRun').disabled = Boolean(busy || state.loading);
    byId('apRun').textContent = busy ? 'Apurando…' : 'Apurar agora';
    byId('apDownload').disabled = state.exporting || !state.data?.run?.hasFile;
    byId('apReportDownload').disabled = state.exporting || !state.data?.run;
    byId('apMapOpen').hidden = !state.data?.canManage;
  }

  function invoice(item) {
    const text = esc(item.nf || 'Não informada');
    if (!item.nfUrl) return `<span title="O S4E não forneceu um link confirmado para esta nota nesta apuração.">${text}</span>`;
    let url;
    try {
      url = new URL(item.nfUrl);
    } catch {
      return text;
    }
    if (url.protocol !== 'https:' || url.host !== 'www.nfse.gov.br' || url.pathname !== '/ConsultaPublica/' || url.username || url.password) return text;
    return `<a class="ap-link" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer" title="Abrir esta nota fiscal na consulta oficial" aria-label="Abrir nota fiscal ${text}">${text}</a>`;
  }

  const searchText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]/g, '');
  const matchesSearch = item => !byId('apSearch').value.trim() || [item.empresa, item.documento, item.grupo].some(value => searchText(value).includes(searchText(byId('apSearch').value)));

  function renderDetails() {
    const rows = (state.details || []).filter(matchesSearch);
    byId('apCompanyCount').textContent = `${number.format(rows.length)} de ${number.format(state.details?.length || 0)} empresas`;
    byId('apCompanyFilter').textContent = state.selectedGroup ? `Grupo: ${state.selectedGroup}` : 'Competência e semana do vencimento';
    byId('apCompanyEmpty').hidden = Boolean(rows.length);
    byId('apCompanyRows').innerHTML = rows.map(item => `<tr>
      <td><strong>${esc(item.empresa)}</strong></td><td>${esc(item.documento || '—')}</td><td>${esc(item.grupo)}</td><td>${esc(item.vencimento || '—')}</td>
      <td>${invoice(item)}</td><td>${esc(item.competencia)}</td><td>${esc(item.semana)}ª</td><td>${esc(item.dataPagamento || '—')}</td>
      <td class="${item.pago ? 'ap-company-paid' : 'ap-company-pending'}">${item.pago ? 'Pago' : 'Sem pagamento'}</td>
    </tr>`).join('');
  }

  function renderGroupModal() {
    const rows = (state.details || []).filter(item => item.grupo === state.selectedGroup && matchesSearch(item));
    byId('apGroupTitle').textContent = state.selectedGroup || 'Empresas do grupo';
    byId('apGroupSubtitle').textContent = `${number.format(rows.length)} empresa(s) · ${label()}${byId('apWeek').value ? ` · ${byId('apWeek').selectedOptions[0].textContent}` : ''}`;
    byId('apGroupEmpty').hidden = Boolean(rows.length);
    byId('apGroupRows').innerHTML = rows.map(item => `<tr>
      <td><strong>${esc(item.empresa)}</strong></td><td>${esc(item.documento || '—')}</td><td>${esc(item.vencimento || '—')}</td>
      <td>${invoice(item)}</td><td>${esc(item.competencia)}</td><td>${esc(item.semana)}ª</td><td>${esc(item.dataPagamento || '—')}</td>
      <td class="${item.pago ? 'ap-company-paid' : 'ap-company-pending'}">${item.pago ? 'Pago' : 'Sem pagamento'}</td>
    </tr>`).join('');
  }

  function renderJob() {
    const job = state.data?.job || {};
    byId('apJob').hidden = !job.running;
    if (!job.running) return;
    const seconds = value => Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    const duration = value => `${Math.floor(value / 60)}min ${String(value % 60).padStart(2, '0')}s`;
    const elapsed = seconds(job.startedAt);
    const waiting = job.phase === 's4e' && job.percent < 65;
    const phaseElapsed = waiting ? seconds(job.phaseStartedAt || job.startedAt) : 0;
    const estimate = Math.max(0, 300 - phaseElapsed);
    const descriptions = {
      inicio: 'Conectando ao S4E com a conta configurada.',
      s4e: waiting ? 'Aguardando o S4E gerar e devolver o relatório. Ele não informa o progresso da consulta.' : 'Relatório recebido. Preparando os títulos para apuração.',
      notas: 'Conferindo lote, código do cliente e número da nota. Somente links oficiais com correspondência única serão vinculados.',
      apuracao: 'Organizando empresas por grupo e identificando pagamentos registrados.',
      planilha: 'Gerando e salvando a planilha. Os dados anteriores continuam disponíveis até a conclusão.'
    };
    byId('apJobText').textContent = job.message || 'Consultando o S4E…';
    byId('apJobPeriod').textContent = `${job.competencia || ''} · Decorrido: ${duration(elapsed)}`;
    byId('apJobDetail').textContent = descriptions[job.phase] || 'Finalizando a apuração.';
    byId('apJobTime').textContent = waiting
      ? (estimate > 0 ? `Restante estimado para receber o relatório: ${duration(estimate)} (referência: leituras recentes levaram de 1 a 2 minutos; não é uma garantia).` : 'A consulta ultrapassou a estimativa e continua aguardando o S4E. Limite de espera: 10 minutos por tentativa.')
      : 'Tempo restante indisponível nesta etapa.';
    byId('apJobProgress').value = job.percent || 0;
    byId('apJobProgress').setAttribute('aria-valuetext', `${job.percent || 0}% das etapas concluídas; ${descriptions[job.phase] || 'Finalizando.'}`);
  }

  setInterval(() => {
    if (visible() && state.data?.job?.running) renderJob();
  }, 1000);

  function render() {
    const data = state.data;
    const run = data.run;
    const job = data.job || {};
    const matchingGroups = new Set((state.details || []).filter(matchesSearch).map(item => item.grupo));
    const query = searchText(byId('apSearch').value);
    const groups = (data.grupos || []).filter(group => !query || searchText(group.mae).includes(query) || matchingGroups.has(group.mae));
    const total = run?.totalEmpresas || 0;
    const paid = run?.pagas || 0;
    const pct = total ? Math.round(100 * paid / total) : 0;
    byId('apPeriodTitle').textContent = data.competencia;
    byId('apTotal').textContent = run ? number.format(total) : '—';
    byId('apPaid').textContent = run ? number.format(paid) : '—';
    byId('apPending').textContent = run ? number.format(total - paid) : '—';
    byId('apPercent').textContent = run ? `${pct}%` : '—';
    byId('apInvoices').textContent = run ? number.format(run.totalNotas || 0) : '—';
    byId('apGroupCount').textContent = `${groups.length} de ${data.grupos?.length || 0} grupos`;
    byId('apUpdated').textContent = run ? `Última apuração: ${stamp(run.finishedAt)} · ${run.mode === 'auto' ? 'automática' : 'manual'}${timingSummary(run.timings)}` : 'Nenhuma apuração nesta competência.';
    byId('apEmpty').hidden = Boolean(groups.length);
    byId('apEmpty').textContent = run ? (query ? 'Nenhuma empresa ou grupo encontrado para esta pesquisa.' : 'Nenhuma empresa encontrada para esta competência.') : 'Selecione a competência e clique em “Apurar agora”. Os dados serão consultados no S4E, sem alterar nenhum cadastro.';
    byId('apGrid').innerHTML = groups.map(group => {
      const percent = group.total ? Math.round(100 * group.pagas / group.total) : 0;
      const widths = Math.max(0, Math.min(100, percent));
      return `<article class="ap-card${group.mae === 'SINTEG' ? ' ap-card-sinteg' : ''}" tabindex="0" role="button" data-ap-group="${esc(group.mae)}" aria-label="Ver empresas do grupo ${esc(group.mae)}">
        <div class="ap-card-top"><h3>${esc(group.mae)}</h3>${group.novos ? '<span class="ap-new">Novo grupo</span>' : ''}</div>
        <div class="ap-card-numbers"><strong>${number.format(group.pagas)}</strong><span>de <b>${number.format(group.total)}</b><small>empresas pagaram</small></span><em>${percent}%</em></div>
        <div class="ap-bar" role="meter" aria-label="Empresas pagas em ${esc(group.mae)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${widths}"><i style="width:${widths}%"></i></div>
        <div class="ap-card-foot"><span>${number.format(group.total - group.pagas)} sem pagamento</span><span>${number.format(group.total)} no total</span></div>
        ${group.vencimentos?.length ? `<div class="ap-due-dates"><strong>Vencimentos do grupo</strong>${group.vencimentos.map(date => esc(date)).join(' · ')}</div>` : ''}
        ${group.faixas?.length ? `<div class="ap-due"><div class="ap-due-title"><span>Vencimento</span><span>Pagas / total</span></div>${group.faixas.map(item => `<div><span>${esc(item.faixa)}</span><b>${number.format(item.pagas)} <small>/ ${number.format(item.total)}</small></b></div>`).join('')}</div>` : ''}
      </article>`;
    }).join('');
    byId('apUnmapped').hidden = !data.unmapped?.length;
    byId('apUnmapped').textContent = data.unmapped?.length ? `${data.unmapped.length} grupo(s) novo(s) ganharam aba própria. O admin pode vinculá-los a um grupo-mãe em “Organizar grupos”. Empresas sem grupo ficam em Ceará.` : '';
    renderJob();
    renderDetails();
    controls();
  }

  function schedule() {
    clearTimeout(state.timer);
    if (visible()) state.timer = setTimeout(() => load(), state.data?.job?.running ? 2200 : 30000);
  }

  async function load() {
    if (!visible()) return;
    const sequence = ++state.sequence;
    state.loading = true;
    controls();
    try {
      if (state.data?.job?.running) {
        const job = await api('/api/apuracao/job');
        if (sequence !== state.sequence || !visible()) return;
        state.data.job = job;
        renderJob();
        if (job.running) return;
      }
      const week = byId('apWeek').value;
      const data = await api(`/api/apuracao?competencia=${encodeURIComponent(label())}${week ? `&semana=${encodeURIComponent(week)}` : ''}`);
      if (sequence !== state.sequence || !visible()) return;
      const sameDetails = data.run?.id === state.data?.run?.id && data.semana === state.data?.semana;
      const details = sameDetails ? state.details : (data.run ? await loadDetails(data.run.id) : []);
      if (sequence !== state.sequence || !visible()) return;
      state.data = data;
      state.details = details;
      render();
      message();
      const job = data.job || {};
      if (job.error && job.competencia === data.competencia) message(`A última tentativa falhou: ${job.error}. Os últimos dados concluídos foram preservados.`, true);
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

  async function loadDetails(runId) {
    if (!runId) return [];
    const week = byId('apWeek').value;
    const data = await api(`/api/apuracao/detalhes?run=${encodeURIComponent(runId)}${week ? `&semana=${encodeURIComponent(week)}` : ''}`);
    return data.empresas || [];
  }

  async function run() {
    if (state.starting || state.data?.job?.running) return;
    if (!label()) return message('Escolha uma competência válida.', true);
    state.starting = true;
    message();
    controls();
    try {
      const result = await api('/api/apuracao/run', { method: 'POST', body: JSON.stringify({ competencia: label() }) });
      if (state.data) state.data.job = result.job;
      await load();
    } catch (error) {
      message(error.message, true);
    } finally {
      state.starting = false;
      controls();
    }
  }

  async function download(runId) {
    if (!runId || state.exporting) return;
    state.exporting = true;
    controls();
    try {
      const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/apuracao/planilha?run=${encodeURIComponent(runId)}`, { headers: window.PortalAccess.authHeaders() });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Não foi possível baixar a planilha.');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const match = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/);
      anchor.href = url;
      anchor.download = match ? match[1] : 'apuracao.xlsx';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message('Planilha pronta. Se o download não aparecer, use o link:', false, {
        blob,
        filename: match ? match[1] : 'apuracao.xlsx',
      });
    } catch (error) {
      message(error.message, true);
    } finally {
      state.exporting = false;
      controls();
    }
  }

  async function downloadReport() {
    const runId = state.data?.run?.id;
    if (!runId || state.exporting) return;
    state.exporting = true;
    controls();
    try {
      const params = new URLSearchParams({
        run: runId,
        tipo: byId('apReportType').value,
        semana: byId('apWeek').value,
        grupo: state.selectedGroup,
      });
      const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/apuracao/relatorio?${params}`, { headers: window.PortalAccess.authHeaders() });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Não foi possível exportar o relatório.');
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error('O relatório não possui registros para os filtros selecionados.');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const match = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/);
      anchor.href = url;
      anchor.download = match ? match[1] : 'relatorio_apuracao.xlsx';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message('Relatório pronto. Se o download não aparecer, use o link:', false, {
        blob,
        filename: match ? match[1] : 'relatorio_apuracao.xlsx',
      });
    } catch (error) {
      message(error.message, true);
    } finally {
      state.exporting = false;
      controls();
    }
  }

  async function history() {
    const panel = byId('apHistory');
    panel.hidden = false;
    byId('apHistoryRows').textContent = 'Carregando histórico…';
    try {
      const data = await api(`/api/apuracao/runs?competencia=${encodeURIComponent(label())}`);
      byId('apHistoryRows').innerHTML = data.runs.length ? data.runs.map(item => `<div class="ap-history-row"><div><strong>${esc(item.competencia)}</strong><span>${esc(stamp(item.startedAt))} · ${item.mode === 'auto' ? 'Automática' : 'Manual'}${item.timings?.total ? ` · ${secondsText(item.timings.total)}` : ''}</span></div><div><strong>${item.status === 'done' ? `${number.format(item.pagas)} / ${number.format(item.totalEmpresas)} pagas` : item.status === 'error' ? 'Falha na apuração' : 'Em andamento'}</strong>${item.error ? `<span class="ap-history-error">${esc(item.error)}</span>` : ''}</div>${item.hasFile && item.status === 'done' ? `<button class="button button-secondary" type="button" data-ap-download="${esc(item.id)}">Baixar planilha</button>` : ''}</div>`).join('') : '<p>Nenhuma execução registrada nesta competência.</p>';
    } catch (error) {
      byId('apHistoryRows').textContent = error.message;
    }
  }

  function renderMap() {
    byId('apMapRows').innerHTML = state.mapa.map(item => `<tr><td>${esc(item.grupo)}</td><td>${esc(item.tipoPagamento || 'Qualquer')}</td><td><b>${esc(item.grupoMae)}</b></td><td><button type="button" class="ap-link" data-ap-edit="${esc(item.id)}">Editar</button><button type="button" class="ap-link ap-danger" data-ap-delete="${esc(item.id)}">Remover vínculo</button></td></tr>`).join('');
  }

  async function openMap() {
    if (!state.data?.canManage) return;
    byId('apMapMessage').textContent = 'Carregando…';
    byId('apMapDialog').showModal();
    try {
      const [mapping, groups] = await Promise.all([
        api('/api/apuracao/mapa'),
        api(`/api/apuracao/grupos-empresa?run=${encodeURIComponent(state.data?.run?.id || '')}`),
      ]);
      state.mapa = mapping.mapa;
      byId('apMapGroups').innerHTML = [...new Set(groups.grupos.map(item => item.grupo))].map(group => `<option value="${esc(group)}"></option>`).join('');
      byId('apMapTypes').innerHTML = [...new Set(groups.grupos.map(item => item.tipoPagamento).filter(Boolean))].map(type => `<option value="${esc(type)}"></option>`).join('');
      renderMap();
      byId('apMapMessage').textContent = '';
    } catch (error) {
      byId('apMapMessage').textContent = error.message;
    }
  }

  async function saveMap(event) {
    event.preventDefault();
    const button = byId('apMapSave');
    button.disabled = true;
    try {
      await api('/api/apuracao/mapa', { method: 'POST', body: JSON.stringify({ grupo: byId('apMapGroup').value.trim(), tipoPagamento: byId('apMapType').value.trim(), grupoMae: byId('apMapMother').value.trim() }) });
      const data = await api('/api/apuracao/mapa');
      state.mapa = data.mapa;
      renderMap();
      byId('apMapForm').reset();
      byId('apMapMessage').textContent = 'Vínculo salvo. Faça uma nova apuração para aplicá-lo; o histórico permanece intacto.';
    } catch (error) {
      byId('apMapMessage').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function mapAction(event) {
    const edit = event.target.closest('[data-ap-edit]');
    if (edit) {
      const item = state.mapa.find(row => row.id === edit.dataset.apEdit);
      if (!item) return;
      byId('apMapGroup').value = item.grupo;
      byId('apMapType').value = item.tipoPagamento;
      byId('apMapMother').value = item.grupoMae;
      byId('apMapMother').focus();
    }
    const remove = event.target.closest('[data-ap-delete]');
    if (!remove || !confirm('Remover este vínculo? Na próxima apuração, o grupo sem vínculo ganhará uma aba própria. Nenhum dado do S4E ou histórico será apagado.')) return;
    remove.disabled = true;
    try {
      await api(`/api/apuracao/mapa/${encodeURIComponent(remove.dataset.apDelete)}`, { method: 'DELETE' });
      state.mapa = state.mapa.filter(item => item.id !== remove.dataset.apDelete);
      renderMap();
      byId('apMapMessage').textContent = 'Vínculo removido. A mudança vale para a próxima apuração.';
    } catch (error) {
      byId('apMapMessage').textContent = error.message;
      remove.disabled = false;
    }
  }

  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await byId('apuracaoScreen').requestFullscreen();
    } catch {
      message('Seu navegador não permitiu o modo de tela cheia. Você também pode usar F11.');
    }
  }

  function enter() {
    state.active = true;
    load();
  }

  function leave() {
    state.active = false;
    state.sequence += 1;
    clearTimeout(state.timer);
    byId('apMapDialog')?.close();
  }

  const today = new Date();
  byId('apMonth').innerHTML = months.map((month, index) => `<option value="${month}">${month}</option>`).join('');
  const year = today.getFullYear();
  byId('apYear').innerHTML = Array.from({ length: 7 }, (_, index) => year - 3 + index).map(item => `<option value="${item}">${item}</option>`).join('');
  byId('apMonth').value = months[today.getMonth()];
  byId('apYear').value = String(year);
  const changeCompetencia = () => {
    if (!label()) return;
    state.data = null;
    state.selectedGroup = '';
    byId('apHistory').hidden = true;
    message();
    load();
  };
  byId('apSearch').addEventListener('input', () => {
    if (state.data) render();
    if (byId('apGroupDialog').open) renderGroupModal();
  });
  byId('apMonth').addEventListener('change', changeCompetencia);
  byId('apYear').addEventListener('change', changeCompetencia);
  byId('apWeek').addEventListener('change', async () => {
    if (!state.data?.run) return renderDetails();
    try {
      state.selectedGroup = '';
      state.data = null;
      await load();
    } catch (error) {
      message(error.message, true);
    }
  });
  byId('apGrid').addEventListener('click', async event => {
    const card = event.target.closest('[data-ap-group]');
    if (!card || !state.data?.run) return;
    state.selectedGroup = card.dataset.apGroup;
    state.details = await loadDetails(state.data.run.id);
    renderGroupModal();
    byId('apGroupDialog').showModal();
  });
  byId('apGroupClose').addEventListener('click', () => byId('apGroupDialog').close());
  byId('apMoreToggle').addEventListener('click', () => {
    const menu = byId('apMoreMenu');
    const open = menu.hidden;
    menu.hidden = !open;
    byId('apMoreToggle').setAttribute('aria-expanded', String(open));
  });
  byId('apRun').addEventListener('click', run);
  byId('apDownload').addEventListener('click', () => download(state.data?.run?.id));
  byId('apReportDownload').addEventListener('click', downloadReport);
  byId('apHistoryOpen').addEventListener('click', history);
  byId('apHistoryClose').addEventListener('click', () => { byId('apHistory').hidden = true; });
  byId('apHistoryRows').addEventListener('click', event => {
    const button = event.target.closest('[data-ap-download]');
    if (button) download(button.dataset.apDownload);
  });
  byId('apFullscreen').addEventListener('click', fullscreen);
  document.addEventListener('fullscreenchange', () => { byId('apFullscreen').textContent = document.fullscreenElement ? 'Sair do telão' : 'Modo telão'; });
  byId('apMapOpen').addEventListener('click', openMap);
  byId('apMapClose').addEventListener('click', () => byId('apMapDialog').close());
  byId('apMapForm').addEventListener('submit', saveMap);
  byId('apMapRows').addEventListener('click', mapAction);
  window.enterApuracaoScreen = enter;
  window.leaveApuracaoScreen = leave;
})();
