import { useEffect } from 'react';

export default function Lightbox({ item, onClose }) {
  useEffect(() => {
    document.body.classList.toggle('feed-lightbox-open', Boolean(item));
    return () => document.body.classList.remove('feed-lightbox-open');
  }, [item]);

  if (!item) return null;
  return (
    <div
      id="feedLightbox"
      className="feed-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Visualizar imagem"
      onClick={event => {
        if (event.target.id === 'feedLightbox') onClose();
      }}
    >
      <button type="button" className="feed-lightbox-close" aria-label="Fechar" onClick={onClose}>
        ×
      </button>
      <figure>
        <img src={item.url} alt={item.name || 'Imagem'} />
        <figcaption>{item.name || ''}</figcaption>
      </figure>
    </div>
  );
}
