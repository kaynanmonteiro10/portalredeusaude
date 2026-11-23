/* Exclusão de Vidas — prévia, conferência e cancelamento no S4E */
(() => {
  'use strict';
  const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const digits = value => String(value ?? '').replace(/\D/g, '');
  const positiveCode = value => /^\d+$/.test(value) && /[1-9]/.test(value);
  const localToday = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  function isoDate(value) {
    const raw = String(value ?? '').trim();
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
    const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : raw;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    const stamp = Date.parse(`${iso}T12:00:00Z`);
    return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === iso ? iso : '';
  }
  const brDate = value => { const iso = isoDate(value); return iso ? `${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : ''; };
  function validCpf(value) {
    if (!/^[\d.\-\s]+$/.test(String(value))) return false;
    const cpf = digits(value);
    if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
    for (let length = 9; length <= 10; length++) {
      let sum = 0;
      for (let index = 0; index < length; index++) sum += Number(cpf[index]) * (length + 1 - index);
      const check = (sum * 10) % 11 % 10;
      if (check !== Number(cpf[length])) return false;
    }
    return true;
  }
  const extra1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
  function encode1252(text) {
    const bytes = [];
    for (const char of text) {
      const code = char.codePointAt(0);
      if (code < 128 || (code >= 160 && code <= 255)) bytes.push(code);
      else {
        const index = extra1252.indexOf(char);
        if (index < 0 || (code >= 128 && code <= 159)) throw new Error('Há caracteres que não cabem no formato Windows-1252 do modelo. Revise os textos.');
        bytes.push(index + 128);
      }
    }
    return new Uint8Array(bytes);
  }
  function parseCsv(text) {
    const source = String(text).replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], cell = '', quoted = false, closed = false, line = 1, startLine = 1;
    const finishCell = () => { row.push(cell); cell = ''; closed = false; };
    const finishRow = () => {
      finishCell();
      rows.push({ fields: row, line: startLine });
      if (rows.length > 5025) throw new Error('Use até 5.000 pessoas por arquivo.');
      row = [];
    };
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (char === '"') {
          if (source[i + 1] === '"') { cell += '"'; i++; }
          else { quoted = false; closed = true; }
        } else { cell += char; if (char === '\n') line++; }
      } else if (char === ';') finishCell();
      else if (char === '\r' || char === '\n') {
        if (char === '\r' && source[i + 1] === '\n') i++;
        finishRow(); line++; startLine = line;
      } else if (char === '"') {
        if (cell || closed) throw new Error(`Aspas inválidas na linha ${line}. Use CSV separado por ponto e vírgula.`);
        quoted = true;
      } else {
        if (closed) throw new Error(`Texto após fechamento de aspas na linha ${line}.`);
        cell += char;
      }
    }
    if (quoted) throw new Error(`Aspas não fechadas na linha ${startLine}.`);
    if (cell || row.length || closed) finishRow();
    return rows;
  }
  function loadCancellations(text) {
    const parsed = parseCsv(text);
    const rows = [];
    for (const source of parsed) {
      if (source.fields.every(v => !v.trim())) continue;
      if (!rows.length && /^(codigo vida|cod vida|codigo da vida)$/.test(normalize(source.fields[0])) && normalize(source.fields[1]) === 'cpf') continue;
      if (source.fields.length < 2 || source.fields.length > 3) throw new Error(`Linha ${source.line}: use CODIGO VIDA;CPF;NOME (nome opcional).`);
      rows.push({ fields: [source.fields[0].trim(), source.fields[1].trim(), (source.fields[2] || '').trim()], line: source.line, selected: false });
      if (rows.length > 5000) throw new Error('Use até 5.000 pessoas por lista.');
    }
    return rows;
  }
  function unsafeText(value) {
    const text = String(value).trim();
    if (/^[=+\-@]/.test(text)) return 'Não use fórmulas ou textos iniciados por =, +, - ou @.';
    if (/[\x00-\x1f\x7f]/.test(text)) return 'Remova quebras de linha e caracteres de controle do campo.';
    try { encode1252(text); } catch (error) { return error.message; }
    return '';
  }
  function validate(rows, config, today = localToday()) {
    const configErrors = [];
    if (!positiveCode(config.company)) configErrors.push('Informe o código numérico da empresa no S4E, não o nome.');
    if (!isoDate(config.date) || isoDate(config.date) > today) configErrors.push('Informe uma data de cancelamento válida, até hoje.');
    if (!config.comment.trim()) configErrors.push('Informe o motivo / comentário do cancelamento.');
    if (config.comment.length > 500) configErrors.push('Use até 500 caracteres no motivo.');
    const unsafeComment = unsafeText(config.comment);
    if (unsafeComment) configErrors.push(`Motivo: ${unsafeComment}`);
    const items = rows.map(row => {
      const errors = [], fields = row.fields;
      if (!positiveCode(fields[0])) errors.push('Informe o código da vida no S4E, não o código do contrato.');
      if (!validCpf(fields[1])) errors.push('CPF inválido: informe os 11 dígitos com verificadores válidos.');
      fields.forEach((value, index) => {
        const unsafe = unsafeText(value);
        if (unsafe) errors.push(`${['Código', 'CPF', 'Nome'][index]}: ${unsafe}`);
      });
      return { ...row, errors };
    });
    for (const index of [0, 1]) {
      const values = new Map();
      items.forEach((item, position) => {
        const value = index === 1 ? digits(item.fields[index]) : item.fields[index].replace(/^0+/, '');
        if (!value) return;
        if (!values.has(value)) values.set(value, []);
        values.get(value).push(position);
      });
      for (const positions of values.values()) if (positions.length > 1) positions.forEach(position => {
        const message = index === 0 ? 'Código da vida repetido na lista.' : 'CPF repetido na lista.';
        if (!items[position].errors.includes(message)) items[position].errors.push(message);
      });
    }
    return { configErrors, items, validCount: items.filter(item => !item.errors.length).length };
  }
  const csvCell = value => /[;"\r\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value);
  const csvRows = rows => rows.map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
  function exportFile(rows, config) {
    const result = validate(rows, config);
    const selected = result.items.filter(row => row.selected);
    if (result.configErrors.length || !selected.length || selected.some(row => row.errors.length)) throw new Error('Selecione pessoas válidas e corrija as pendências antes de gerar o relatório.');
    const content = csvRows([
      ['CODIGO VIDA', 'CPF', 'NOME', 'CODIGO EMPRESA', 'DATA CANCELAMENTO', 'COMENTARIO'],
      ...selected.map(row => [row.fields[0], digits(row.fields[1]), row.fields[2], config.company, brDate(config.date), config.comment.trim()]),
    ]);
    return { bytes: encode1252(content), text: content, count: selected.length };
  }
  const functions = { isoDate, brDate, validCpf, parseCsv, loadCancellations, validate, exportFile, encode1252, csvRows };
  if (typeof document === 'undefined') { module.exports = functions; return; }
  const el = id => document.getElementById(id);
  if (!el('movimentacoesScreen')) return;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const allowed = () => window.PortalAccess?.canSee('movimentacoesScreen');
  const guidance = 'A prévia confere código e CPF localmente; os códigos e a identidade ainda serão confirmados no S4E.';
  const state = { cancel: [], generation: 0, notice: guidance, fileError: '', pending: null, active: false, page: 1 };
  const rows = () => state.cancel;
  function config() {
    return { company: el('movCompany').value.trim(), date: el('movCancelDate').value, comment: el('movCancelComment').value.trim() };
  }
  function clearConfirmation() { state.pending = null; el('movConfirmDialog').close(); el('movConfirmRead').checked = false; }
  function render() {
    const cfg = config(), result = validate(rows(), cfg);
    const selected = result.items.filter(row => row.selected);
    el('movNotice').textContent = state.notice;
    el('movNotice').classList.toggle('hidden', !state.notice);
    el('movErrors').textContent = [state.fileError, ...(rows().length ? result.configErrors : [])].filter(Boolean).join('\n');
    el('movErrors').classList.toggle('hidden', !el('movErrors').textContent);
    el('movKpis').innerHTML = [['Pessoas na prévia', rows().length], ['Válidas localmente', result.validCount], ['Com pendências', rows().length - result.validCount], ['Selecionadas', selected.length]].map(([name, count]) => `<article><span>${name}</span><strong>${count}</strong></article>`).join('');
    const query = normalize(el('movSearch').value), filter = el('movRowFilter').value, showCpf = el('movShowCpf').checked;
    const filtered = result.items.map((row, index) => ({ row, index })).filter(({ row }) => (!query || normalize(row.fields.join(' ')).includes(query)) && (!filter || (filter === 'valid' ? !row.errors.length : row.errors.length)));
    const pages = Math.max(1, Math.ceil(filtered.length / 50));
    state.page = Math.min(state.page, pages);
    el('movRowCount').textContent = `${filtered.length} de ${rows().length} pessoas · Página ${state.page} de ${pages}. Os filtros não alteram a seleção.`;
    el('movPrevPage').disabled = state.page <= 1;
    el('movNextPage').disabled = state.page >= pages;
    el('movRows').innerHTML = filtered.slice((state.page - 1) * 50, state.page * 50).map(({ row, index }) => {
      const fields = row.fields, name = fields[2] || 'Nome não informado';
      const cpf = digits(fields[1]);
      const cpfLabel = showCpf ? cpf || 'Não informado' : cpf.length === 11 ? `***.***.***-${cpf.slice(-2)}` : 'CPF a revisar';
      const info = `Código da vida S4E: ${fields[0] || 'a revisar'}`;
      return `<tr class="${row.errors.length ? 'mov-row-error' : ''}"><td><input type="checkbox" data-mov-select="${index}" aria-label="Selecionar ${esc(name)}" ${row.selected ? 'checked' : ''} ${row.errors.length ? 'disabled' : ''}></td><td>${row.line}</td><td><strong>${esc(name)}</strong></td><td>${esc(cpfLabel)}</td><td>${esc(info)}<details><summary>Ver dados</summary><dl>${fields.map((value, column) => {
        const displayed = column === 1 && !showCpf ? 'Protegido' : value || 'Não informado';
        return `<dt>${esc(['Código da vida S4E', 'CPF', 'Nome'][column])}</dt><dd>${esc(displayed)}</dd>`;
      }).join('')}</dl></details></td><td>${row.errors.length ? `<ul>${row.errors.map(error => `<li>${esc(error)}</li>`).join('')}</ul>` : '<span class="mov-valid">Válida localmente</span>'}</td><td><button type="button" class="button button-secondary" data-mov-remove="${index}" aria-label="Remover ${esc(name)} da prévia">Remover</button></td></tr>`;
    }).join('');
    el('movEmpty').textContent = rows().length ? 'Nenhuma pessoa corresponde aos filtros.' : 'Adicione uma pessoa ou uma lista para começar.';
    el('movEmpty').classList.toggle('hidden', filtered.length > 0);
    el('movExport').disabled = !allowed() || result.configErrors.length > 0 || !selected.length || selected.some(row => row.errors.length);
  }
  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'text/csv;charset=windows-1252' }));
    const link = document.createElement('a'); link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const pagination = document.createElement('div');
  pagination.className = 'form-actions';
  pagination.setAttribute('aria-label', 'Páginas da prévia');
  pagination.innerHTML = '<button id="movPrevPage" type="button" class="button button-secondary">Anterior</button><button id="movNextPage" type="button" class="button button-secondary">Próxima</button>';
  el('movRowCount').after(pagination);
  el('movPrevPage').addEventListener('click', () => { state.page--; render(); });
  el('movNextPage').addEventListener('click', () => { state.page++; render(); });
  el('movCancelDate').value = localToday();
  el('movCancelDate').max = localToday();
  ['movCompany', 'movCancelDate', 'movCancelComment'].forEach(id => el(id).addEventListener('input', () => { clearConfirmation(); render(); }));
  ['movSearch', 'movRowFilter', 'movShowCpf'].forEach(id => el(id).addEventListener('input', () => { state.page = 1; render(); }));
  el('movCancelForm').addEventListener('submit', event => {
    event.preventDefault(); if (!allowed()) return;
    if (state.cancel.length >= 5000) { state.fileError = 'Use até 5.000 pessoas por prévia.'; render(); return; }
    state.cancel.push({ fields: [el('movCancelCode').value.trim(), el('movCancelCpf').value.trim(), el('movCancelName').value.trim()], line: state.cancel.length + 1, selected: false });
    el('movCancelForm').reset(); state.fileError = ''; clearConfirmation(); render();
  });
  el('movCancelBulkForm').addEventListener('submit', event => {
    event.preventDefault(); if (!allowed()) return;
    try {
      const loaded = loadCancellations(el('movCancelBulk').value);
      if (!loaded.length) throw new Error('Cole pelo menos uma pessoa na lista.');
      if (state.cancel.length + loaded.length > 5000) throw new Error('Use até 5.000 pessoas por prévia.');
      state.cancel.push(...loaded);
      state.fileError = ''; state.notice = `${plural(loaded.length, 'pessoa adicionada', 'pessoas adicionadas')} à prévia de exclusões. Nenhuma está selecionada automaticamente.`;
      el('movCancelBulk').value = ''; clearConfirmation();
    } catch (error) { state.fileError = error.message; }
    render();
  });
  el('movRows').addEventListener('change', event => {
    if (!allowed() || event.target.dataset.movSelect === undefined) return;
    const index = Number(event.target.dataset.movSelect), result = validate(rows(), config());
    if (!result.items[index]?.errors.length && rows()[index]) rows()[index].selected = event.target.checked;
    clearConfirmation(); render();
  });
  el('movRows').addEventListener('click', event => {
    const button = event.target.closest('[data-mov-remove]'); if (!button || !allowed()) return;
    rows().splice(Number(button.dataset.movRemove), 1); clearConfirmation(); render();
  });
  el('movSelectValid').addEventListener('click', () => {
    if (!allowed()) return;
    const result = validate(rows(), config());
    rows().forEach((row, index) => { row.selected = !result.items[index].errors.length; }); clearConfirmation(); render();
  });
  el('movDeselectAll').addEventListener('click', () => { rows().forEach(row => { row.selected = false; }); clearConfirmation(); render(); });
  el('movRemoveAll').addEventListener('click', () => {
    if (!allowed() || !rows().length || !window.confirm('Limpar as pessoas desta prévia? Nenhum registro do portal ou do S4E será apagado.')) return;
    state.generation++; state.cancel = []; state.fileError = ''; state.notice = guidance; clearConfirmation(); render();
  });
  el('movExport').addEventListener('click', () => {
    if (!allowed()) return;
    try {
      const cfg = config(), output = exportFile(rows(), cfg);
      state.pending = { output, generation: state.generation };
      el('movConfirmSummary').textContent = `${plural(output.count, 'pessoa selecionada', 'pessoas selecionadas')} · Empresa S4E: ${cfg.company} · Data: ${brDate(cfg.date)}. Será baixado o relatório da prévia. Nada será enviado ao S4E.`;
      el('movConfirmRead').checked = false; el('movConfirmDialog').showModal();
    } catch (error) { state.fileError = error.message; render(); }
  });
  el('movConfirmCancel').addEventListener('click', clearConfirmation);
  el('movConfirmDialog').addEventListener('close', () => { state.pending = null; });
  el('movConfirmForm').addEventListener('submit', event => {
    event.preventDefault();
    if (!allowed() || !state.pending || !el('movConfirmRead').checked || state.pending.generation !== state.generation || !state.active) return;
    const { output } = state.pending;
    download(output.bytes, 'relatorio-exclusoes.csv');
    state.notice = `${plural(output.count, 'pessoa no relatório gerado', 'pessoas no relatório gerado')}. Nenhum cancelamento foi enviado ao S4E.`;
    clearConfirmation(); render();
  });
  window.enterMovimentacoesScreen = () => { if (!allowed()) return; state.active = true; render(); };
  window.leaveMovimentacoesScreen = () => { state.active = false; state.generation++; el('movShowCpf').checked = false; clearConfirmation(); render(); };
  window.resetMovimentacoes = () => {
    state.cancel = []; state.page = 1; state.notice = guidance; state.fileError = ''; state.active = false; state.generation++;
    ['movCompany', 'movCancelComment'].forEach(id => { el(id).value = ''; });
    el('movCancelDate').value = localToday();
    ['movCancelForm', 'movCancelBulkForm'].forEach(id => el(id).reset());
    ['movSearch', 'movRowFilter'].forEach(id => { el(id).value = ''; });
    el('movShowCpf').checked = false; clearConfirmation(); render();
  };
  render();
})();
