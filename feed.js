/* Mural da Equipe — publicações, fotos, curtidas e comentários. */
(() => {
  const state = { posts: [], filter: 'all', hasMore: false, loading: false, visible: false, uploading: 0, staged: [], userKey: '', badgeTimer: null, started: false, notices: [], updates: [], announcements: [], updatesAll: false, announcementsAll: false, replyTo: null, moderationId: '' };
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const token = () => window.PortalAccess?.Access?.token || '';
  const api = (path, options) => window.PortalAccess.api(path, options);
  const mediaUrl = path => path ? `${window.PORTAL_API_BASE || ''}${path}${String(path).includes('?') ? '&' : '?'}t=${encodeURIComponent(token())}` : '';
  const user = () => window.PortalAccess?.Access?.user;
  const isManager = () => { const person = user(); return Boolean(person && (person.role === 'admin' || person.management)); };
  const findPost = id => state.posts.find(post => post.id === id);
  const toast = (message, tone = 'info') => window.showToast?.(message, tone);

  function sizeLabel(size) {
    const value = Number(size) || 0;
    if (!value) return '';
    return value >= 1048576 ? `${(value / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.ceil(value / 1024))} KB`;
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
  }

  function avatarHtml(person, cls = 'feed-avatar') {
    const photo = String(person?.photo || '');
    const name = person?.name || '';
    return `<span class="${cls}">${photo ? `<img src="${esc(photo)}" alt="${esc(name)}" loading="lazy">` : esc(initials(name))}</span>`;
  }

  function fillAvatar(element, person) {
    if (!element) return;
    const photo = String(person?.photo || '');
    element.innerHTML = photo ? `<img src="${esc(photo)}" alt="${esc(person.name || '')}">` : esc(initials(person?.name));
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

  function timeDetail(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const clock = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const startOfDay = value => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
    const diff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
    if (diff === 0) return `Hoje às ${clock}`;
    if (diff === 1) return `Ontem às ${clock}`;
    return `${date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${clock}`;
  }

  function relativeUpper(iso) {
    const text = timeLabel(iso);
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  }

  function mediaHtml(items) {
    if (!items.length) return '';
    return `<div class="feed-media count-${Math.min(items.length, 4)}">${items.map(item => {
      const url = mediaUrl(item.media);
      const name = item.name || 'arquivo';
      const mime = String(item.mime || '');
      if (mime.startsWith('image/')) {
        return `<button type="button" class="feed-media-item" data-feed-image="${esc(url)}" data-feed-image-name="${esc(name)}" title="Ampliar ${esc(name)}"><img src="${esc(url)}" alt="${esc(name)}" loading="lazy"></button>`;
      }
      if (mime.startsWith('video/')) {
        return `<video class="feed-media-item" controls preload="metadata" src="${esc(url)}"></video>`;
      }
      return `<a class="feed-media-file" href="${esc(url)}" download="${esc(name)}" target="_blank" rel="noopener">📎 <strong>${esc(name)}</strong><small>${esc(sizeLabel(item.size))}</small></a>`;
    }).join('')}</div>`;
  }

  function badgeFor(post) {
    if (post.kind === 'digest') return '<span class="feed-badge digest">Resumo da semana</span>';
    if (post.kind === 'notice') return '<span class="feed-badge notice">Aviso</span>';
    if (post.kind === 'event') return '<span class="feed-badge event">Evento</span>';
    return '';
  }

  function commentHtml(comment, isReply = false) {
    return `<div class="feed-comment${isReply ? ' is-reply' : ''}" data-feed-comment-id="${esc(comment.id)}">${isReply ? '<span class="feed-reply-mark" aria-hidden="true">↳</span>' : ''}${avatarHtml(comment.author, 'feed-avatar small')}<div class="feed-comment-main"><p><strong>${esc(comment.author.name)}</strong>${esc(comment.body)}</p><small>${esc(timeLabel(comment.createdAt))} · <button type="button" class="feed-reply" data-feed-reply="${esc(comment.id)}" data-feed-reply-name="${esc(comment.author.name)}">Responder</button></small></div>${comment.canDelete ? `<button type="button" class="feed-comment-del" data-feed-comment-delete="${esc(comment.id)}" title="Excluir comentário">×</button>` : ''}</div>`;
  }

  function commentsMarkup(post) {
    const all = post.comments || [];
    const tops = all.filter(comment => !comment.parentId);
    const repliesOf = id => all.filter(comment => comment.parentId === id);
    return tops.map(comment => {
      const replies = repliesOf(comment.id);
      return commentHtml(comment) + (replies.length
        ? `<div class="feed-replies" data-feed-replies="${esc(comment.id)}">${replies.map(reply => commentHtml(reply, true)).join('')}</div>`
        : '');
    }).join('');
  }

  function replyChipHtml() {
    if (!state.replyTo) return '';
    return `<span class="feed-reply-chip">Respondendo a <strong>${esc(state.replyTo.name)}</strong><button type="button" data-feed-reply-cancel aria-label="Cancelar resposta">×</button></span>`;
  }

  function likeInner(post) {
    const likes = Number(post.likes) || 0;
    return `<span>♥</span><b>${likes}</b> <em>${post.liked ? 'Curtido' : 'Curtir'}</em>`;
  }

  function commentInner(post) {
    return `<span>💬</span>${post.comments.length ? `<b>${post.comments.length}</b>` : ''} <em>Comentar</em>`;
  }

  function likersText(post) {
    const names = (post.likers || []).map(person => String(person?.name || '').trim()).filter(Boolean);
    if (!names.length) return '';
    const shown = names.slice(0, 4);
    const rest = names.length - shown.length;
    if (rest > 0) return `${shown.join(', ')} e mais ${rest}`;
    if (shown.length === 1) return shown[0];
    return `${shown.slice(0, -1).join(', ')} e ${shown[shown.length - 1]}`;
  }

  function likersMarkup(post) {
    const text = likersText(post);
    return `<p class="feed-likers${text ? '' : ' hidden'}" data-feed-likers="${esc(post.id)}">${text ? `Curtido por ${esc(text)}` : ''}</p>`;
  }

  function postHtml(post) {
    const stats = post.kind === 'digest' && post.meta?.stats
      ? `<div class="feed-stat-row">${post.meta.stats.map(item => `<span class="feed-stat"><strong>${esc(item.value)}</strong>${esc(item.label)}</span>`).join('')}</div>`
      : '';
    const mine = post.author.id && post.author.id === user()?.id;
    const moderation = post.canDelete && isManager() && !mine && post.kind !== 'digest';
    const meta = post.kind === 'digest'
      ? 'Gerado automaticamente'
      : `${esc(timeDetail(post.createdAt))}${post.author.sector ? ` · ${esc(post.author.sector)}` : ''}`;
    return `<article class="feed-post" data-feed-post="${esc(post.id)}">
      <header class="feed-post-head">
        ${avatarHtml(post.author)}
        <div class="feed-post-who"><strong>${esc(post.author.name)}</strong><small>${meta}</small></div>
        ${badgeFor(post)}
        ${post.canDelete ? `<button class="feed-post-menu${moderation ? ' is-moderate' : ''}" type="button" data-feed-delete="${esc(post.id)}" title="${moderation ? 'Remover publicação e avisar o autor' : 'Excluir publicação'}" aria-label="${moderation ? 'Remover publicação e avisar o autor' : 'Excluir publicação'}">${moderation ? '⚠' : '…'}</button>` : ''}
      </header>
      ${post.title ? `<h3 class="feed-post-title">${esc(post.title)}</h3>` : ''}
      ${post.body ? `<p class="feed-post-body">${esc(post.body).replace(/\n/g, '<br>')}</p>` : ''}
      ${stats}
      ${mediaHtml(post.media || [])}
      <footer class="feed-actions">
        <button type="button" class="feed-action${post.liked ? ' is-liked' : ''}" data-feed-like="${esc(post.id)}" aria-pressed="${post.liked ? 'true' : 'false'}" title="${post.liked ? 'Descurtir' : 'Curtir'}" aria-label="${post.liked ? 'Descurtir' : 'Curtir'}">${likeInner(post)}</button>
        <button type="button" class="feed-action" data-feed-comments="${esc(post.id)}">${commentInner(post)}</button>
      </footer>
      ${likersMarkup(post)}
      <div class="feed-comments${post.comments.length ? '' : ' hidden'}" data-feed-comment-box="${esc(post.id)}">
        <div class="feed-comment-list" data-feed-comment-list="${esc(post.id)}">${commentsMarkup(post)}</div>
        <form class="feed-comment-form" data-feed-comment-form="${esc(post.id)}">
          <div class="feed-reply-slot" data-feed-reply-slot="${esc(post.id)}">${state.replyTo && state.replyTo.postId === post.id ? replyChipHtml() : ''}</div>
          ${avatarHtml(user(), 'feed-avatar small')}
          <input type="text" maxlength="2000" placeholder="Escreva um comentário..." aria-label="Comentário">
          <button class="button button-secondary" type="submit">Enviar</button>
        </form>
      </div>
    </article>`;
  }

  function visiblePosts() {
    if (state.filter === 'media') return state.posts.filter(post => (post.media || []).length > 0);
    if (state.filter === 'notice') return state.posts.filter(post => post.kind !== 'post');
    return state.posts;
  }

  function render() {
    const host = document.getElementById('feedPosts');
    const empty = document.getElementById('feedEmpty');
    const more = document.getElementById('feedMore');
    if (!host) return;
    const posts = visiblePosts();
    host.innerHTML = posts.map(postHtml).join('');
    if (empty) {
      empty.classList.toggle('hidden', posts.length > 0);
      empty.textContent = state.posts.length
        ? 'Nenhuma publicação neste filtro.'
        : 'Nenhuma publicação ainda. Comece contando uma novidade para a equipe.';
    }
    if (more) more.classList.toggle('hidden', !state.hasMore);
    renderDigest();
  }

  function digestTone(label) {
    const text = String(label || '').toLowerCase();
    if (text.includes('conclu')) return { tone: 'green', icon: '✓' };
    if (text.includes('demanda')) return { tone: 'blue', icon: '▤' };
    if (text.includes('contrato')) return { tone: 'purple', icon: '❑' };
    if (text.includes('publica') || text.includes('post')) return { tone: 'teal', icon: '◍' };
    return { tone: 'slate', icon: '·' };
  }

  function renderDigest() {
    const host = document.getElementById('feedDigest');
    if (!host) return;
    const digest = state.posts.find(post => post.kind === 'digest');
    if (!digest) {
      host.innerHTML = '<p class="panel-help">Na primeira abertura de cada semana, o portal publica aqui o que foi feito.</p>';
      return;
    }
    const stats = digest.meta?.stats || [];
    host.innerHTML = `${stats.length ? `<div class="feed-digest-grid">${stats.map(item => {
      const meta = digestTone(item.label);
      return `<div class="feed-digest-stat tone-${meta.tone}"><span class="feed-digest-icon" aria-hidden="true">${meta.icon}</span><div><strong>${esc(item.value)}</strong><small>${esc(item.label)}</small></div></div>`;
    }).join('')}</div>` : ''}
      <p class="feed-digest-date">Publicado em ${esc(new Date(digest.createdAt).toLocaleDateString('pt-BR'))}</p>`;
  }

  function renderNotices() {
    const card = document.getElementById('feedNoticesCard');
    const host = document.getElementById('feedNotices');
    const badge = document.getElementById('feedNoticesBadge');
    const readButton = document.getElementById('feedNoticesRead');
    if (!card || !host) return;
    const unread = state.notices.filter(item => !item.seen).length;
    card.classList.toggle('hidden', state.notices.length === 0);
    if (badge) {
      badge.textContent = String(unread);
      badge.classList.toggle('hidden', unread === 0);
    }
    if (readButton) readButton.classList.toggle('hidden', unread === 0);
    document.getElementById('feedBellDot')?.classList.toggle('hidden', unread === 0);
    host.innerHTML = state.notices.map(item => `<div class="feed-notice${item.seen ? '' : ' is-unread'}">
      <span class="feed-notice-icon">⚠</span>
      <div><strong>${esc(item.postTitle || 'Publicação removida')}</strong><p>${esc(item.reason)}</p><small>${esc(timeLabel(item.createdAt))}</small></div>
    </div>`).join('');
  }

  async function loadNotices() {
    if (!token()) return;
    try {
      const data = await api('/api/feed/notices');
      state.notices = data.notices || [];
      renderNotices();
    } catch {}
  }

  async function markNoticesRead() {
    if (!state.notices.some(item => !item.seen)) return;
    try {
      await api('/api/feed/notices/read', { method: 'POST', body: '{}' });
      state.notices = state.notices.map(item => ({ ...item, seen: true }));
      renderNotices();
    } catch {}
  }

  function renderUpdates() {
    const host = document.getElementById('feedUpdates');
    const more = document.getElementById('feedUpdatesMore');
    if (!host) return;
    const list = state.updatesAll ? state.updates : state.updates.slice(0, 3);
    host.innerHTML = list.length ? list.map((item, index) => `<div class="feed-update">
      <span class="feed-update-num">${index + 1}</span>
      <div class="feed-update-text"><strong>${esc(item.title)}</strong>${item.body ? `<p>${esc(item.body)}</p>` : ''}<small>${esc(relativeUpper(item.createdAt))}</small></div>
      ${isManager() ? `<button type="button" class="feed-update-del" data-feed-update-delete="${esc(item.id)}" title="Remover novidade" aria-label="Remover novidade">×</button>` : ''}
    </div>`).join('') : '<p class="feed-update-empty">Nenhuma novidade publicada ainda.</p>';
    if (more) {
      const canExpand = state.updates.length > 3;
      more.classList.toggle('hidden', !canExpand);
      more.textContent = state.updatesAll ? 'Ver menos' : 'Ver todas';
    }
  }

  async function loadUpdates() {
    if (!token()) return;
    document.getElementById('feedUpdateForm')?.classList.add('hidden');
    document.getElementById('feedUpdateToggle')?.classList.toggle('hidden', !isManager());
    try {
      const data = await api('/api/system-updates');
      state.updates = data.updates || [];
      renderUpdates();
    } catch {
      const host = document.getElementById('feedUpdates');
      if (host) host.innerHTML = '<p class="feed-update-empty">Não foi possível carregar as novidades.</p>';
    }
  }

  function renderAnnouncements() {
    const host = document.getElementById('feedAnnouncements');
    const more = document.getElementById('feedAnnouncementsMore');
    if (!host) return;
    const active = state.announcements;
    const visible = state.announcementsAll ? active : active.slice(0, 2);
    const icons = { event: '▦', birthday: '✦', notice: '◉', congrats: '★' };
    const labels = { event: 'Evento', birthday: 'Aniversariante', notice: 'Aviso', congrats: 'Parabéns' };
    host.innerHTML = visible.length
      ? visible.map(item => {
        const stamp = item.createdAt ? timeLabel(item.createdAt) : '';
        return `<div class="feed-ann tone-${esc(item.type || 'notice')}">
          <span class="feed-ann-icon" aria-hidden="true">${icons[item.type] || '◉'}</span>
          <div><strong>${esc(item.title)}</strong>${item.description ? `<p>${esc(item.description)}</p>` : ''}<small>${labels[item.type] || 'Aviso'}${item.date ? ` · ${fmtDate(item.date)}` : ''}${stamp ? ` · ${esc(stamp)}` : ''}</small></div>
        </div>`;
      }).join('')
      : '<p class="feed-ann-empty">Nenhum comunicado ativo agora.</p>';
    if (more) {
      more.classList.toggle('hidden', active.length <= 2);
      more.textContent = state.announcementsAll ? 'Ver menos' : 'Ver todos';
    }
  }

  async function loadRails() {
    renderDigest();
    try {
      const data = await api('/api/announcements');
      state.announcements = (data.announcements || []).filter(item => item.active && !item.weeklyDigest).slice().reverse();
      renderAnnouncements();
    } catch {
      const host = document.getElementById('feedAnnouncements');
      if (host) host.innerHTML = '<p class="feed-ann-empty">Não foi possível carregar os comunicados.</p>';
    }
  }

  function fmtDate(value) {
    const date = new Date(`${value}T12:00:00`);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  }

  function updateBadge(count) {
    const badge = document.getElementById('feedNavBadge');
    if (!badge) return;
    const value = Math.max(0, Number(count) || 0);
    badge.textContent = value > 9 ? '9+' : String(value);
    badge.classList.toggle('hidden', value <= 0);
  }

  async function refreshBadge() {
    if (!token()) { updateBadge(0); return; }
    try {
      const data = await api('/api/feed/unread');
      updateBadge(data.unread);
    } catch {}
  }

  async function markRead() {
    try {
      await api('/api/feed/read', { method: 'POST', body: '{}' });
      updateBadge(0);
    } catch {}
  }

  async function loadFeed(reset = true) {
    if (!token() || state.loading) return;
    state.loading = true;
    try {
      const before = reset ? '' : (state.posts[state.posts.length - 1]?.createdAt || '');
      const query = `?limit=30${before ? `&before=${encodeURIComponent(before)}` : ''}`;
      const data = await api(`/api/feed${query}`);
      state.posts = reset ? (data.posts || []) : [...state.posts, ...(data.posts || [])];
      state.hasMore = Boolean(data.hasMore);
      render();
      updateBadge(data.unread);
      if (reset) markRead();
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
    } finally {
      state.loading = false;
    }
  }

  function renderStaged() {
    const preview = document.getElementById('feedPreview');
    const attach = document.querySelector('#feedForm .feed-attach');
    if (!preview) return;
    const chips = state.staged.map(item => `<span class="feed-chip">${String(item.mime || '').startsWith('image/') ? `<img src="${esc(mediaUrl(item.media))}" alt="">` : '📎'}<span>${esc(item.name)}</span><button type="button" data-feed-remove="${esc(item.key)}" title="Remover">×</button></span>`);
    if (state.uploading > 0) chips.push(`<span class="feed-chip">Enviando ${state.uploading}…</span>`);
    preview.innerHTML = chips.join('');
    preview.classList.toggle('hidden', chips.length === 0);
    attach?.classList.toggle('is-busy', state.uploading > 0);
  }

  async function uploadFile(file) {
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    state.uploading += 1;
    renderStaged();
    try {
      const params = new URLSearchParams({ name: file.name || 'arquivo', mime: file.type || 'application/octet-stream' });
      const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/feed/upload?${params.toString()}`, {
        method: 'POST',
        headers: window.PortalAccess.authHeaders({ 'Content-Type': 'application/octet-stream' }),
        body: file,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Não foi possível enviar o arquivo.');
      state.staged.push({
        key,
        media: data.media,
        mime: data.mime || file.type || 'application/octet-stream',
        name: data.name || file.name || 'arquivo',
        size: data.size || file.size || 0,
      });
    } catch (error) {
      toast(`${file.name}: ${error.message}`, 'warning');
    } finally {
      state.uploading -= 1;
      renderStaged();
    }
  }

  function hydrateMe() {
    const person = user();
    if (!person) return;
    const display = person.displayName || person.username || 'Você';
    fillAvatar(document.getElementById('feedMyAvatar'), { name: display, photo: person.photo });
    fillAvatar(document.getElementById('feedPersonAvatar'), { name: display, photo: person.photo });
    const name = document.getElementById('feedMyName');
    if (name) name.textContent = display;
    const topName = document.getElementById('feedPersonName');
    if (topName) topName.textContent = display;
    const sector = person.sectorName || (person.sectors || []).map(item => item.name).filter(Boolean).join(', ');
    const topSector = document.getElementById('feedPersonSector');
    if (topSector) topSector.textContent = sector || (person.management ? 'Gestão' : 'Portal do Setor');
  }

  function enterFeedScreen() {
    state.visible = true;
    document.body.classList.add('feed-active');
    hydrateMe();
    loadFeed(true);
    loadRails();
    loadNotices().then(() => {
      const unread = state.notices.filter(item => !item.seen).length;
      if (unread) toast(`${unread} aviso(s) da administração no mural.`, 'warning');
    });
    loadUpdates();
    refreshBadge();
    if (state.badgeTimer) clearInterval(state.badgeTimer);
    state.badgeTimer = setInterval(() => { if (state.visible) refreshBadge(); }, 60000);
  }

  function leaveFeedScreen() {
    state.visible = false;
    document.body.classList.remove('feed-active');
    state.replyTo = null;
    closeLightbox();
    if (state.badgeTimer) {
      clearInterval(state.badgeTimer);
      state.badgeTimer = null;
    }
  }

  function openLightbox(url, name) {
    const box = document.getElementById('feedLightbox');
    const image = document.getElementById('feedLightboxImg');
    const caption = document.getElementById('feedLightboxCap');
    if (!box || !image) return;
    image.src = url;
    image.alt = name || 'Imagem';
    if (caption) caption.textContent = name || '';
    box.classList.remove('hidden');
    document.body.classList.add('feed-lightbox-open');
  }

  function closeLightbox() {
    const box = document.getElementById('feedLightbox');
    if (!box || box.classList.contains('hidden')) return;
    box.classList.add('hidden');
    document.body.classList.remove('feed-lightbox-open');
    const image = document.getElementById('feedLightboxImg');
    if (image) image.removeAttribute('src');
  }

  function openModeration(post) {
    state.moderationId = post.id;
    const author = document.getElementById('feedModerationAuthor');
    const excerpt = document.getElementById('feedModerationExcerpt');
    const reason = document.getElementById('feedModerationReason');
    if (author) author.textContent = post.author.name || 'pessoa';
    if (excerpt) excerpt.textContent = (post.title || post.body || 'Publicação com mídia').slice(0, 220);
    if (reason) reason.value = '';
    document.getElementById('feedModerationDialog')?.showModal();
    setTimeout(() => reason?.focus(), 60);
  }

  function bind() {
    document.getElementById('feedBell')?.addEventListener('click', () => window.openScreen?.('homeScreen'));
    document.getElementById('feedPerson')?.addEventListener('click', () => window.openProfile?.());
    document.getElementById('feedForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const text = document.getElementById('feedText');
      const kind = document.getElementById('feedKind');
      const publish = document.getElementById('feedPublish');
      const body = text?.value.trim() || '';
      if (state.uploading > 0) {
        toast('Aguarde o envio dos arquivos terminar.', 'warning');
        return;
      }
      if (!body && !state.staged.length) {
        toast('Escreva algo ou escolha uma foto para publicar.', 'warning');
        return;
      }
      if (publish) publish.disabled = true;
      try {
        const data = await api('/api/feed', {
          method: 'POST',
          body: JSON.stringify({
            body,
            kind: kind?.value || 'post',
            media: state.staged.map(item => ({ media: item.media, mime: item.mime, name: item.name, size: item.size })),
          }),
        });
        state.posts.unshift(data.post);
        state.staged = [];
        state.filter = 'all';
        if (text) text.value = '';
        if (kind) kind.value = 'post';
        document.querySelectorAll('[data-feed-kind]').forEach(button => button.classList.toggle('active', button.dataset.feedKind === 'post'));
        document.querySelectorAll('[data-feed-filter]').forEach(button => button.classList.toggle('active', button.dataset.feedFilter === 'all'));
        renderStaged();
        render();
        loadRails();
        toast('Publicado no mural.', 'success');
      } catch (error) {
        if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
      } finally {
        if (publish) publish.disabled = false;
      }
    });

    document.getElementById('feedFiles')?.addEventListener('change', async event => {
      const files = [...event.target.files];
      event.target.value = '';
      for (const file of files) await uploadFile(file);
    });

    document.getElementById('feedPreview')?.addEventListener('click', event => {
      const remove = event.target.closest('[data-feed-remove]');
      if (!remove) return;
      state.staged = state.staged.filter(item => item.key !== remove.dataset.feedRemove);
      renderStaged();
    });

    document.getElementById('feedTabs')?.addEventListener('click', event => {
      const tab = event.target.closest('[data-feed-filter]');
      if (!tab) return;
      state.filter = tab.dataset.feedFilter;
      document.querySelectorAll('[data-feed-filter]').forEach(button => button.classList.toggle('active', button === tab));
      render();
    });

    document.getElementById('feedMore')?.addEventListener('click', () => loadFeed(false));

    document.getElementById('feedPosts')?.addEventListener('click', async event => {
      const image = event.target.closest('[data-feed-image]');
      if (image) {
        openLightbox(image.dataset.feedImage, image.dataset.feedImageName);
        return;
      }
      const reply = event.target.closest('[data-feed-reply]');
      if (reply) {
        const commentId = reply.dataset.feedReply;
        const post = state.posts.find(item => item.comments.some(comment => comment.id === commentId));
        if (!post) return;
        state.replyTo = { postId: post.id, commentId, name: reply.dataset.feedReplyName || 'comentário' };
        const box = document.querySelector(`[data-feed-comment-box="${post.id}"]`);
        box?.classList.remove('hidden');
        const slot = document.querySelector(`[data-feed-reply-slot="${post.id}"]`);
        if (slot) slot.innerHTML = replyChipHtml();
        box?.querySelector('input')?.focus();
        return;
      }
      if (event.target.closest('[data-feed-reply-cancel]')) {
        state.replyTo = null;
        document.querySelectorAll('[data-feed-reply-slot]').forEach(slot => { slot.innerHTML = ''; });
        return;
      }
      const like = event.target.closest('[data-feed-like]');
      if (like) {
        const post = findPost(like.dataset.feedLike);
        if (!post) return;
        like.disabled = true;
        try {
          const data = await api(`/api/feed/${encodeURIComponent(post.id)}/like`, { method: 'POST', body: '{}' });
          post.liked = Boolean(data.liked);
          post.likes = Number(data.likes) || 0;
          post.likers = Array.isArray(data.likers) ? data.likers : [];
          like.innerHTML = likeInner(post);
          like.classList.toggle('is-liked', post.liked);
          like.setAttribute('aria-pressed', String(post.liked));
          like.setAttribute('aria-label', post.liked ? 'Descurtir' : 'Curtir');
          like.title = post.liked ? 'Descurtir' : 'Curtir';
          const likersEl = like.closest('.feed-post')?.querySelector('[data-feed-likers]');
          const likers = likersText(post);
          if (likersEl) {
            likersEl.textContent = likers ? `Curtido por ${likers}` : '';
            likersEl.classList.toggle('hidden', !likers);
          }
        } catch (error) {
          if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
        } finally {
          like.disabled = false;
        }
        return;
      }
      const toggle = event.target.closest('[data-feed-comments]');
      if (toggle) {
        const box = document.querySelector(`[data-feed-comment-box="${toggle.dataset.feedComments}"]`);
        if (!box) return;
        box.classList.toggle('hidden');
        if (!box.classList.contains('hidden')) box.querySelector('input')?.focus();
        return;
      }
      const removePost = event.target.closest('[data-feed-delete]');
      if (removePost) {
        const post = findPost(removePost.dataset.feedDelete);
        if (!post) return;
        const mine = post.author.id && post.author.id === user()?.id;
        if (isManager() && !mine && post.kind !== 'digest') {
          openModeration(post);
          return;
        }
        if (!confirm('Excluir esta publicação? As curtidas e os comentários também serão removidos.')) return;
        try {
          await api(`/api/feed/${encodeURIComponent(post.id)}`, { method: 'DELETE' });
          state.posts = state.posts.filter(item => item.id !== post.id);
          render();
          loadRails();
          toast('Publicação excluída.');
        } catch (error) {
          if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
        }
        return;
      }
      const removeComment = event.target.closest('[data-feed-comment-delete]');
      if (removeComment) {
        if (!confirm('Excluir este comentário? As respostas também serão removidas.')) return;
        try {
          const data = await api(`/api/feed/comments/${encodeURIComponent(removeComment.dataset.feedCommentDelete)}`, { method: 'DELETE' });
          const ids = data.ids || [removeComment.dataset.feedCommentDelete];
          const post = state.posts.find(item => item.comments.some(comment => comment.id === removeComment.dataset.feedCommentDelete));
          if (post) {
            post.comments = post.comments.filter(comment => !ids.includes(comment.id));
            const list = document.querySelector(`[data-feed-comment-list="${post.id}"]`);
            if (list) list.innerHTML = commentsMarkup(post);
            const count = document.querySelector(`[data-feed-comments="${post.id}"]`);
            if (count) count.innerHTML = commentInner(post);
          }
        } catch (error) {
          if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
        }
      }
    });

    document.getElementById('feedPosts')?.addEventListener('submit', async event => {
      const form = event.target.closest('[data-feed-comment-form]');
      if (!form) return;
      event.preventDefault();
      const post = findPost(form.dataset.feedCommentForm);
      const input = form.querySelector('input');
      const body = input?.value.trim() || '';
      if (!post || !body) return;
      const submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      const parentId = state.replyTo && state.replyTo.postId === post.id ? state.replyTo.commentId : '';
      try {
        const data = await api(`/api/feed/${encodeURIComponent(post.id)}/comments`, { method: 'POST', body: JSON.stringify({ body, parentId }) });
        post.comments.push(data.comment);
        const list = document.querySelector(`[data-feed-comment-list="${post.id}"]`);
        if (list) list.innerHTML = commentsMarkup(post);
        const count = document.querySelector(`[data-feed-comments="${post.id}"]`);
        if (count) count.innerHTML = commentInner(post);
        if (input) input.value = '';
        state.replyTo = null;
        const slot = form.querySelector('[data-feed-reply-slot]');
        if (slot) slot.innerHTML = '';
        document.querySelector(`[data-feed-comment-box="${post.id}"]`)?.classList.remove('hidden');
      } catch (error) {
        if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
      } finally {
        if (submit) submit.disabled = false;
      }
    });

    document.getElementById('feedKindChips')?.addEventListener('click', event => {
      const chip = event.target.closest('[data-feed-kind]');
      if (!chip) return;
      const kind = document.getElementById('feedKind');
      if (kind) kind.value = chip.dataset.feedKind;
      document.querySelectorAll('[data-feed-kind]').forEach(button => button.classList.toggle('active', button === chip));
    });

    document.getElementById('feedLightboxClose')?.addEventListener('click', closeLightbox);
    document.getElementById('feedLightbox')?.addEventListener('click', event => {
      if (event.target.id === 'feedLightbox') closeLightbox();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      closeLightbox();
      const dialog = document.getElementById('feedModerationDialog');
      if (dialog?.open) dialog.close();
    });

    document.getElementById('feedNoticesRead')?.addEventListener('click', markNoticesRead);

    document.getElementById('feedUpdatesMore')?.addEventListener('click', () => {
      state.updatesAll = !state.updatesAll;
      renderUpdates();
    });

    document.getElementById('feedUpdateToggle')?.addEventListener('click', () => {
      const form = document.getElementById('feedUpdateForm');
      form?.classList.toggle('hidden');
      if (form && !form.classList.contains('hidden')) document.getElementById('feedUpdateTitle')?.focus();
    });

    document.getElementById('feedAnnouncementsMore')?.addEventListener('click', () => {
      state.announcementsAll = !state.announcementsAll;
      renderAnnouncements();
    });

    document.getElementById('feedUpdateForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const title = document.getElementById('feedUpdateTitle');
      const body = document.getElementById('feedUpdateBody');
      const text = title?.value.trim() || '';
      if (!text) { toast('Informe o título da novidade.', 'warning'); title?.focus(); return; }
      const submit = event.target.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      try {
        const data = await api('/api/system-updates', { method: 'POST', body: JSON.stringify({ title: text, body: body?.value.trim() || '' }) });
        state.updates.unshift(data.update);
        renderUpdates();
        if (title) title.value = '';
        if (body) body.value = '';
        event.target.classList.add('hidden');
        toast('Novidade publicada. Ela entra no resumo da semana.');
      } catch (error) {
        if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
      } finally {
        if (submit) submit.disabled = false;
      }
    });

    document.getElementById('feedUpdates')?.addEventListener('click', async event => {
      const remove = event.target.closest('[data-feed-update-delete]');
      if (!remove) return;
      if (!confirm('Remover esta novidade da lista?')) return;
      try {
        await api(`/api/system-updates/${encodeURIComponent(remove.dataset.feedUpdateDelete)}`, { method: 'DELETE' });
        state.updates = state.updates.filter(item => item.id !== remove.dataset.feedUpdateDelete);
        renderUpdates();
        toast('Novidade removida.');
      } catch (error) {
        if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
      }
    });

    document.getElementById('feedModerationForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const post = findPost(state.moderationId);
      const reason = document.getElementById('feedModerationReason');
      if (!post) {
        document.getElementById('feedModerationDialog')?.close();
        return;
      }
      const text = reason?.value.trim() || '';
      if (text.length < 3) {
        toast('Informe o motivo da remoção para avisar o autor.', 'warning');
        reason?.focus();
        return;
      }
      const confirmButton = document.getElementById('feedModerationConfirm');
      if (confirmButton) confirmButton.disabled = true;
      try {
        const data = await api(`/api/feed/${encodeURIComponent(post.id)}?reason=${encodeURIComponent(text)}`, { method: 'DELETE' });
        state.posts = state.posts.filter(item => item.id !== post.id);
        state.moderationId = '';
        document.getElementById('feedModerationDialog')?.close();
        render();
        loadRails();
        toast(data.notified ? 'Publicação removida. O autor foi avisado.' : 'Publicação removida.');
      } catch (error) {
        if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
      } finally {
        if (confirmButton) confirmButton.disabled = false;
      }
    });
    document.getElementById('feedModerationClose')?.addEventListener('click', () => document.getElementById('feedModerationDialog')?.close());
    document.getElementById('feedModerationCancel')?.addEventListener('click', () => document.getElementById('feedModerationDialog')?.close());
  }

  window.enterFeedScreen = enterFeedScreen;
  window.leaveFeedScreen = leaveFeedScreen;

  bind();
  const wait = setInterval(() => {
    const current = user();
    const key = current?.id || '';
    if (!key || key === state.userKey) return;
    state.userKey = key;
    clearInterval(wait);
    hydrateMe();
    refreshBadge();
    if (state.visible) { loadFeed(true); loadRails(); }
  }, 500);
  setTimeout(() => clearInterval(wait), 60000);

  setInterval(() => {
    const key = user()?.id || '';
    if (key === state.userKey) return;
    state.userKey = key;
    if (!key) {
      state.posts = [];
      state.staged = [];
      updateBadge(0);
      renderStaged();
      return;
    }
    hydrateMe();
    refreshBadge();
  }, 2000);
})();
