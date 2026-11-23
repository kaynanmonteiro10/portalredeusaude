import { useState } from 'react';
import { timeLabel, relativeUpper, fmtDate, digestTone } from '../feedApi.js';

export function NoticesCard({ notices, onMarkRead }) {
  if (!notices.length) return null;
  const unread = notices.filter(item => !item.seen).length;
  return (
    <article className="feed-rail-card">
      <div className="feed-rail-head">
        <div>
          <p className="eyebrow">PARA VOCÊ</p>
          <h3>Avisos da administração</h3>
        </div>
        <span className={`feed-count-badge${unread ? '' : ' hidden'}`}>{unread}</span>
      </div>
      <div className="feed-notice-list">
        {notices.map(item => (
          <div key={item.id} className={`feed-notice${item.seen ? '' : ' is-unread'}`}>
            <span className="feed-notice-icon">⚠</span>
            <div>
              <strong>{item.postTitle || 'Publicação removida'}</strong>
              <p>{item.reason}</p>
              <small>{timeLabel(item.createdAt)}</small>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        className={`feed-mark-read${unread ? '' : ' hidden'}`}
        onClick={onMarkRead}
      >
        Marcar como lidos
      </button>
    </article>
  );
}

export function DigestCard({ digest }) {
  const stats = digest?.meta?.stats || [];
  return (
    <article className="feed-rail-card">
      <div className="feed-rail-head">
        <div className="feed-rail-title">
          <span className="feed-rail-icon teal" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          </span>
          <h3>Resumo da semana</h3>
        </div>
        <span className="feed-rail-chip">Últimos 7 dias</span>
      </div>
      <div className="feed-digest-body">
        {digest ? (
          <>
            {stats.length ? (
              <div className="feed-digest-grid">
                {stats.map((item, index) => {
                  const meta = digestTone(item.label);
                  return (
                    <div key={index} className={`feed-digest-stat tone-${meta.tone}`}>
                      <span className="feed-digest-icon" aria-hidden="true">
                        {meta.icon}
                      </span>
                      <div>
                        <strong>{item.value}</strong>
                        <small>{item.label}</small>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
            <p className="feed-digest-date">
              Publicado em {new Date(digest.createdAt).toLocaleDateString('pt-BR')}
            </p>
          </>
        ) : (
          <p className="panel-help">Na primeira abertura de cada semana, o portal publica aqui o que foi feito.</p>
        )}
      </div>
    </article>
  );
}

export function UpdatesCard({ updates, all, onToggleAll, manager, onAdd, onDelete }) {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async event => {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    const ok = await onAdd(title.trim(), body.trim());
    if (ok) {
      setTitle('');
      setBody('');
      setShowForm(false);
    }
    setSaving(false);
  };

  const list = updates === null ? null : all ? updates : updates.slice(0, 3);

  return (
    <article className="feed-rail-card">
      <div className="feed-rail-head">
        <div className="feed-rail-title">
          <span className="feed-rail-icon slate" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.37.44.68.81.85H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </span>
          <h3>O que mudou no sistema</h3>
        </div>
        <div className="feed-rail-head-actions">
          <button
            type="button"
            className={`home-link feed-rail-link${updates && updates.length > 3 ? '' : ' hidden'}`}
            onClick={onToggleAll}
          >
            {all ? 'Ver menos' : 'Ver todas'}
          </button>
          {manager ? (
            <button
              type="button"
              className="feed-rail-iconbtn"
              title="Publicar novidade"
              aria-label="Publicar novidade"
              onClick={() => setShowForm(value => !value)}
            >
              ＋
            </button>
          ) : null}
        </div>
      </div>
      <div className="feed-update-list">
        {list === null ? (
          <p className="panel-help">Carregando novidades…</p>
        ) : list.length ? (
          list.map((item, index) => (
            <div key={item.id} className="feed-update">
              <span className="feed-update-num">{index + 1}</span>
              <div className="feed-update-text">
                <strong>{item.title}</strong>
                {item.body ? <p>{item.body}</p> : null}
                <small>{relativeUpper(item.createdAt)}</small>
              </div>
              {manager ? (
                <button
                  type="button"
                  className="feed-update-del"
                  title="Remover novidade"
                  aria-label="Remover novidade"
                  onClick={() => onDelete(item)}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))
        ) : (
          <p className="feed-update-empty">Nenhuma novidade publicada ainda.</p>
        )}
      </div>
      {showForm ? (
        <form className="feed-update-form" onSubmit={submit}>
          <input
            maxLength={160}
            placeholder="Título da novidade"
            required
            value={title}
            onChange={event => setTitle(event.target.value)}
          />
          <textarea
            rows={2}
            maxLength={2000}
            placeholder="Conte em uma frase o que mudou"
            value={body}
            onChange={event => setBody(event.target.value)}
          />
          <button className="button button-primary" type="submit" disabled={saving}>
            Publicar novidade
          </button>
        </form>
      ) : null}
    </article>
  );
}

const ANN_ICONS = { event: '▦', birthday: '✦', notice: '◉', congrats: '★' };
const ANN_LABELS = { event: 'Evento', birthday: 'Aniversariante', notice: 'Aviso', congrats: 'Parabéns' };

export function AnnouncementsCard({ items, all, onToggleAll }) {
  const visible = all ? items : items.slice(0, 2);
  return (
    <article className="feed-rail-card">
      <div className="feed-rail-head">
        <div className="feed-rail-title">
          <span className="feed-rail-icon blue" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 11l18-8-8 18-2-8-8-2z" />
            </svg>
          </span>
          <h3>Comunicados ativos</h3>
        </div>
        <button
          type="button"
          className={`home-link feed-rail-link${items.length > 2 ? '' : ' hidden'}`}
          onClick={onToggleAll}
        >
          {all ? 'Ver menos' : 'Ver todos'}
        </button>
      </div>
      <div className="feed-ann-list">
        {visible.length ? (
          visible.map(item => {
            const stamp = item.createdAt ? timeLabel(item.createdAt) : '';
            return (
              <div key={item.id} className={`feed-ann tone-${item.type || 'notice'}`}>
                <span className="feed-ann-icon" aria-hidden="true">
                  {ANN_ICONS[item.type] || '◉'}
                </span>
                <div>
                  <strong>{item.title}</strong>
                  {item.description ? <p>{item.description}</p> : null}
                  <small>
                    {ANN_LABELS[item.type] || 'Aviso'}
                    {item.date ? ` · ${fmtDate(item.date)}` : ''}
                    {stamp ? ` · ${stamp}` : ''}
                  </small>
                </div>
              </div>
            );
          })
        ) : (
          <p className="feed-ann-empty">Nenhum comunicado ativo agora.</p>
        )}
      </div>
    </article>
  );
}

export function MotivateCard() {
  return (
    <article className="feed-motivate">
      <span className="feed-motivate-icon" aria-hidden="true">
        ♥
      </span>
      <div>
        <strong>
          Gente que cuida,
          <br />
          faz a diferença.
        </strong>
        <small>Rede Saúde · Portal do Setor</small>
      </div>
    </article>
  );
}
