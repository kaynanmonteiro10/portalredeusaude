/* Tela de Início — visão geral do dia: avisos, atalhos, mural e aniversários */
(() => {
  const state = { loaded: false, loading: false, birthdays: [], announcements: [], posts: [], updates: [], unread: 0, summary: null };
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const token = () => window.PortalAccess?.Access?.token || '';
  const api = (path, options) => window.PortalAccess.api(path, options);
  const user = () => window.PortalAccess?.Access?.user;
  const canSee = screen => {
    const access = window.PortalAccess;
    return typeof access?.canSee === 'function' ? access.canSee(screen) : true;
  };
  const mediaUrl = path => path ? `${window.PORTAL_API_BASE || ''}${path}${String(path).includes('?') ? '&' : '?'}t=${encodeURIComponent(token())}` : '';

  const NEWS_TONES = ['pink', 'amber', 'blue', 'teal'];
  // Ícones em SVG: traço fino, mesma família visual em toda a tela.
  const svg = (corpo, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"${extra} aria-hidden="true">${corpo}</svg>`;
  const ICONS = {
    tasks: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M8 10h8M8 14h5"/>'),
    mural: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M7.5 9h9M7.5 13h6"/><circle cx="16.5" cy="15.5" r="1.6" fill="currentColor" stroke="none"/>'),
    chat: svg('<path d="M20 12.5c0 3.6-3.6 6.5-8 6.5-1 0-2-.1-2.9-.4L5 20.5l1.2-3.2A6.2 6.2 0 0 1 4 12.5C4 8.9 7.6 6 12 6s8 2.9 8 6.5z"/><path d="M9 12h.01M12 12h.01M15 12h.01"/>'),
    cake: svg('<path d="M4 20.5h16M5.5 20.5v-6a2.5 2.5 0 0 1 2.5-2.5h8a2.5 2.5 0 0 1 2.5 2.5v6"/><path d="M5.5 16.5c1.6 1.4 3.2 1.4 4.8 0s3.2-1.4 4.8 0 3.2 1.4 3.4 0"/><path d="M12 12V9.5M12 6.5v.01"/>'),
    learn: svg('<path d="M12 4.5 3.5 8.5 12 12.5l8.5-4z"/><path d="M6.5 10.5v4.2c0 1.7 2.5 3.1 5.5 3.1s5.5-1.4 5.5-3.1v-4.2"/>'),
    report: svg('<path d="M5 19.5V6.5A2 2 0 0 1 7 4.5h7l5 5v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/><path d="M14 4.5v5h5"/><path d="M9 13h6M9 16.5h4"/>'),
    news: svg('<path d="M4 18.5 9 6l5 12.5"/><path d="M6 14.5h6"/><path d="M17 10.5c2.5 0 3.5 1.6 3.5 4s-1 4-3.5 4"/>'),
    bell: svg('<path d="M18 8.5a6 6 0 0 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5z"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/>'),
    arrow: svg('<path d="M5 12h13M13 6.5 18.5 12 13 17.5"/>'),
  };
  const NEWS_ICONS = { event: ICONS.report, birthday: ICONS.cake, notice: ICONS.news, congrats: ICONS.learn };
  const NEWS_LABELS = { event: 'Evento', birthday: 'Aniversariante', notice: 'Aviso', congrats: 'Parabéns' };
  const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

  function weekdayLong(iso) {
    const date = new Date(`${iso}T12:00:00`);
    const label = Number.isNaN(date.getTime()) ? '' : WEEKDAYS[date.getDay()];
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : '';
  }

  function timeLabel(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return 'agora';
    if (minutes < 60) return `há ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `há ${hours} h`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'ontem';
    if (days < 7) return `há ${days} dias`;
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function longDate(value) {
    const date = new Date(`${value}T12:00:00`);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
  }

  function avatarHtml(person, cls) {
    const photo = String(person?.photo || '');
    return photo
      ? `<span class="${cls}"><img src="${esc(photo)}" alt="${esc(person.name || '')}" loading="lazy"></span>`
      : `<span class="${cls}">${esc(initials(person?.name))}</span>`;
  }

  function hydrateMe() {
    const person = user();
    if (!person) return;
    document.getElementById('homePersonName').textContent = person.displayName || person.username || 'Você';
    const sector = person.sectorName || (person.sectors || []).map(item => item.name).filter(Boolean).join(', ');
    document.getElementById('homePersonSector').textContent = sector || (person.management ? 'Gestão' : 'Portal do Setor');
    const avatar = document.getElementById('homePersonAvatar');
    if (avatar) {
      const photo = String(person.photo || '');
      avatar.innerHTML = photo ? `<img src="${esc(photo)}" alt="${esc(person.displayName || '')}">` : esc(initials(person.displayName || person.username));
    }
    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
    const name = String(person.displayName || person.username || '').trim().split(/\s+/)[0];
    document.getElementById('homeGreeting').textContent = name ? `${greeting}, ${name}` : greeting;
    document.getElementById('homeDate').textContent = now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();
  }

  function currentAnnouncements() {
    const now = new Date();
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return state.announcements.filter(item => item.active !== false
      && !/^resumo da semana/i.test(String(item.title || ''))
      && (!item.date || item.date >= todayIso));
  }

  function renderHero() {
    const active = currentAnnouncements();
    const featured = [...active].sort((a, b) => {
      const weight = value => value.type === 'event' ? 0 : value.type === 'notice' ? 1 : 2;
      return weight(a) - weight(b) || String(b.date || '').localeCompare(String(a.date || ''));
    })[0];
    const kicker = document.getElementById('homeHeroKicker');
    const title = document.getElementById('homeHeroTitle');
    const text = document.getElementById('homeHeroText');
    const cta = document.getElementById('homeHeroCta');
    if (!featured) {
      kicker.textContent = 'REDE SAÚDE · GENTE QUE CUIDA';
      title.textContent = 'Gente que cuida, faz a diferença';
      text.textContent = 'Um time que cuida de pessoas também precisa de cuidado. Use o portal para acompanhar o que acontece no setor e celebrar cada conquista.';
      if (cta) cta.innerHTML = 'Ver mural <span aria-hidden="true">→</span>';
      return;
    }
    kicker.textContent = `REDE SAÚDE · ${String(NEWS_LABELS[featured.type] || 'Aviso').toUpperCase()}${featured.date ? ` · ${longDate(featured.date).toUpperCase()}` : ''}`;
    title.textContent = featured.title || 'Gente que cuida, faz a diferença';
    text.textContent = featured.description || 'Acompanhe as novidades do setor e fique por dentro de tudo que acontece no time.';
    if (cta) cta.innerHTML = 'Ver avisos <span aria-hidden="true">→</span>';
  }

  function renderNews() {
    const host = document.getElementById('homeNews');
    if (!host) return;
    const active = currentAnnouncements().slice(0, 3);
    host.innerHTML = active.length
      ? active.map((item, index) => {
        const tone = item.type === 'notice' ? 'amber' : item.type === 'event' ? 'blue' : NEWS_TONES[index % NEWS_TONES.length];
        return `<button type="button" class="home-news-card tone-${tone}" data-home-go="feedScreen">
          <span class="home-news-icon" aria-hidden="true">${NEWS_ICONS[item.type] || ICONS.news}</span>
          <span class="home-news-body">
            <span class="home-news-date">${esc(longDate(item.date) || 'Aviso do time')}</span>
            <strong>${esc(item.title)}</strong>
            ${item.description ? `<p>${esc(item.description)}</p>` : ''}
          </span>
          <span class="home-news-arrow" aria-hidden="true">›</span>
        </button>`;
      }).join('')
      : '<p class="home-news-empty">Nenhum aviso ativo agora. Publique uma novidade no mural quando quiser.</p>';
  }

  function openTasks() {
    const list = typeof window.scopedTasks === 'function' ? window.scopedTasks() : [];
    return list.filter(task => task.status !== 'done').length;
  }

  function quickItems() {
    const items = [];
    if (canSee('tasksScreen')) {
      const open = openTasks();
      items.push({ screen: 'tasksScreen', title: 'Demandas', sub: open ? `${open} em aberto` : 'Tudo em dia', icon: ICONS.tasks, tone: 'teal' });
    }
    if (canSee('feedScreen')) {
      items.push({ screen: 'feedScreen', title: 'Mural da Equipe', sub: state.unread ? `${state.unread} novidade${state.unread === 1 ? '' : 's'}` : 'Acompanhe o time', icon: ICONS.mural, tone: 'pink' });
    }
    if (canSee('chatScreen')) {
      items.push({ screen: 'chatScreen', title: 'Conversas', sub: 'Fale com a equipe', icon: ICONS.chat, tone: 'purple' });
    }
    if (canSee('birthdaysScreen')) {
      const month = new Date().getMonth() + 1;
      const count = state.birthdays.filter(item => Number(item.month) === month).length;
      items.push({ screen: 'birthdaysScreen', title: 'Aniversariantes', sub: count ? `${count} neste mês` : 'Veja as datas do time', icon: ICONS.cake, tone: 'amber' });
    }
    if (canSee('learningScreen')) {
      items.push({ screen: 'learningScreen', title: 'Treinamentos', sub: 'Trilhas do setor', icon: ICONS.learn, tone: 'green' });
    }
    if (canSee('reportsScreen')) {
      items.push({ screen: 'reportsScreen', title: 'Relatórios', sub: 'Acesse os relatórios do setor', icon: ICONS.report, tone: 'blue' });
    }
    return items.slice(0, 6);
  }

  function renderQuick() {
    const host = document.getElementById('homeQuick');
    if (!host) return;
    host.innerHTML = quickItems().map(item => `<button type="button" class="home-quick-btn home-quick-tone-${item.tone}" data-home-go="${esc(item.screen)}">
      <span class="home-quick-icon" aria-hidden="true">${item.icon}</span>
      <span class="home-quick-copy"><strong>${esc(item.title)}</strong><small>${esc(item.sub)}</small></span>
      <span class="home-quick-arrow" aria-hidden="true">${ICONS.arrow}</span>
    </button>`).join('');
  }

  function postThumb(post) {
    const image = (post.media || []).find(item => String(item.mime || '').startsWith('image/'));
    if (image) return `<span class="home-mural-thumb"><img src="${esc(mediaUrl(image.media))}" alt="${esc(image.name || '')}" loading="lazy"></span>`;
    const icone = post.kind === 'notice' ? ICONS.news : post.kind === 'event' ? ICONS.report : ICONS.mural;
    return `<span class="home-mural-thumb" aria-hidden="true">${icone}</span>`;
  }

  function renderMural() {
    const host = document.getElementById('homeMural');
    if (!host) return;
    let posts = state.posts.filter(post => post.kind !== 'digest').slice(0, 2);
    if (!posts.length) posts = state.posts.filter(post => post.kind === 'digest').slice(0, 1);
    host.innerHTML = posts.length ? posts.map(post => `<button type="button" class="home-mural-item" data-home-go="feedScreen">
      ${postThumb(post)}
      <span class="home-mural-copy">
        <strong>${esc(post.title || (post.kind === 'digest' ? 'Resumo da semana' : String(post.body || '').split('\n')[0].slice(0, 90)) || 'Nova publicação')}</strong>
        ${post.body ? `<p>${esc(post.body)}</p>` : ''}
        <span class="home-mural-foot"><span>${esc(post.author?.name || 'Equipe')} · ${esc(timeLabel(post.createdAt))}</span><span class="home-mural-stats"><span>♥ ${Number(post.likes) || 0}</span><span>💬 ${(post.comments || []).length}</span></span></span>
      </span>
    </button>`).join('') : '<p class="home-mural-empty">Nada por aqui ainda. Seja a primeira pessoa a publicar no mural.</p>';
  }

  function renderBirthdays() {
    const host = document.getElementById('homeBirthdays');
    if (!host) return;
    const list = [...state.birthdays]
      .sort((a, b) => (Number(a.daysUntil) || 0) - (Number(b.daysUntil) || 0))
      .slice(0, 3);
    host.innerHTML = list.length ? list.map(item => `<div class="home-bday">
      ${avatarHtml({ name: item.name, photo: item.photo || item.profilePhoto }, 'home-bday-avatar')}
      <span class="home-bday-copy"><strong>${esc(item.name)}</strong><small>${esc(item.sector || (item.kind === 'partner' ? 'Parceiro' : 'Equipe'))}</small></span>
      <span class="home-bday-when"><span>${esc(longDate(item.nextDate))}</span><small>${esc(weekdayLong(item.nextDate))}</small></span>
    </div>`).join('') : '<p class="home-bday-empty">Nenhuma data cadastrada ainda.</p>';
  }

  function renderUpdates() {
    const host = document.getElementById('homeUpdates');
    if (!host) return;
    const list = state.updates.slice(0, 3);
    host.innerHTML = list.length ? list.map((item, index) => `<div class="home-update">
      <span class="home-update-num">${index + 1}</span>
      <span class="home-update-copy"><strong>${esc(item.title)}</strong><small>${esc(timeLabel(item.createdAt))}</small></span>
    </div>`).join('') : '<p class="home-update-empty">Nenhuma novidade publicada ainda.</p>';
  }

  function renderBell() {
    const dot = document.getElementById('homeBellDot');
    if (dot) dot.classList.toggle('hidden', !(state.unread > 0));
  }

  function numberLabel(value) {
    return Number(value || 0).toLocaleString('pt-BR');
  }

  function renderAnniversary(summary) {
    const card = document.getElementById('homeAnniv');
    if (!card) return;
    if (!summary || !summary.days) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    document.getElementById('homeAnnivNumber').textContent = summary.months;
    document.getElementById('homeAnnivUnit').textContent = summary.months === 1 ? 'mês no ar' : 'meses no ar';
    document.getElementById('homeAnnivText').textContent = `Desde ${summary.sinceLabel}, há ${numberLabel(summary.days)} dias o Portal do Setor cresce junto com o time.`;
    document.getElementById('homeAnnivBadge').classList.toggle('hidden', !summary.anniversary);
    const stats = [
      { value: summary.demandsDone, label: 'demandas concluídas' },
      { value: summary.companies, label: 'empresas acompanhadas' },
      { value: summary.people, label: 'pessoas no time' },
      { value: summary.updates, label: 'novidades publicadas' },
    ];
    document.getElementById('homeAnnivStats').innerHTML = stats.map(item => `<div class="home-anniv-stat">
      <strong>${numberLabel(item.value)}</strong>
      <span>${esc(item.label)}</span>
    </div>`).join('');
  }

  function renderPublishShortcut() {
    const button = document.getElementById('homePublishUpdate');
    if (button) button.classList.toggle('hidden', !user()?.management);
  }

  async function loadHome() {
    if (!token() || state.loading) return;
    state.loading = true;
    try {
      const [announcements, birthdays, feed, updates, unread, summary] = await Promise.all([
        api('/api/announcements').catch(() => ({ announcements: [] })),
        api('/api/birthdays').catch(() => ({ birthdays: [] })),
        api('/api/feed?limit=8').catch(() => ({ posts: [] })),
        api('/api/system-updates').catch(() => ({ updates: [] })),
        api('/api/feed/unread').catch(() => ({ unread: 0 })),
        api('/api/portal-summary').catch(() => ({ summary: null })),
      ]);
      state.announcements = announcements.announcements || [];
      state.birthdays = birthdays.birthdays || [];
      state.posts = feed.posts || [];
      state.updates = updates.updates || [];
      state.unread = Number(unread.unread) || 0;
      state.summary = summary.summary || null;
      state.loaded = true;
      renderHero();
      renderAnniversary(state.summary);
      renderNews();
      renderQuick();
      renderMural();
      renderBirthdays();
      renderUpdates();
      renderBell();
      renderPublishShortcut();
    } finally {
      state.loading = false;
    }
  }

  function bind() {
    document.getElementById('homeScreen')?.addEventListener('click', event => {
      const target = event.target.closest('[data-home-go]');
      if (!target) return;
      const screen = target.dataset.homeGo;
      if (!screen) return;
      window.openScreen?.(screen);
    });
    document.getElementById('homeBell')?.addEventListener('click', () => window.openScreen?.('feedScreen'));
    document.getElementById('homePerson')?.addEventListener('click', () => window.openProfile?.());
    document.getElementById('homeHeroCta')?.addEventListener('click', () => window.openScreen?.('feedScreen'));
  }

  function enterHomeScreen() {
    document.body.classList.add('home-active');
    hydrateMe();
    loadHome();
  }

  function leaveHomeScreen() {
    document.body.classList.remove('home-active');
  }

  window.enterHomeScreen = enterHomeScreen;
  window.leaveHomeScreen = leaveHomeScreen;

  bind();
  const wait = setInterval(() => {
    if (!user()?.id) return;
    clearInterval(wait);
    hydrateMe();
    renderQuick();
    renderPublishShortcut();
    loadHome();
  }, 600);
  setTimeout(() => clearInterval(wait), 30000);
})();
