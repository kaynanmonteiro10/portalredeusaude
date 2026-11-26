(() => {
  'use strict';

  const state = { active: false, loading: false, data: null };
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const minutes = value => Math.max(0, Number(value) || 0);
  const hours = value => {
    const total = Math.round(minutes(value));
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m ? `${h}h ${String(m).padStart(2, '0')}min` : `${h}h`;
  };
  const dateLabel = value => value ? new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR') : '—';
  const timeLabel = value => value ? new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
  const eventLabels = { login: 'Entrada no portal', logout: 'Saída do portal', lunch_start: 'Início do almoço', lunch_end: 'Volta do almoço', break_start: 'Início do intervalo', break_end: 'Volta do intervalo' };
  const weekdayLabels = ['Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado', 'Domingo'];

  function monday(value = new Date()) {
    const date = new Date(value.getFullYear(), value.getMonth(), value.getDate());
    const day = date.getDay() || 7;
    date.setDate(date.getDate() - day + 1);
    return date;
  }

  function localISO(value) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }

  function ownPerson() {
    const userId = window.PortalAccess?.Access?.user?.id;
    const match = state.data?.people?.find(person => person.user_id === userId);
    return match || (!state.data?.admin ? state.data?.people?.[0] : null) || null;
  }

  function renderPolicy() {
    const data = state.data;
    const box = $('pontoPolicy');
    if (!data || !box) return;
    const current = data.policy;
    box.innerHTML = `<div><strong>Limite vigente: ${esc(current.label)}</strong><br><span>Aplicado desde ${dateLabel(current.effective_from)}. A escala prevista pode ser menor que o limite.</span></div>${data.nextPolicy ? `<div><strong>Mudança em ${dateLabel(data.nextPolicy.effective_from)}</strong><br><span>${esc(data.nextPolicy.label)}</span></div>` : ''}`;
  }

  function renderSummary() {
    const data = state.data;
    const own = ownPerson();
    if (!data) return;
    const totalWorked = data.people.reduce((sum, person) => sum + minutes(person.workedMinutes), 0);
    const totalOvertime = data.people.reduce((sum, person) => sum + minutes(person.overtimeMinutes), 0);
    const pending = data.people.reduce((sum, person) => sum + person.days.filter(day => day.open).length, 0);
    const limit = own ? data.policy.weekly_minutes : data.policy.weekly_minutes * Math.max(1, data.people.length);
    const items = [
      { label: data.admin ? 'Apurado da equipe' : 'Apurado na semana', value: hours(data.admin ? totalWorked : own?.workedMinutes), detail: `${dateLabel(data.range.start)} a ${dateLabel(data.range.end)}` },
      { label: 'Limite vigente', value: hours(data.admin ? limit : data.policy.weekly_minutes), detail: data.policy.label },
      { label: 'Hora extra indicada', value: hours(data.admin ? totalOvertime : own?.overtimeMinutes), detail: 'Exige conferência da gestão', tone: totalOvertime ? 'danger' : '' },
      { label: 'Saídas pendentes', value: String(pending), detail: 'Login sem logout no período', tone: pending ? 'warn' : '' },
    ];
    $('pontoKpis').innerHTML = items.map(item => `<article class="ponto-kpi ${item.tone || ''}"><span>${esc(item.label)}</span><strong>${esc(item.value)}</strong><small>${esc(item.detail)}</small></article>`).join('');
    const ownOver = minutes(own?.overtimeMinutes);
    const remaining = minutes(own?.remainingMinutes);
    const alert = $('pontoAlert');
    if (!alert) return;
    if (ownOver) {
      alert.className = 'ponto-alert is-danger';
      alert.textContent = `A jornada apurada ultrapassou o limite em ${hours(ownOver)}. O sistema marcou o período para conferência como possível hora extra.`;
    } else if (own && remaining <= 120) {
      alert.className = 'ponto-alert';
      alert.textContent = `Atenção: restam ${hours(remaining)} até o limite semanal. Permanecer além disso será indicado como possível hora extra.`;
    } else alert.className = 'ponto-alert hidden';
  }

  function renderToday() {
    const own = ownPerson();
    const box = $('pontoTimeline');
    const status = $('pontoLiveStatus');
    if (!box || !status) return;
    const today = own?.days?.find(day => day.date === state.data.today);
    const events = today?.events || [];
    if (!own) {
      status.textContent = 'Sem perfil vinculado';
      status.className = 'ponto-status warning';
      box.innerHTML = '<div class="ponto-empty">Seu usuário ainda não foi vinculado a uma pessoa da escala. A administração pode fazer essa conferência.</div>';
      $('pontoActions').querySelectorAll('button').forEach(button => { button.disabled = true; });
      return;
    }
    status.textContent = today?.open ? 'Jornada em andamento' : events.length ? 'Saída registrada' : 'Aguardando acesso';
    status.className = `ponto-status ${today?.open ? '' : 'warning'}`;
    box.innerHTML = events.length ? events.map(event => `<div class="ponto-event"><strong>${esc(eventLabels[event.type] || event.type)}</strong><span>${timeLabel(event.at)}</span></div>`).join('') : '<div class="ponto-empty">O primeiro login do dia aparecerá aqui.</div>';
    const lastType = events.at(-1)?.type || '';
    const openLunch = lastType === 'lunch_start';
    const openBreak = lastType === 'break_start';
    $('pontoActions').querySelectorAll('[data-point-event]').forEach(button => {
      const type = button.dataset.pointEvent;
      if (type === 'lunch_start') button.disabled = openLunch || openBreak;
      else if (type === 'lunch_end') button.disabled = !openLunch;
      else if (type === 'break_start') button.disabled = openLunch || openBreak;
      else if (type === 'break_end') button.disabled = !openBreak;
    });
  }

  function renderPeople() {
    const data = state.data;
    const box = $('pontoPeople');
    if (!data || !box) return;
    if (!data.people.length) {
      box.innerHTML = '<div class="ponto-empty">Nenhuma pessoa vinculada foi encontrada.</div>';
      return;
    }
    box.innerHTML = data.people.map(person => {
      const limit = minutes(data.policy.weekly_minutes);
      const worked = minutes(person.workedMinutes);
      const percent = Math.min(100, limit ? worked / limit * 100 : 0);
      return `<article class="ponto-person ${person.overtimeMinutes ? 'is-overtime' : ''}">
        <div class="ponto-person-head"><strong>${esc(person.name)}</strong><span>${person.user_id ? esc(person.team) : 'Sem acesso vinculado'}</span></div>
        <div class="ponto-person-hours"><strong>${hours(worked)}</strong><span>de ${hours(limit)}</span></div>
        <div class="ponto-progress"><i style="width:${percent.toFixed(1)}%"></i></div>
        <div class="ponto-person-meta"><span>Planejado: ${hours(person.plannedMinutes)}</span><span>${person.overtimeMinutes ? `Extra: ${hours(person.overtimeMinutes)}` : `Restam: ${hours(person.remainingMinutes)}`}</span></div>
      </article>`;
    }).join('');
  }

  function scheduleCell(row) {
    if (!row?.start_time) return '<span class="ponto-day-off">Folga</span>';
    const lunch = row.lunch_start && row.lunch_end ? `<small>Almoço ${esc(row.lunch_start)}–${esc(row.lunch_end)}</small>` : '<small>Sem almoço previsto</small>';
    return `<strong>${esc(row.start_time)}–${esc(row.end_time)}</strong>${lunch}<small>${hours(row.scheduled_minutes)}</small>`;
  }

  function renderSchedules() {
    const body = $('pontoSchedules');
    if (!body || !state.data) return;
    body.innerHTML = state.data.people.map(person => {
      const days = Object.fromEntries(person.schedule.map(row => [row.weekday, row]));
      return `<tr><td>${esc(person.name)}</td><td>${esc(person.team)}</td>${[0, 1, 2, 3, 4, 5].map(day => `<td>${scheduleCell(days[day])}</td>`).join('')}</tr>`;
    }).join('') || '<tr><td colspan="8">Sem escala disponível.</td></tr>';
  }

  function renderVacations() {
    const box = $('pontoVacations');
    if (!box || !state.data) return;
    box.innerHTML = state.data.vacations.map(item => {
      const start = new Date(`${item.start_date}T12:00:00`);
      const expected = new Date(start); expected.setDate(expected.getDate() + Number(item.days || 0));
      const mismatch = localISO(expected) !== item.return_date;
      return `<article class="ponto-vacation"><strong>${esc(item.name)}</strong><div class="ponto-vacation-dates">${dateLabel(item.start_date)} a ${dateLabel(item.return_date)} · ${esc(item.days)} dias informados</div>${item.cover ? `<p>Cobertura: ${esc(item.cover)}</p>` : '<p class="review">Cobertura ainda não informada.</p>'}${item.note ? `<p>${esc(item.note)}</p>` : ''}${mismatch ? '<p class="review">Datas e quantidade de dias não fecham pelo calendário; revisar antes de confirmar.</p>' : ''}</article>`;
    }).join('') || '<div class="ponto-empty">Nenhuma férias prevista neste cadastro.</div>';
  }

  function renderRotations() {
    const box = $('pontoRotations');
    if (!box || !state.data) return;
    box.innerHTML = (state.data.rotations || []).map(item => `<article class="ponto-rotation"><h4>${esc(item.title)}</h4><p>${esc(item.description)}</p><ul>${item.items.map(row => `<li><strong>${esc(row.name)}</strong><span>${esc(row.value)}</span></li>`).join('')}</ul></article>`).join('');
  }

  function render() {
    renderPolicy(); renderSummary(); renderToday(); renderPeople(); renderSchedules(); renderVacations(); renderRotations();
    $('pontoManage')?.classList.toggle('hidden', !state.data?.admin);
    const refresh = $('pontoRefresh');
    if (refresh) { refresh.disabled = state.loading; refresh.textContent = state.loading ? 'Atualizando…' : 'Atualizar'; }
  }

  function editMinutes(start, lunchStart, lunchEnd, end) {
    const toMinutes = value => {
      const [h, m] = String(value || '').split(':').map(Number);
      return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 0;
    };
    let total = toMinutes(end) - toMinutes(start);
    if (lunchStart && lunchEnd) total -= toMinutes(lunchEnd) - toMinutes(lunchStart);
    return Math.max(0, total);
  }

  function updateScheduleTotal() {
    let total = 0;
    $('pontoScheduleDays')?.querySelectorAll('tr').forEach(row => {
      const enabled = row.querySelector('[data-field="enabled"]').checked;
      row.classList.toggle('is-off', !enabled);
      const value = enabled ? editMinutes(
        row.querySelector('[data-field="start"]').value,
        row.querySelector('[data-field="lunchStart"]').value,
        row.querySelector('[data-field="lunchEnd"]').value,
        row.querySelector('[data-field="end"]').value,
      ) : 0;
      total += value;
      row.querySelector('[data-day-total]').textContent = hours(value);
    });
    $('pontoScheduleTotal').textContent = hours(total);
    const warning = $('pontoScheduleWarning');
    const limit = minutes(state.data?.policy?.weekly_minutes);
    if (total > limit) {
      warning.textContent = `Atenção: ${hours(total - limit)} acima do limite vigente de ${hours(limit)}. O excedente será indicado como possível hora extra.`;
      warning.className = 'warning';
    } else {
      warning.textContent = `${hours(Math.max(0, limit - total))} abaixo do limite vigente de ${hours(limit)}.`;
      warning.className = '';
    }
    return total;
  }

  function fillScheduleEditor(employeeId) {
    const person = state.data?.people?.find(item => item.id === employeeId) || state.data?.people?.[0];
    if (!person) return;
    $('pontoSchedulePerson').value = person.id;
    $('pontoScheduleUser').value = person.user_id || '';
    $('pontoScheduleTeam').value = person.team || '';
    const schedule = Object.fromEntries((person.schedule || []).map(row => [row.weekday, row]));
    $('pontoScheduleDays').innerHTML = weekdayLabels.map((label, weekday) => {
      const row = schedule[weekday] || {};
      const enabled = Boolean(row.start_time && row.end_time);
      return `<tr data-weekday="${weekday}" class="${enabled ? '' : 'is-off'}">
        <td><input type="checkbox" data-field="enabled" ${enabled ? 'checked' : ''} aria-label="Trabalha na ${esc(label)}"></td>
        <td><strong>${esc(label)}</strong></td>
        <td><input type="time" data-field="start" value="${esc(row.start_time || '08:00')}"></td>
        <td><input type="time" data-field="lunchStart" value="${esc(row.lunch_start || '')}"></td>
        <td><input type="time" data-field="lunchEnd" value="${esc(row.lunch_end || '')}"></td>
        <td><input type="time" data-field="end" value="${esc(row.end_time || '18:00')}"></td>
        <td data-day-total>0h</td>
      </tr>`;
    }).join('');
    $('pontoScheduleError').classList.add('hidden');
    updateScheduleTotal();
  }

  function openScheduleEditor(employeeId = '') {
    if (!state.data?.admin) return;
    const people = state.data.people || [];
    $('pontoSchedulePerson').innerHTML = people.map(person => `<option value="${esc(person.id)}">${esc(person.name)}</option>`).join('');
    $('pontoScheduleUser').innerHTML = '<option value="">Sem usuário vinculado</option>' + (state.data.portalUsers || []).map(user => `<option value="${esc(user.id)}">${esc(user.displayName)} (${esc(user.username)})</option>`).join('');
    fillScheduleEditor(employeeId || people[0]?.id);
    $('pontoScheduleDialog').showModal();
  }

  async function saveSchedule(event) {
    event.preventDefault();
    const employeeId = $('pontoSchedulePerson').value;
    const schedule = [...$('pontoScheduleDays').querySelectorAll('tr')].map(row => ({
      enabled: row.querySelector('[data-field="enabled"]').checked,
      start: row.querySelector('[data-field="start"]').value,
      lunchStart: row.querySelector('[data-field="lunchStart"]').value,
      lunchEnd: row.querySelector('[data-field="lunchEnd"]').value,
      end: row.querySelector('[data-field="end"]').value,
    }));
    const save = $('pontoScheduleSave');
    const errorBox = $('pontoScheduleError');
    save.disabled = true; save.textContent = 'Salvando…'; errorBox.classList.add('hidden');
    try {
      const response = await window.PortalAccess.api(`/api/ponto/pessoas/${encodeURIComponent(employeeId)}`, {
        method: 'PUT',
        body: JSON.stringify({ userId: $('pontoScheduleUser').value, team: $('pontoScheduleTeam').value, schedule }),
      });
      state.data = response.data;
      $('pontoScheduleDialog').close();
      render();
      if (response.saved?.warning) {
        const alert = $('pontoAlert'); alert.className = 'ponto-alert'; alert.textContent = response.saved.warning;
      }
    } catch (error) {
      errorBox.textContent = error.message || 'Não foi possível salvar os horários.';
      errorBox.classList.remove('hidden');
    } finally {
      save.disabled = false; save.textContent = 'Salvar horários';
    }
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    render();
    try {
      const query = new URLSearchParams();
      if ($('pontoStart')?.value) query.set('start', $('pontoStart').value);
      if ($('pontoEnd')?.value) query.set('end', $('pontoEnd').value);
      state.data = await window.PortalAccess.api(`/api/ponto${query.size ? `?${query}` : ''}`);
      if (!$('pontoStart').value) $('pontoStart').value = state.data.range.start;
      if (!$('pontoEnd').value) $('pontoEnd').value = state.data.range.end;
    } catch (error) {
      const alert = $('pontoAlert');
      alert.className = 'ponto-alert is-danger';
      alert.textContent = error.message || 'Não foi possível carregar o ponto eletrônico.';
    } finally {
      state.loading = false;
      render();
    }
  }

  async function record(type) {
    if (state.loading) return;
    state.loading = true;
    $('pontoActions').querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      state.data = await window.PortalAccess.api('/api/ponto/evento', { method: 'POST', body: JSON.stringify({ type }) });
    } catch (error) {
      const alert = $('pontoAlert');
      alert.className = 'ponto-alert is-danger';
      alert.textContent = error.message || 'Não foi possível registrar o intervalo.';
    } finally {
      state.loading = false;
      $('pontoActions').querySelectorAll('button').forEach(button => { button.disabled = false; });
      render();
    }
  }

  async function download() {
    const query = new URLSearchParams();
    if ($('pontoStart').value) query.set('start', $('pontoStart').value);
    if ($('pontoEnd').value) query.set('end', $('pontoEnd').value);
    const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/ponto/exportar?${query}`, { headers: window.PortalAccess.authHeaders() });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Não foi possível exportar o relatório.');
    }
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || 'ponto-eletronico.xlsx';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function bind() {
    $('pontoRefresh')?.addEventListener('click', load);
    $('pontoApply')?.addEventListener('click', load);
    $('pontoExport')?.addEventListener('click', () => download().catch(error => {
      const alert = $('pontoAlert'); alert.className = 'ponto-alert is-danger'; alert.textContent = error.message;
    }));
    $('pontoManage')?.addEventListener('click', () => openScheduleEditor());
    $('pontoScheduleClose')?.addEventListener('click', () => $('pontoScheduleDialog').close());
    $('pontoScheduleCancel')?.addEventListener('click', () => $('pontoScheduleDialog').close());
    $('pontoSchedulePerson')?.addEventListener('change', event => fillScheduleEditor(event.target.value));
    $('pontoScheduleDays')?.addEventListener('input', updateScheduleTotal);
    $('pontoScheduleForm')?.addEventListener('submit', saveSchedule);
    $('pontoActions')?.addEventListener('click', event => {
      const button = event.target.closest('[data-point-event]');
      if (button) void record(button.dataset.pointEvent);
    });
  }

  window.enterPontoScreen = () => { state.active = true; void load(); };
  window.leavePontoScreen = () => { state.active = false; };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true }); else bind();
})();
