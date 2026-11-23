import { useCallback, useEffect, useRef, useState } from 'react';
import Avatar from './components/Avatar.jsx';
import Composer from './components/Composer.jsx';
import PostCard from './components/PostCard.jsx';
import {
  NoticesCard,
  DigestCard,
  UpdatesCard,
  AnnouncementsCard,
  MotivateCard,
} from './components/Rails.jsx';
import Lightbox from './components/Lightbox.jsx';
import ModerationDialog from './components/ModerationDialog.jsx';
import {
  api,
  token,
  currentUser,
  isManager,
  toast,
  updateNavBadge,
  todayIso,
} from './feedApi.js';

const FILTERS = [
  { value: 'all', label: 'Tudo' },
  { value: 'media', label: 'Fotos' },
  { value: 'notice', label: 'Avisos' },
];

export default function App() {
  const [user, setUser] = useState(currentUser());
  const [posts, setPosts] = useState([]);
  const [filter, setFilter] = useState('all');
  const [hasMore, setHasMore] = useState(false);
  const [staged, setStaged] = useState([]);
  const [uploading, setUploading] = useState(0);
  const [liking, setLiking] = useState({});
  const [drafts, setDrafts] = useState({});
  const [commentOpen, setCommentOpen] = useState({});
  const [replyTo, setReplyTo] = useState(null);
  const [notices, setNotices] = useState([]);
  const [updates, setUpdates] = useState(null);
  const [updatesAll, setUpdatesAll] = useState(false);
  const [announcements, setAnnouncements] = useState([]);
  const [announcementsAll, setAnnouncementsAll] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const [moderation, setModeration] = useState(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [loadingFirst, setLoadingFirst] = useState(true);

  const postsRef = useRef([]);
  const moreRef = useRef(null);
  const stagedRef = useRef([]);
  const uploadingRef = useRef(0);
  const noticesRef = useRef([]);
  const visibleRef = useRef(false);
  const loadingRef = useRef(false);
  const badgeTimerRef = useRef(null);
  const userRef = useRef(user);

  useEffect(() => {
    postsRef.current = posts;
  }, [posts]);

  useEffect(() => {
    stagedRef.current = staged;
  }, [staged]);

  useEffect(() => {
    uploadingRef.current = uploading;
  }, [uploading]);

  useEffect(() => {
    noticesRef.current = notices;
  }, [notices]);

  const commitPosts = useCallback(next => {
    postsRef.current = next;
    setPosts(next);
  }, []);

  const refreshBadge = useCallback(async () => {
    if (!token()) {
      updateNavBadge(0);
      return;
    }
    try {
      const data = await api('/api/feed/unread');
      updateNavBadge(data.unread);
    } catch {}
  }, []);

  const markRead = useCallback(async () => {
    try {
      await api('/api/feed/read', { method: 'POST', body: '{}' });
      updateNavBadge(0);
    } catch {}
  }, []);

  const loadFeed = useCallback(
    async (reset = true) => {
      if (!token() || loadingRef.current) return;
      loadingRef.current = true;
      try {
        const before = reset ? '' : postsRef.current[postsRef.current.length - 1]?.createdAt || '';
        const query = `?limit=30${before ? `&before=${encodeURIComponent(before)}` : ''}`;
        const data = await api(`/api/feed${query}`);
        const next = reset ? data.posts || [] : [...postsRef.current, ...(data.posts || [])];
        commitPosts(next);
        setHasMore(Boolean(data.hasMore));
        updateNavBadge(data.unread);
        if (reset) markRead();
      } catch (error) {
        if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
      } finally {
        loadingRef.current = false;
        setLoadingFirst(false);
      }
    },
    [commitPosts, markRead]
  );

  const loadRails = useCallback(async () => {
    try {
      const data = await api('/api/announcements');
      const today = todayIso();
      setAnnouncements(
        (data.announcements || [])
          .filter(item => item.active && !item.weeklyDigest && (!item.date || item.date >= today))
          .slice()
          .reverse()
      );
    } catch {}
  }, []);

  const loadNotices = useCallback(async () => {
    if (!token()) return [];
    try {
      const data = await api('/api/feed/notices');
      const list = data.notices || [];
      setNotices(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  const loadUpdates = useCallback(async () => {
    try {
      const data = await api('/api/system-updates');
      setUpdates(data.updates || []);
    } catch {
      setUpdates([]);
    }
  }, []);

  const enter = useCallback(() => {
    visibleRef.current = true;
    document.body.classList.add('feed-active');
    loadFeed(true);
    loadRails();
    loadNotices().then(list => {
      const unread = (list || []).filter(item => !item.seen).length;
      if (unread) toast(`${unread} aviso(s) da administração no mural.`, 'warning');
    });
    loadUpdates();
    refreshBadge();
    if (badgeTimerRef.current) clearInterval(badgeTimerRef.current);
    badgeTimerRef.current = setInterval(() => {
      if (visibleRef.current) refreshBadge();
    }, 60000);
  }, [loadFeed, loadRails, loadNotices, loadUpdates, refreshBadge]);

  const leave = useCallback(() => {
    visibleRef.current = false;
    document.body.classList.remove('feed-active');
    setReplyTo(null);
    setLightbox(null);
    if (badgeTimerRef.current) {
      clearInterval(badgeTimerRef.current);
      badgeTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    window.addEventListener('portal:feed-enter', enter);
    window.addEventListener('portal:feed-leave', leave);
    if (window.__feedVisible) enter();
    return () => {
      window.removeEventListener('portal:feed-enter', enter);
      window.removeEventListener('portal:feed-leave', leave);
      leave();
    };
  }, [enter, leave]);

  useEffect(() => {
    const poll = setInterval(() => {
      const current = currentUser();
      const key = current?.id || '';
      if (key === (userRef.current?.id || '')) return;
      userRef.current = current;
      setUser(current);
      if (!key) {
        commitPosts([]);
        setStaged([]);
        setUploading(0);
        updateNavBadge(0);
        return;
      }
      refreshBadge();
      if (visibleRef.current) {
        loadFeed(true);
        loadRails();
        loadUpdates();
      }
    }, 1500);
    return () => clearInterval(poll);
  }, [commitPosts, refreshBadge, loadFeed, loadRails, loadUpdates]);

  useEffect(() => {
    const onKey = event => {
      if (event.key !== 'Escape') return;
      setLightbox(null);
      setModeration(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const manager = isManager(user);
  const modern = user?.role === 'admin';
  const displayName = user?.displayName || user?.username || 'Você';

  useEffect(() => {
    if (!modern || !hasMore) return undefined;
    const node = moreRef.current;
    if (!node || !('IntersectionObserver' in window)) return undefined;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) loadFeed(false);
      },
      { rootMargin: '320px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [modern, hasMore, loadFeed]);
  const sector =
    user?.sectorName ||
    (user?.sectors || [])
      .map(item => item.name)
      .filter(Boolean)
      .join(', ') ||
    (user?.management ? 'Gestão' : 'Portal do Setor');

  const publish = async (body, kind) => {
    if (uploadingRef.current > 0) {
      toast('Aguarde o envio dos arquivos terminar.', 'warning');
      return false;
    }
    if (!body && !stagedRef.current.length) {
      toast('Escreva algo ou escolha uma foto para publicar.', 'warning');
      return false;
    }
    try {
      const data = await api('/api/feed', {
        method: 'POST',
        body: JSON.stringify({
          body,
          kind,
          media: stagedRef.current.map(item => ({
            media: item.media,
            mime: item.mime,
            name: item.name,
            size: item.size,
          })),
        }),
      });
      commitPosts([data.post, ...postsRef.current]);
      setStaged([]);
      setFilter('all');
      loadRails();
      toast('Publicado no mural.', 'success');
      setComposeOpen(false);
      return true;
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
      return false;
    }
  };

  const uploadFiles = async files => {
    for (const file of files) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setUploading(value => value + 1);
      try {
        const params = new URLSearchParams({
          name: file.name || 'arquivo',
          mime: file.type || 'application/octet-stream',
        });
        const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/feed/upload?${params}`, {
          method: 'POST',
          headers: window.PortalAccess.authHeaders({ 'Content-Type': 'application/octet-stream' }),
          body: file,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Não foi possível enviar o arquivo.');
        setStaged(list => [
          ...list,
          {
            key,
            media: data.media,
            mime: data.mime || file.type || 'application/octet-stream',
            name: data.name || file.name || 'arquivo',
            size: data.size || file.size || 0,
          },
        ]);
      } catch (error) {
        toast(`${file.name}: ${error.message}`, 'warning');
      } finally {
        setUploading(value => value - 1);
      }
    }
  };

  const likePost = async post => {
    if (liking[post.id]) return;
    const current = postsRef.current.find(item => item.id === post.id);
    if (!current) return;
    const wasLiked = Boolean(current.liked);
    const previous = postsRef.current;
    const optimistic = list =>
      list.map(item =>
        item.id === post.id
          ? {
              ...item,
              liked: !wasLiked,
              likes: Math.max(0, (Number(item.likes) || 0) + (wasLiked ? -1 : 1)),
              likers: wasLiked
                ? (item.likers || []).filter(person => person.id !== user?.id)
                : [...(item.likers || []), { id: user?.id, name: displayName, photo: user?.photo }],
            }
          : item
      );
    setLiking(map => ({ ...map, [post.id]: true }));
    commitPosts(optimistic(postsRef.current));
    try {
      const data = await api(`/api/feed/${encodeURIComponent(post.id)}/like`, {
        method: 'POST',
        body: '{}',
      });
      commitPosts(
        postsRef.current.map(item =>
          item.id === post.id
            ? {
                ...item,
                liked: Boolean(data.liked),
                likes: Number(data.likes) || 0,
                likers: Array.isArray(data.likers) ? data.likers : [],
              }
            : item
        )
      );
    } catch (error) {
      commitPosts(previous);
      if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
    } finally {
      setLiking(map => ({ ...map, [post.id]: false }));
    }
  };

  const commentsOpen = post => commentOpen[post.id] ?? (post.comments || []).length > 0;

  const toggleComments = post => {
    setCommentOpen(map => ({ ...map, [post.id]: !(map[post.id] ?? (post.comments || []).length > 0) }));
  };

  const startReply = comment => {
    const post = postsRef.current.find(item => (item.comments || []).some(c => c.id === comment.id));
    if (!post) return;
    setReplyTo({ postId: post.id, commentId: comment.id, name: comment.author.name || 'comentário' });
    setCommentOpen(map => ({ ...map, [post.id]: true }));
  };

  const submitComment = async post => {
    const body = (drafts[post.id] || '').trim();
    if (!body) return;
    const parentId = replyTo && replyTo.postId === post.id ? replyTo.commentId : '';
    try {
      const data = await api(`/api/feed/${encodeURIComponent(post.id)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body, parentId }),
      });
      setPosts(list =>
        list.map(item =>
          item.id === post.id ? { ...item, comments: [...(item.comments || []), data.comment] } : item
        )
      );
      setDrafts(map => ({ ...map, [post.id]: '' }));
      if (replyTo && replyTo.postId === post.id) setReplyTo(null);
      setCommentOpen(map => ({ ...map, [post.id]: true }));
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
    }
  };

  const deletePost = async post => {
    const mine = Boolean(post.author.id && user?.id && post.author.id === user.id);
    if (manager && !mine && post.kind !== 'digest') {
      setModeration(post);
      return;
    }
    if (!confirm('Excluir esta publicação? As curtidas e os comentários também serão removidos.')) return;
    try {
      await api(`/api/feed/${encodeURIComponent(post.id)}`, { method: 'DELETE' });
      commitPosts(postsRef.current.filter(item => item.id !== post.id));
      loadRails();
      toast('Publicação excluída.');
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
    }
  };

  const confirmModeration = async (post, reason) => {
    try {
      const data = await api(
        `/api/feed/${encodeURIComponent(post.id)}?reason=${encodeURIComponent(reason)}`,
        { method: 'DELETE' }
      );
      commitPosts(postsRef.current.filter(item => item.id !== post.id));
      setModeration(null);
      loadRails();
      toast(data.notified ? 'Publicação removida. O autor foi avisado.' : 'Publicação removida.');
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
    }
  };

  const deleteComment = async comment => {
    if (!confirm('Excluir este comentário? As respostas também serão removidas.')) return;
    try {
      const data = await api(`/api/feed/comments/${encodeURIComponent(comment.id)}`, {
        method: 'DELETE',
      });
      const ids = data.ids || [comment.id];
      setPosts(list =>
        list.map(post =>
          (post.comments || []).some(item => ids.includes(item.id))
            ? { ...post, comments: post.comments.filter(item => !ids.includes(item.id)) }
            : post
        )
      );
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
    }
  };

  const markNoticesRead = async () => {
    if (!noticesRef.current.some(item => !item.seen)) return;
    try {
      await api('/api/feed/notices/read', { method: 'POST', body: '{}' });
      setNotices(list => list.map(item => ({ ...item, seen: true })));
    } catch {}
  };

  const addUpdate = async (title, body) => {
    try {
      const data = await api('/api/system-updates', {
        method: 'POST',
        body: JSON.stringify({ title, body }),
      });
      setUpdates(list => [data.update, ...(list || [])]);
      toast('Novidade publicada. Ela entra no resumo da semana.');
      return true;
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
      return false;
    }
  };

  const removeUpdate = async item => {
    if (!confirm('Remover esta novidade da lista?')) return;
    try {
      await api(`/api/system-updates/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      setUpdates(list => (list || []).filter(update => update.id !== item.id));
      toast('Novidade removida.');
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') toast(error.message, 'warning');
    }
  };

  const filteredPosts = posts.filter(post => {
    if (filter === 'media') return (post.media || []).length > 0;
    if (filter === 'notice') return post.kind !== 'post';
    return true;
  });
  const digest = posts.find(post => post.kind === 'digest');
  const unreadNotices = notices.filter(item => !item.seen).length;

  return (
    <>
      <section className={`feed-shell${modern ? ' feed-modern' : ''}`}>
        <div className="feed-main">
          <header className="feed-head">
            <div className="feed-topline">
              <p className="eyebrow">MURAL DA EQUIPE</p>
              <div className="feed-top-actions">
                <button
                  className="feed-bell"
                  type="button"
                  title="Ver avisos no Início"
                  aria-label="Ver avisos no Início"
                  onClick={() => window.openScreen?.('homeScreen')}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
                  </svg>
                  {unreadNotices ? <span className="feed-bell-dot" /> : null}
                </button>
                <button
                  className="feed-person"
                  type="button"
                  title="Meu perfil"
                  onClick={() => window.openProfile?.()}
                >
                  <Avatar person={{ name: displayName, photo: user?.photo }} cls="feed-person-avatar" />
                  <span className="feed-person-copy">
                    <strong>{displayName}</strong>
                    <small>{sector}</small>
                  </span>
                </button>
              </div>
            </div>
            <div className="feed-titlebar">
              <div className="feed-head-copy">
                <h2>Novidades do time</h2>
                <p className="panel-help">Publique fotos de eventos, avisos e conquistas.</p>
              </div>
              <div className="feed-tabs" role="tablist" aria-label="Filtrar publicações">
                {FILTERS.map(item => (
                  <button
                    key={item.value}
                    type="button"
                    className={`feed-tab${filter === item.value ? ' active' : ''}`}
                    role="tab"
                    aria-selected={filter === item.value}
                    onClick={() => setFilter(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </header>
          <div className="feed-panel">
            {modern && !composeOpen ? (
              <button type="button" className="feed-compose-trigger" onClick={() => setComposeOpen(true)}>
                <Avatar person={{ name: displayName, photo: user?.photo }} />
                <span className="feed-compose-placeholder">Compartilhe uma novidade com a equipe…</span>
                <span className="feed-compose-icons" aria-hidden="true">
                  <span>▧ Foto</span>
                  <span>◉ Aviso</span>
                </span>
              </button>
            ) : (
              <Composer
                me={user}
                displayName={displayName}
                staged={staged}
                uploading={uploading}
                onUpload={uploadFiles}
                onRemove={key => setStaged(list => list.filter(item => item.key !== key))}
                onPublish={publish}
                autoFocus={modern}
                onClose={modern ? () => setComposeOpen(false) : undefined}
              />
            )}
            {modern && loadingFirst && !posts.length ? (
              <div className="feed-skeleton" aria-hidden="true">
                {[0, 1].map(item => (
                  <div key={item} className="feed-skeleton-card">
                    <div className="feed-skeleton-row">
                      <span className="feed-skeleton-avatar" />
                      <span className="feed-skeleton-lines">
                        <span className="feed-skeleton-line" />
                        <span className="feed-skeleton-line short" />
                      </span>
                    </div>
                    <div className="feed-skeleton-media" />
                  </div>
                ))}
              </div>
            ) : null}
            <div className="feed-list">
              {filteredPosts.map((post, index) => (
                <PostCard
                  key={post.id}
                  post={post}
                  index={index}
                  me={user}
                  manager={manager}
                  replyTo={replyTo}
                  commentsOpen={commentsOpen(post)}
                  draft={drafts[post.id] || ''}
                  liking={Boolean(liking[post.id])}
                  onLike={likePost}
                  onToggleComments={toggleComments}
                  onReply={startReply}
                  onCancelReply={() => setReplyTo(null)}
                  onDraft={(id, value) => setDrafts(map => ({ ...map, [id]: value }))}
                  onSubmitComment={submitComment}
                  onDeletePost={deletePost}
                  onDeleteComment={deleteComment}
                  onOpenImage={setLightbox}
                />
              ))}
            </div>
            <p className={`empty-state${filteredPosts.length || (modern && loadingFirst) ? ' hidden' : ''}`}>
              {posts.length
                ? 'Nenhuma publicação neste filtro.'
                : 'Nenhuma publicação ainda. Comece contando uma novidade para a equipe.'}
            </p>
            <div className="feed-more-wrap" ref={moreRef}>
              <button
                className={`button button-secondary${hasMore && !modern ? '' : ' hidden'}`}
                type="button"
                onClick={() => loadFeed(false)}
              >
                Carregar mais
              </button>
            </div>
          </div>
        </div>
        <aside className="feed-rail">
          <NoticesCard notices={notices} onMarkRead={markNoticesRead} />
          <DigestCard digest={digest} />
          <UpdatesCard
            updates={updates}
            all={updatesAll}
            onToggleAll={() => setUpdatesAll(value => !value)}
            manager={manager}
            onAdd={addUpdate}
            onDelete={removeUpdate}
          />
          <AnnouncementsCard
            items={announcements}
            all={announcementsAll}
            onToggleAll={() => setAnnouncementsAll(value => !value)}
          />
          <MotivateCard />
        </aside>
      </section>
      <Lightbox item={lightbox} onClose={() => setLightbox(null)} />
      <ModerationDialog
        post={moderation}
        onClose={() => setModeration(null)}
        onConfirm={confirmModeration}
      />
    </>
  );
}
