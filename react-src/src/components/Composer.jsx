import { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import { mediaUrl } from '../feedApi.js';

const KINDS = [
  { value: 'post', icon: '▤', label: 'Publicação' },
  { value: 'notice', icon: '◉', label: 'Aviso' },
  { value: 'event', icon: '▦', label: 'Evento' },
];

export default function Composer({
  me,
  displayName,
  staged,
  uploading,
  onUpload,
  onRemove,
  onPublish,
  autoFocus = false,
  onClose,
}) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState('post');
  const [publishing, setPublishing] = useState(false);
  const filesRef = useRef(null);
  const areaRef = useRef(null);

  useEffect(() => {
    if (autoFocus) areaRef.current?.focus();
  }, [autoFocus]);

  const submit = async event => {
    event.preventDefault();
    if (publishing) return;
    setPublishing(true);
    const ok = await onPublish(text.trim(), kind);
    if (ok) {
      setText('');
      setKind('post');
    }
    setPublishing(false);
  };

  return (
    <form className="feed-composer" onSubmit={submit}>
      <div className="feed-composer-head">
        <Avatar person={{ name: displayName, photo: me?.photo }} />
        <div className="feed-composer-who">
          <strong>{displayName}</strong>
          <span>— Compartilhe com a equipe</span>
        </div>
        <div className="feed-kind" role="group" aria-label="Tipo da publicação">
          {KINDS.map(item => (
            <button
              key={item.value}
              type="button"
              className={`feed-kind-chip${kind === item.value ? ' active' : ''}`}
              onClick={() => setKind(item.value)}
            >
              <span aria-hidden="true">{item.icon}</span> {item.label}
            </button>
          ))}
        </div>
        {onClose ? (
          <button
            type="button"
            className="feed-composer-close"
            onClick={onClose}
            title="Recolher"
            aria-label="Recolher compositor"
          >
            ×
          </button>
        ) : null}
      </div>
      <textarea
        ref={areaRef}
        rows={3}
        maxLength={8000}
        placeholder="Conte para a equipe o que está acontecendo..."
        value={text}
        onChange={event => setText(event.target.value)}
      />
      <div className={`feed-preview${staged.length || uploading ? '' : ' hidden'}`}>
        {staged.map(item => (
          <span key={item.key} className="feed-chip">
            {String(item.mime || '').startsWith('image/') ? (
              <img src={mediaUrl(item.media)} alt="" />
            ) : (
              '📎'
            )}
            <span>{item.name}</span>
            <button type="button" data-key={item.key} title="Remover" onClick={() => onRemove(item.key)}>
              ×
            </button>
          </span>
        ))}
        {uploading > 0 ? <span className="feed-chip">Enviando {uploading}…</span> : null}
      </div>
      <div className="feed-composer-foot">
        <label className={`feed-attach${uploading > 0 ? ' is-busy' : ''}`} title="Fotos, vídeos ou arquivos">
          <input
            ref={filesRef}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={event => {
              const files = [...event.target.files];
              event.target.value = '';
              if (files.length) onUpload(files);
            }}
          />
          <span aria-hidden="true">＋</span> Foto ou vídeo
        </label>
        <small>Sem limite de tamanho ou quantidade.</small>
        <button className="button button-primary" type="submit" disabled={publishing}>
          Publicar
        </button>
      </div>
    </form>
  );
}
