// Leitor do Relatório de Faturamento do S4E.
// Somente leitura: usa GETs do próprio relatório e da ficha do associado.
(function () {
  const DEFAULT_PARAMS = {
    centro_custo: '-1',
    TP_EMPRESA: '-1',
    cd_empresa: '',
    tipo_pagamento: '-1',
    tipo_recebimento: '-1',
    cd_equipe: '0',
    cd_vendedor: '-1',
    ContasReceber: '1',
    tipoFatura: '5',
    tp_associado_empresa: '0',
    CD_GRUPOAnalise: '-1',
    cd_grupo: '-1',
    depId: '-99',
    cd_tipo_parcela: '-1',
  };
  const PARAM_ORDER = [
    'centro_custo', 'TP_EMPRESA', 'cd_empresa', 'tipo_pagamento', 'tipo_recebimento',
    'TXT_BuscaperiodoInicial', 'TXT_BuscaperiodoFinal', 'cd_equipe', 'cd_vendedor',
    'ContasReceber', 'tipoFatura', 'tp_associado_empresa', 'CD_GRUPOAnalise', 'cd_grupo',
    'depId', 'cd_tipo_parcela',
  ];
  const MAX_ROWS = 20000;
  const MAX_CLIENTS = 3000;
  const BATCH_SIZE = 1500;
  const COMPANY_TYPES = ['2', '6', '7', '8'];
  const COMPANY_TYPE_LABELS = {
    '2': 'Coletivo Empresarial',
    '6': 'PJ Grupo',
    '7': 'PJ Pagamento Especial',
    '8': 'Coletivo por Adesão',
  };
  const CNPJ_RE = /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/;
  let busy = false;

  function formValue(name) {
    const field = document.getElementsByName(name)[0];
    if (!field) return '';
    const value = String(field.value == null ? '' : field.value).trim();
    return value;
  }

  function firstFormValue(names) {
    for (const name of names) {
      const value = formValue(name);
      if (value !== '') return value;
    }
    return '';
  }

  function hasReportForm() {
    return Boolean(
      document.getElementsByName('TXT_DataInicial')[0]
      || document.getElementsByName('CMB_TipoParcela')[0]
      || document.getElementsByName('cmbDepartamento')[0]
      || document.getElementsByName('TXT_BuscaperiodoInicial')[0]
      || document.getElementsByName('depId')[0]
      || /relatoriofaturamento/i.test(location.pathname)
    );
  }

  function isReportPage() {
    if (hasReportForm()) return true;
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const text = (table.innerText || '').toLowerCase();
      if (text.includes('vencimento') && text.includes('cliente') && text.includes('valor')) return true;
    }
    return false;
  }

  function todayBr() {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
  }

  function normalizeDate(value) {
    const raw = String(value || '').trim();
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) return raw;
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      const [year, month, day] = raw.slice(0, 10).split('-');
      return `${day}/${month}/${year}`;
    }
    return '';
  }

  function buildParams(tpEmpresa) {
    const params = { ...DEFAULT_PARAMS };
    const paramsFromPage = {
      centro_custo: ['CMB_CentroCusto', 'centro_custo'],
      TP_EMPRESA: ['CMB_TipoEmpresa', 'TP_EMPRESA'],
      tipo_pagamento: ['CMB_TipoPagamento', 'tipo_pagamento'],
      cd_tipo_parcela: ['CMB_TipoParcela', 'cd_tipo_parcela'],
      depId: ['cmbDepartamento', 'depId'],
      cd_empresa: ['cd_empresa'],
      tipo_recebimento: ['tipo_recebimento'],
      cd_equipe: ['cd_equipe'],
      cd_vendedor: ['cd_vendedor'],
      tp_associado_empresa: ['tp_associado_empresa'],
      CD_GRUPOAnalise: ['CD_GRUPOAnalise'],
      cd_grupo: ['cd_grupo'],
    };
    Object.entries(paramsFromPage).forEach(([param, names]) => {
      const value = firstFormValue(names);
      if (value !== '') params[param] = value;
    });
    if (tpEmpresa) params.TP_EMPRESA = tpEmpresa;
    const start = normalizeDate(firstFormValue(['TXT_DataInicial', 'TXT_BuscaperiodoInicial'])) || '01/01/2020';
    const end = normalizeDate(firstFormValue(['TXT_DataFinal', 'TXT_BuscaperiodoFinal'])) || todayBr();
    params.TXT_BuscaperiodoInicial = start;
    params.TXT_BuscaperiodoFinal = end;
    params.ContasReceber = '1';
    params.tipoFatura = '5';
    const query = PARAM_ORDER
      .map(name => `${encodeURIComponent(name)}=${encodeURIComponent(params[name] == null ? '' : params[name])}`)
      .join('&');
    return { query, periodStart: start, periodEnd: end };
  }

  function pageType() {
    return firstFormValue(['CMB_TipoEmpresa', 'TP_EMPRESA']) || '-1';
  }

  function reportCompanyTypes(tp) {
    if (!tp || tp === '-1') return COMPANY_TYPES.slice();
    if (COMPANY_TYPES.includes(tp)) return [tp];
    throw new Error('Esse filtro do S4E é de associados. A Cobrança trabalha com empresas: escolha "Coletivo Empresarial" ou "Coletivo por Adesão" (ou deixe em branco) e clique em Buscar de novo.');
  }

  // A baixa automática só é segura quando o relatório traz todas as empresas;
  // com qualquer filtro aplicado, um caso ausente pode apenas estar fora do filtro.
  function pageFiltersAreDefault() {
    const defaults = {
      CMB_CentroCusto: ['-1'],
      CMB_TipoPagamento: ['-1'],
      CMB_TipoParcela: ['-1'],
      cmbDepartamento: ['-1', '-99'],
      cd_grupo: ['-1'],
      CD_GRUPOAnalise: ['-1'],
      cd_equipe: ['0'],
      cd_vendedor: ['-1'],
      tp_associado_empresa: ['0'],
    };
    for (const [name, allowed] of Object.entries(defaults)) {
      const value = formValue(name);
      if (value !== '' && !allowed.includes(value)) return false;
    }
    const start = formValue('TXT_DataInicial') || formValue('TXT_BuscaperiodoInicial');
    const end = formValue('TXT_DataFinal') || formValue('TXT_BuscaperiodoFinal');
    return !start && !end;
  }

  function companyFichaUrl(id) {
    return `${location.origin}/SYS/Consultas/ConsultaGeralEmpresa.aspx?operacao=4&tipo=3&origem_info=3&codigo=${encodeURIComponent(id)}&TXT_BuscaNome=&CMB_grupo=&TXT_BuscaCodigo=&TXT_NRCGC=`;
  }

  function associateFichaUrl(id) {
    return `${location.origin}/SYS/Consultas/ConsultaGeralAssociado.aspx?operacao=4&tipo=1&origem_info=1&cdassociado=${encodeURIComponent(id)}`;
  }

  function parseMoney(value) {
    const raw = String(value || '').replace(/R\$/i, '').replace(/\s/g, '');
    if (!raw) return 0;
    let normalized = raw;
    if (raw.includes(',')) normalized = raw.replace(/\./g, '').replace(',', '.');
    const number = Number(normalized);
    return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
  }

  function parseDate(value) {
    const raw = String(value || '').trim();
    const match = /(\d{2})\/(\d{2})\/(\d{4})/.exec(raw);
    if (match) return `${match[1]}/${match[2]}/${match[3]}`;
    const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
    return '';
  }

  function stripAccents(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function cellText(row, index) {
    const cell = row.cells[index];
    if (!cell) return '';
    return String(cell.textContent || '').replace(/\s+/g, ' ').trim();
  }

  async function fetchText(url, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        credentials: 'include',
        signal: controller.signal,
        headers: { Accept: '*/*' },
      });
      if (!response.ok) throw new Error(`O S4E respondeu ${response.status}.`);
      const buffer = await response.arrayBuffer();
      const type = response.headers.get('content-type') || '';
      let charset = (/charset=([\w-]+)/i.exec(type) || [])[1] || '';
      if (!charset) {
        const head = new TextDecoder('latin1').decode(buffer.slice(0, 1500));
        // O S4E não envia charset no .xls; sem declaração explícita, usa-se windows-1252.
        charset = (/charset=["']?([\w-]+)/i.exec(head) || [])[1] || 'windows-1252';
      }
      const decoderName = /8859|1252|latin/i.test(charset) ? 'windows-1252' : 'utf-8';
      return new TextDecoder(decoderName).decode(buffer);
    } finally {
      clearTimeout(timer);
    }
  }

  function parseReport(html, options) {
    const onlyCompanies = Boolean(options && options.onlyCompanies);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let best = null;
    let bestRows = 0;
    doc.querySelectorAll('table').forEach(table => {
      let count = 0;
      Array.from(table.rows).forEach(row => {
        if (row.cells.length >= 25) count += 1;
      });
      if (count > bestRows) {
        bestRows = count;
        best = table;
      }
    });
    if (!best) return [];

    const today = (() => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    })();
    const rows = [];
    const seen = new Set();

    Array.from(best.rows).forEach(row => {
      if (row.cells.length < 28) return;
      const cliente = cellText(row, 0).replace(/\s+/g, ' ').trim();
      if (!cliente || /^cliente$/i.test(cliente) || /^total/i.test(cliente)) return;
      const codeMatch = /^\s*(\d+)\s*-/.exec(cliente);
      if (!codeMatch) return;
      const situacao = stripAccents(cellText(row, 7)).toUpperCase();
      const tituloSituacao = stripAccents(cellText(row, 24)).toUpperCase();
      if (/PAGO|BAIXAD|CANCEL|QUITAD|RECEBID/.test(tituloSituacao)) return;
      const pagamentoValor = parseMoney(cellText(row, 21));
      if (pagamentoValor > 0) return;
      const vencimento = parseDate(cellText(row, 10));
      if (!vencimento) return;
      const [day, month, year] = vencimento.split('/');
      const isoDate = `${year}-${month}-${day}`;
      if (isoDate > today) return;
      const valor = parseMoney(cellText(row, 11));
      if (valor <= 0) return;
      const tipoParcela = stripAccents(cellText(row, 23)).toUpperCase().replace(/CO-PARTICIPACAO/g, 'CO-PARTICIPACAO');
      const documento = cellText(row, 1);
      if (onlyCompanies && !CNPJ_RE.test(documento)) return;
      const item = {
        cliente,
        documento,
        grupo: cellText(row, 2),
        empresa: cellText(row, 3),
        departamento: cellText(row, 4),
        cdAssociado: codeMatch[1],
        situacao,
        tituloSituacao,
        vencimento,
        valor,
        tipoParcela,
        tipoPagamento: cellText(row, 25),
        competencia: cellText(row, 26),
        parcela: cellText(row, 27),
      };
      const key = `${item.documento}|${item.competencia}|${item.vencimento}|${item.parcela}|${item.tipoParcela}|${valor.toFixed(2)}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(item);
    });
    return rows;
  }

  const EMAIL_RE = /(^|[^\w.@-])([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})(?=$|[^\w.@-])/gi;
  const CONTACT_LABEL_RE = /^(e-?mail|whatsapp|whats|telefone|fone|celular)\s*:?\s*/i;

  function addEmail(list, value) {
    let email = String(value || '').trim().replace(/^mailto:/i, '').split(/[?#]/)[0];
    const withoutLabel = email.replace(CONTACT_LABEL_RE, '');
    if (withoutLabel !== email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(withoutLabel)) email = withoutLabel;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
    if (/@s4e\.com\.br$/i.test(email)) return;
    if (!list.some(item => item.toLowerCase() === email.toLowerCase())) list.push(email);
  }

  function addEmailsFromText(list, text) {
    const raw = String(text || '').trim();
    if (!raw || !raw.includes('@')) return;
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
      addEmail(list, raw);
      return;
    }
    EMAIL_RE.lastIndex = 0;
    let match;
    while ((match = EMAIL_RE.exec(raw)) !== null) addEmail(list, match[2]);
  }

  const PHONE_RE = /\(?(\d{2})\)?[\s.-]?(9?\d{4})[\s.-]?(\d{4})(?!\d)/g;

  function addPhone(list, value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) return;
    if (!list.includes(digits)) list.push(digits);
  }

  function addPhonesFromText(list, text) {
    const raw = String(text || '');
    PHONE_RE.lastIndex = 0;
    let match;
    while ((match = PHONE_RE.exec(raw)) !== null) {
      addPhone(list, `${match[1]}${match[2]}${match[3]}`);
    }
  }

  // Células do ASP.NET trazem o bloco __doPostBack como texto: sem esse filtro,
  // números soltos do script viram telefone falso na ficha.
  const SCRIPT_TEXT_RE = /function\s|CDATA|__doPostBack|\{|\}/i;

  function parseContacts(html) {
    const emails = [];
    const phones = [];
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('a[href^="mailto:" i]').forEach(link => addEmail(emails, link.getAttribute('href')));
    doc.querySelectorAll('a[href*="wa.me" i], a[href*="whatsapp" i], a[href^="tel:" i]').forEach(link => addPhone(phones, link.getAttribute('href')));
    doc.querySelectorAll('tr').forEach(row => {
      const cells = Array.from(row.cells).map(cell => String(cell.textContent || '').replace(/\s+/g, ' ').trim());
      const joined = cells.join(' | ');
      if (!/(e-?mail|whats|fone|telefone|celular)/i.test(joined)) return;
      cells.forEach(cell => {
        if (!cell || SCRIPT_TEXT_RE.test(cell)) return;
        addEmailsFromText(emails, cell);
        addPhonesFromText(phones, cell);
        const compact = cell.replace(CONTACT_LABEL_RE, '').trim();
        const digits = compact.replace(/\D/g, '');
        if (digits.length >= 10 && digits.length <= 13 && compact.replace(/\d/g, '').length <= 4) addPhone(phones, digits);
      });
    });
    if (!emails.length) addEmailsFromText(emails, doc.body ? doc.body.innerText : html);
    return { emails: emails.slice(0, 6), phones: phones.slice(0, 6) };
  }

  async function mapLimit(items, limit, worker, onProgress) {
    let cursor = 0;
    let done = 0;
    async function runner() {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        try {
          await worker(items[index], index);
        } catch (_) {}
        done += 1;
        if (onProgress && (done % 20 === 0 || done === items.length)) onProgress(done);
      }
    }
    const runners = Array.from({ length: Math.min(limit, items.length) }, runner);
    await Promise.all(runners);
  }

  function send(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(() => {});
    } catch (_) {
      return Promise.resolve();
    }
  }

  function progressMessage(text) {
    send({ type: 'S4E_PROGRESS', message: text });
  }

  async function runExtract(requestId) {
    if (busy) return;
    busy = true;
    try {
      const tp = pageType();
      const types = reportCompanyTypes(tp);
      const fullScope = pageFiltersAreDefault() && (tp === '-1' || tp === '');
      const labels = types.map(type => COMPANY_TYPE_LABELS[type] || `tipo ${type}`).join(' e ');
      progressMessage(`Lendo o relatório de empresas em atraso no S4E (${labels})...`);
      const reports = await Promise.all(types.map(async (type, index) => {
        const { query, periodStart, periodEnd } = buildParams(type);
        const url = `${location.origin}/SYS/Faturamento/RelatorioFaturamentoPorTipoModal.aspx?${query}`;
        const html = await fetchText(url, 90000);
        return { type, rows: parseReport(html, { onlyCompanies: true }), periodStart, periodEnd };
      }));
      const rows = [];
      const seen = new Set();
      reports.forEach(report => {
        report.rows.forEach(row => {
          const key = `${row.documento}|${row.competencia}|${row.vencimento}|${row.parcela}|${row.tipoParcela}|${row.valor.toFixed(2)}`;
          if (seen.has(key)) return;
          seen.add(key);
          row.tpEmpresa = report.type;
          rows.push(row);
        });
      });
      if (!rows.length) {
        throw new Error('O relatório não retornou títulos de empresas em atraso. Confirme o filtro no S4E (Coletivo Empresarial ou Coletivo por Adesão), clique em Buscar e importe de novo.');
      }
      if (rows.length > MAX_ROWS) {
        throw new Error(`O relatório tem ${rows.length} linhas, acima do limite de ${MAX_ROWS}. Reduza o período ou o filtro no S4E e importe em partes.`);
      }

      const documents = new Map();
      rows.forEach(row => {
        if (row.cdAssociado && !documents.has(row.cdAssociado)) documents.set(row.cdAssociado, row.documento);
      });
      const ids = Array.from(documents.keys());
      const targets = ids.slice(0, MAX_CLIENTS);
      let warning = '';
      if (targets.length < ids.length) {
        warning = `contatos lidos só para ${targets.length} de ${ids.length} empresas`;
        progressMessage(`O relatório tem ${ids.length} empresas; lendo os contatos das ${targets.length} primeiras.`);
      }
      const contacts = new Map();
      async function loadContacts(list, concurrency, label) {
        await mapLimit(list, concurrency, async id => {
          try {
            const documento = documents.get(id) || '';
            const url = CNPJ_RE.test(documento) ? companyFichaUrl(id) : associateFichaUrl(id);
            const ficha = await fetchText(url);
            contacts.set(id, parseContacts(ficha));
          } catch (_) {}
        }, done => progressMessage(`Buscando contatos: ${done} de ${list.length} ${label}...`));
      }
      if (targets.length) {
        progressMessage(`Lendo ${ids.length} ficha(s) de empresa no S4E para buscar e-mail e WhatsApp...`);
        await loadContacts(targets, 4, 'empresa(s)');
        // A ficha às vezes volta sem o bloco de contatos quando muitas são lidas
        // de uma vez; uma segunda passada mais lenta recupera esses cadastros.
        const empty = targets.filter(id => {
          const contact = contacts.get(id);
          return !contact || (!contact.emails.length && !contact.phones.length);
        });
        if (empty.length) {
          progressMessage(`Revisando ${empty.length} ficha(s) sem contato...`);
          await loadContacts(empty, 2, 'ficha(s) sem contato');
        }
      }

      rows.forEach(row => {
        const contact = contacts.get(row.cdAssociado) || { emails: [], phones: [] };
        row.emails = contact.emails;
        row.phones = contact.phones;
      });

      const total = Math.ceil(rows.length / BATCH_SIZE);
      for (let index = 0; index < total; index += 1) {
        const chunk = rows.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE);
        await send({
          type: 'S4E_EXTRACT_BATCH',
          requestId,
          index,
          total,
          rows: chunk,
        });
        progressMessage(`Enviando para o portal: lote ${index + 1} de ${total}...`);
      }
      await send({
        type: 'S4E_EXTRACT_RESULT',
        requestId,
        totalRows: rows.length,
        clients: ids.length,
        periodStart: reports[0] ? reports[0].periodStart : '',
        periodEnd: reports[0] ? reports[0].periodEnd : '',
        source: 's4e',
        scope: 'empresas',
        fullScope,
        warning,
      });
    } catch (error) {
      send({ type: 'S4E_EXTRACT_ERROR', requestId, message: error.message || 'A leitura do relatório falhou.' });
    } finally {
      busy = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return;
    if (message.type === 'S4E_PING') {
      if (!isReportPage()) return;
      sendResponse({ pong: true, hasReport: true, path: location.pathname });
      return;
    }
    if (message.type === 'S4E_EXTRACT') {
      if (!isReportPage()) return;
      if (busy) {
        sendResponse({ started: false, reason: 'busy' });
        return;
      }
      sendResponse({ started: true, requestId: message.requestId });
      runExtract(message.requestId);
    }
  });
})();
