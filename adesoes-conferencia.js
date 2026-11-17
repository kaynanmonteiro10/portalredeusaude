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
      'alerta': '<span class="ad-badge alerta">⚠️ Alerta</span>',
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

  async function load(pageNum = 1) {
    state.loading = true;
    byId('adTableBody').innerHTML = '<tr><td colspan="10" class="ad-loading">Carregando…</td></tr>';

    try {
      const mes = byId('adMes').value || new Date().getMonth() + 1;
      const ano = byId('adAno').value || new Date().getFullYear();
      const tipo = byId('adTipo').value;
      const search = byId('adSearch')?.value || '';

      const data = await api(`/api/adesoes?mes=${mes}&ano=${ano}&page=${pageNum}&pageSize=50${tipo ? `&tipo=${tipo}` : ''}${search ? `&search=${encodeURIComponent(search)}` : ''}`);
      state.data = data;

      renderKpis(data);
      renderTable(data.adesoes);
      renderPagination(data.page, data.pages);
    } catch (error) {
      byId('adTableBody').innerHTML = `<tr><td colspan="10" class="ad-empty"><p>Erro ao carregar: ${esc(error.message)}</p></td></tr>`;
    } finally {
      state.loading = false;
    }
  }

  function renderPagination(currentPage, totalPages) {
    const container = byId('adPaginationContainer');
    if (!container) return;
    
    if (totalPages <= 1) {
      container.innerHTML = '';
      return;
    }

    let html = '<div class="ad-pagination">';
    
    if (currentPage > 1) {
      html += `<button type="button" class="ad-page-btn" data-page="1">Primeira</button>`;
      html += `<button type="button" class="ad-page-btn" data-page="${currentPage - 1}">Anterior</button>`;
    }

    const startPage = Math.max(1, currentPage - 2);
    const endPage = Math.min(totalPages, currentPage + 2);

    if (startPage > 1) html += '<span class="ad-page-ellipsis">…</span>';

    for (let i = startPage; i <= endPage; i++) {
      if (i === currentPage) {
        html += `<span class="ad-page-num ad-page-active">${i}</span>`;
      } else {
        html += `<button type="button" class="ad-page-btn" data-page="${i}">${i}</button>`;
      }
    }

    if (endPage < totalPages) html += '<span class="ad-page-ellipsis">…</span>';

    if (currentPage < totalPages) {
      html += `<button type="button" class="ad-page-btn" data-page="${currentPage + 1}">Próxima</button>`;
      html += `<button type="button" class="ad-page-btn" data-page="${totalPages}">Última</button>`;
    }

    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.ad-page-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pageNum = parseInt(btn.dataset.page, 10);
        load(pageNum);
      });
    });
  }

  async function conferirTodos() {
    if (state.conferindo) return;
    state.conferindo = true;
    const btn = byId('adConferirTodosBtn');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Processando...';

    try {
      const mes = byId('adMes').value;
      const ano = byId('adAno').value;

      const result = await api(`/api/adesoes/conferir-todos?mes=${mes}&ano=${ano}`, { method: 'GET' });
      
      let message = `✅ Conferência concluída!\n\n`;
      message += `Processadas: ${result.processados}\n`;
      message += `✅ Conferidas: ${result.conferidos}\n`;
      message += `⚠️ Com alertas: ${result.alertas}\n`;
      message += `❌ Com problemas: ${result.problemas}`;
      
      alert(message);
      await load();
    } catch (error) {
      alert('Erro ao processar adesões: ' + error.message);
    } finally {
      state.conferindo = false;
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  async function exportarExcel() {
    if (!state.data || !state.data.adesoes || !state.data.adesoes.length) {
      alert('Nenhum dado para exportar');
      return;
    }

    try {
      const ExcelJS = window.ExcelJS;
      if (!ExcelJS) {
        alert('ExcelJS não está disponível');
        return;
      }

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Adesões');

      // Headers
      ws.columns = [
        { header: 'Lote', key: 'lote', width: 15 },
        { header: 'Empresa', key: 'empresa', width: 25 },
        { header: 'Vidas', key: 'vidas', width: 10 },
        { header: 'Valor', key: 'valor', width: 15 },
        { header: 'Data Entrada', key: 'dataEntrada', width: 15 },
        { header: 'Data Adesão', key: 'dataAdesao', width: 15 },
        { header: 'Tipo', key: 'tipo', width: 10 },
        { header: 'Status Conferência', key: 'statusConferencia', width: 18 },
        { header: 'Situação', key: 'situacao', width: 12 },
        { header: 'Conferido em', key: 'conferidoEm', width: 18 },
        { header: 'Observações', key: 'notasConferencia', width: 30 }
      ];

      // Style header row
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B8F87' } };
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

      // Add data rows
      state.data.adesoes.forEach(adesao => {
        const row = ws.addRow({
          lote: adesao.lote,
          empresa: adesao.empresa,
          vidas: adesao.vidas || 0,
          valor: adesao.valor || 0,
          dataEntrada: adesao.dataEntrada || '',
          dataAdesao: adesao.dataAdesao || '',
          tipo: adesao.tipo,
          statusConferencia: adesao.statusConferencia,
          situacao: adesao.situacao,
          conferidoEm: adesao.conferidoEm || '',
          notasConferencia: adesao.notasConferencia || ''
        });

        // Color rows based on type
        if (adesao.tipo === 'CRM') {
          row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FF' } };
        } else if (adesao.tipo === 'WEB') {
          row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FAF5' } };
        }
      });

      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `adesoes-${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      alert('Erro ao exportar: ' + error.message);
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
  byId('adExportarBtn')?.addEventListener('click', exportarExcel);

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
