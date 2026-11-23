import { useEffect, useRef, useState } from 'react';

export default function ModerationDialog({ post, onClose, onConfirm }) {
  const dialogRef = useRef(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (post && !dialog.open) {
      setReason('');
      dialog.showModal();
    }
    if (!post && dialog.open) dialog.close();
  }, [post]);

  if (!post) return null;

  const submit = async event => {
    event.preventDefault();
    if (reason.trim().length < 3 || saving) return;
    setSaving(true);
    await onConfirm(post, reason.trim());
    setSaving(false);
  };

  return (
    <dialog id="feedModerationDialog" className="feed-moderation-dialog" ref={dialogRef}>
      <form className="feed-moderation-form" onSubmit={submit}>
        <div className="dialog-header">
          <div>
            <p className="eyebrow">MODERAÇÃO</p>
            <h2>Remover publicação</h2>
          </div>
          <button type="button" className="close-button" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="feed-moderation-note">
          A publicação de <strong>{post.author.name || 'pessoa'}</strong> será removida do mural. O autor
          receberá um aviso com o motivo informado.
        </p>
        <blockquote>{(post.title || post.body || 'Publicação com mídia').slice(0, 220)}</blockquote>
        <label>
          Motivo da remoção
          <textarea
            rows={3}
            maxLength={500}
            required
            placeholder="Ex.: conteúdo inadequado, informação sensível, fora do tema..."
            value={reason}
            onChange={event => setReason(event.target.value)}
            autoFocus
          />
        </label>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button className="button button-danger" type="submit" disabled={saving}>
            Remover e avisar autor
          </button>
        </div>
      </form>
    </dialog>
  );
}
