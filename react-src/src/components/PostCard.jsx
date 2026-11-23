import { Fragment } from 'react';
import Avatar from './Avatar.jsx';
import MediaGrid from './MediaGrid.jsx';
import { timeDetail, timeLabel, likersText } from '../feedApi.js';

function badgeFor(post) {
  if (post.kind === 'digest') return <span className="feed-badge digest">Resumo da semana</span>;
  if (post.kind === 'notice') return <span className="feed-badge notice">Aviso</span>;
  if (post.kind === 'event') return <span className="feed-badge event">Evento</span>;
  return null;
}

function Comment({ comment, isReply = false, onReply, onDelete }) {
  return (
    <div className={`feed-comment${isReply ? ' is-reply' : ''}`}>
      {isReply ? <span className="feed-reply-mark" aria-hidden="true">↳</span> : null}
      <Avatar person={comment.author} cls="feed-avatar small" />
      <div className="feed-comment-main">
        <p>
          <strong>{comment.author.name}</strong>
          {comment.body}
        </p>
        <small>
          {timeLabel(comment.createdAt)} ·{' '}
          <button
            type="button"
            className="feed-reply"
            onClick={() => onReply(comment)}
          >
            Responder
          </button>
        </small>
      </div>
      {comment.canDelete ? (
        <button
          type="button"
          className="feed-comment-del"
          title="Excluir comentário"
          onClick={() => onDelete(comment)}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

export default function PostCard({
  post,
  index = 0,
  me,
  manager,
  replyTo,
  commentsOpen,
  draft,
  liking,
  onLike,
  onToggleComments,
  onReply,
  onCancelReply,
  onDraft,
  onSubmitComment,
  onDeletePost,
  onDeleteComment,
  onOpenImage,
}) {
  const stats =
    post.kind === 'digest' && post.meta?.stats ? (
      <div className="feed-stat-row">
        {post.meta.stats.map((item, index) => (
          <span key={index} className="feed-stat">
            <strong>{item.value}</strong>
            {item.label}
          </span>
        ))}
      </div>
    ) : null;

  const mine = Boolean(post.author.id && me?.id && post.author.id === me.id);
  const moderation = post.canDelete && manager && !mine && post.kind !== 'digest';
  const meta =
    post.kind === 'digest'
      ? 'Gerado automaticamente'
      : `${timeDetail(post.createdAt)}${post.author.sector ? ` · ${post.author.sector}` : ''}`;

  const comments = post.comments || [];
  const tops = comments.filter(comment => !comment.parentId);
  const repliesOf = id => comments.filter(comment => comment.parentId === id);
  const likers = likersText(post);
  const likes = Number(post.likes) || 0;

  return (
    <article className="feed-post" style={{ '--i': index }}>
      <header className="feed-post-head">
        <Avatar person={post.author} />
        <div className="feed-post-who">
          <strong>{post.author.name}</strong>
          <small>{meta}</small>
        </div>
        {badgeFor(post)}
        {post.canDelete ? (
          <button
            className={`feed-post-menu${moderation ? ' is-moderate' : ''}`}
            type="button"
            title={moderation ? 'Remover publicação e avisar o autor' : 'Excluir publicação'}
            aria-label={moderation ? 'Remover publicação e avisar o autor' : 'Excluir publicação'}
            onClick={() => onDeletePost(post)}
          >
            {moderation ? '⚠' : '…'}
          </button>
        ) : null}
      </header>
      {post.title ? <h3 className="feed-post-title">{post.title}</h3> : null}
      {post.body ? (
        <p className="feed-post-body">
          {String(post.body)
            .split('\n')
            .map((line, index) => (
              <Fragment key={index}>
                {index ? <br /> : null}
                {line}
              </Fragment>
            ))}
        </p>
      ) : null}
      {stats}
      <MediaGrid items={post.media || []} onOpenImage={onOpenImage} />
      <footer className="feed-actions">
        <button
          type="button"
          className={`feed-action${post.liked ? ' is-liked' : ''}`}
          aria-pressed={post.liked ? 'true' : 'false'}
          title={post.liked ? 'Descurtir' : 'Curtir'}
          aria-label={post.liked ? 'Descurtir' : 'Curtir'}
          disabled={liking}
          onClick={() => onLike(post)}
        >
          <span>♥</span>
          <b>{likes}</b> <em>{post.liked ? 'Curtido' : 'Curtir'}</em>
        </button>
        <button type="button" className="feed-action" onClick={() => onToggleComments(post)}>
          <span>💬</span>
          {comments.length ? <b>{comments.length}</b> : null} <em>Comentar</em>
        </button>
      </footer>
      <p className={`feed-likers${likers ? '' : ' hidden'}`}>{likers ? `Curtido por ${likers}` : ''}</p>
      <div className={`feed-comments${commentsOpen ? '' : ' hidden'}`}>
        <div className="feed-comment-list">
          {tops.map(comment => {
            const replies = repliesOf(comment.id);
            return (
              <Fragment key={comment.id}>
                <Comment comment={comment} onReply={onReply} onDelete={onDeleteComment} />
                {replies.length ? (
                  <div className="feed-replies">
                    {replies.map(reply => (
                      <Comment
                        key={reply.id}
                        comment={reply}
                        isReply
                        onReply={onReply}
                        onDelete={onDeleteComment}
                      />
                    ))}
                  </div>
                ) : null}
              </Fragment>
            );
          })}
        </div>
        <form
          className="feed-comment-form"
          onSubmit={event => {
            event.preventDefault();
            onSubmitComment(post);
          }}
        >
          {replyTo && replyTo.postId === post.id ? (
            <div className="feed-reply-slot">
              <span className="feed-reply-chip">
                Respondendo a <strong>{replyTo.name}</strong>
                <button type="button" onClick={onCancelReply} aria-label="Cancelar resposta">
                  ×
                </button>
              </span>
            </div>
          ) : null}
          <Avatar person={me} cls="feed-avatar small" />
          <input
            type="text"
            maxLength={2000}
            placeholder="Escreva um comentário..."
            aria-label="Comentário"
            value={draft || ''}
            onChange={event => onDraft(post.id, event.target.value)}
          />
          <button className="button button-secondary" type="submit">
            Enviar
          </button>
        </form>
      </div>
    </article>
  );
}
