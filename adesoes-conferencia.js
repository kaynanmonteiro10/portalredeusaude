(function () {
  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const api = (path, options) => window.PortalAccess.api(path, options);
  const number = new Intl.NumberFormat('pt-BR');
  const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Fortaleza' });
  const stamp = value => value ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza', dateStyle: 'short', timeStyle: 'short' }) : '—';
  const state = { active: false, data: null, loading: false, conferindo: false };

  function renderKpis(data) {
    const html = [
      `<article class="stat-card"><span>Total</span><strong>${esc(number.format(data.total))}</strong><small>adesões registradas</small></article>`,
      `<article class="stat-card"><span>✅ Conferidos</span><strong>${esc(number.format(data.conferidos))}</strong><small>validados</small></article>`,
      `<article class="stat-card"><span>⚠️ Alertas</span><strong>${esc(number.format(data.alertas))}</strong><small>com avisos</small></article>`,
      `<article class="stat-card"><span>❌ Problemas</span><strong>${esc(number.format(data.problemas))}</strong><small>erros encontrados</small></article>`,
      `<article class="stat-card"><span>🔵 Pendentes</span><strong>${esc(number.format(data.pendentes))}</strong><small>aguardando revisão</small></article>`,
    ];
    byId('adKpis').innerHTML = html.join('');
  }

  function statusBadge(status) {
    const badges = {
      'validado': '<span class="ad-badge conferido">✅ Conferido</span>',
      'erro': '<span class="ad-badge problema">❌ Problema</span>',
      'pendente': '<span class="ad-badge pendente">🔵 Pendente</span>',
    };
    return badges[status] || '<span class="ad-badge pendente">—</span>';
  }

  function typeBadge(tipo) {
    return tipo === 'CRM' ? '<span class="ad-badge-type">CRM</span>' : '<span class="ad-badge-type">WEB</span>';
  }

  function renderTable(adesoes) {
    if (!adesoes || !adesoes.length) {
      byId('adTableBody').innerHTML = '<tr><td colspan="10" class="ad-empty"><p>Nenhuma adesão encontrada</p></td></tr>';
      return;
    }

    const rows = adesoes.map(a => {
      const rowClass = a.tipo === 'CRM' ? 'ad-crm' : 'ad-web';
      return `<tr class="${rowClass}">
        <td><strong>${esc(a.lote)}</strong></td>
        <td>${esc(a.empresa)}</td>
        <td>${number.format(a.vidas || 0)}</td>
        <td>${a.valor ? `R$ ${number.format(a.valor)}` : '—'}</td>
        <td>${a.dataEntrada || '—'}</td>
        <td>${a.dataAdesao || '—'}</td>
        <td>${typeBadge(a.tipo)}</td>
        <td>${statusBadge(a.statusConferencia)}</td>
        <td>${esc(a.situacao || 'ativo')}</td>
        <td class="ad-actions">
          <button type="button" data-ad-detail="${esc(a.id)}">Revisar</button>
          ${a.statusConferencia === 'pendente' ? `<button type="button" data-ad-conferir="${esc(a.id)}">Conferir</button>` : ''}
        </td>
      </tr>`;
    });

    byId('adTableBody').innerHTML = rows.join('');
  }

  function showDetail(adesao) {
    const modal = byId('adDetailModal');
    if (!modal) return;

    const resultItem = adesao.conferencia_resultado
      ? `<div class="ad-results">
        <h3>Resultado da Conferência</h3>
        ${(() => {
          try {
            const result = JSON.parse(adesao.conferencia_resultado);
            const val = result.validation || {};
            let html = '';
            if (val.errors && val.errors.length) {
              html += '<div class="ad-result-item"><strong class="ad-result-error">❌ Erros:</strong></div>';
              val.errors.forEach(err => {
                html += `<div class="ad-result-item"><span>• ${esc(err)}</span></div>`;
              });
            }
            if (val.warnings && val.warnings.length) {
              html += '<div class="ad-result-item"><strong class="ad-result-warning">⚠️ Avisos:</strong></div>';
              val.warnings.forEach(warn => {
                html += `<div class="ad-result-item"><span>• ${esc(warn)}</span></div>`;
              });
            }
            if (!html) html = '<div class="ad-result-item"><span>Validação passou sem problemas</span></div>';
            return html;
          } catch (e) {
            return '<div class="ad-result-item"><span>Erro ao processar resultado</span></div>';
          }
        })()}
      </div>` : '';

    const body = modal.querySelector('.ad-modal-content') || byId('adDetailBody');
    body.innerHTML = `
      <div class="ad-modal-title">
        <div>
          <h2>Adesão #${esc(adesao.lote)}</h2>
          <p class="ad-modal-sub">${esc(adesao.empresa)}</p>
        </div>
      </div>

      <div class="ad-info-grid">
        <div class="ad-info-item"><span>Lote</span><strong>${esc(adesao.lote)}</strong></div>
        <div class="ad-info-item"><span>Empresa</span><strong>${esc(adesao.empresa)}</strong></div>
        <div class="ad-info-item"><span>Tipo</span><strong>${esc(adesao.tipo)}</strong></div>
        <div class="ad-info-item"><span>Vidas</span><strong>${number.format(adesao.vidas || 0)}</strong></div>
        <div class="ad-info-item"><span>Valor</span><strong>${adesao.valor ? `R$ ${number.format(adesao.valor)}` : '—'}</strong></div>
        <div class="ad-info-item"><span>Data de Entrada</span><strong>${adesao.dataEntrada}</strong></div>
        <div class="ad-info-item"><span>Data Adesão</span><strong>${adesao.dataAdesao}</strong></div>
        <div class="ad-info-item"><span>Situação</span><strong>${esc(adesao.situacao)}</strong></div>
        <div class="ad-info-item"><span>Status</span><strong>${statusBadge(adesao.statusConferencia).replace('<span', '<strong').replace('</span>', '</strong>')}</strong></div>
      </div>

      ${resultItem}

      <form id="adDetailForm" class="ad-notes">
        <label>Observações (opcional)</label>
        <textarea name="notas" placeholder="Anotações sobre a conferência deste lote…">${esc(adesao.notasConferencia || '')}</textarea>
        <div class="ad-modal-actions">
          <button type="submit" class="button button-primary">Confirmar conferência</button>
          <button type="button" class="button button-secondary" id="adDetailClose">Fechar</button>
        </div>
      </form>
    `;

    byId('adDetailForm').addEventListener('submit', e => {
      e.preventDefault();
      conferirAdesao(adesao.id);
    });

    byId('adDetailClose').addEventListener('click', () => {
      modal.close();
    });

    modal.showModal && modal.showModal();
  }

  async function load() {
    state.loading = true;
    byId('adTableBody').innerHTML = '<tr><td colspan="10" class="ad-loading">Carregando…</td></tr>';

    try {
      const mes = byId('adMes').value || new Date().getMonth() + 1;
      const ano = byId('adAno').value || new Date().getFullYear();
      const tipo = byId('adTipo').value;
      const search = byId('adSearch')?.value || '';

      const data = await api(`/api/adesoes?mes=${mes}&ano=${ano}${tipo ? `&tipo=${tipo}` : ''}${search ? `&search=${encodeURIComponent(search)}` : ''}`);
      state.data = data;

      renderKpis(data);
      renderTable(data.adesoes);
    } catch (error) {
      byId('adTableBody').innerHTML = `<tr><td colspan="10" class="ad-empty"><p>Erro ao carregar: ${esc(error.message)}</p></td></tr>`;
    } finally {
      state.loading = false;
    }
  }

  async function conferirTodos() {
    if (state.conferindo) return;
    state.conferindo = true;
    byId('adConferirTodosBtn').disabled = true;

    try {
      const mes = byId('adMes').value;
      const ano = byId('adAno').value;

      const result = await api(`/api/adesoes/conferir-todos?mes=${mes}&ano=${ano}`, { method: 'GET' });
      alert(`Conferência concluída:\n${result.processados} processadas\n${result.conferidos} conferidas\n${result.alertas} com alertas\n${result.problemas} com problemas`);

      await load();
    } catch (error) {
      alert('Erro: ' + error.message);
    } finally {
      state.conferindo = false;
      byId('adConferirTodosBtn').disabled = false;
    }
  }

  async function conferirAdesao(adesaoId) {
    const notas = document.querySelector('textarea[name="notas"]')?.value || '';

    try {
      await api(`/api/adesoes/conferir/${encodeURIComponent(adesaoId)}`, {
        method: 'POST',
        body: JSON.stringify({ notas })
      });

      byId('adDetailModal')?.close?.();
      alert('Adesão conferida com sucesso');
      await load();
    } catch (error) {
      alert('Erro: ' + error.message);
    }
  }

  function enter() {
    state.active = true;
    load();
  }

  function leave() {
    state.active = false;
  }

  window.enterAdesiScreen = enter;
  window.leaveAdesiScreen = leave;

  byId('adMes')?.addEventListener('change', load);
  byId('adAno')?.addEventListener('change', load);
  byId('adTipo')?.addEventListener('change', load);
  byId('adSearch')?.addEventListener('input', e => {
    clearTimeout(window.adSearchTimeout);
    window.adSearchTimeout = setTimeout(load, 300);
  });
  byId('adConferirTodosBtn')?.addEventListener('click', conferirTodos);

  byId('adTableBody')?.addEventListener('click', e => {
    if (e.target.dataset.adDetail) {
      const adesao = state.data?.adesoes?.find(a => a.id === e.target.dataset.adDetail);
      if (adesao) showDetail(adesao);
    }
    if (e.target.dataset.adConferir) {
      conferirAdesao(e.target.dataset.adConferir);
    }
  });

  byId('adDetailClose')?.addEventListener('click', () => {
    byId('adDetailModal')?.close?.();
  });
})();
