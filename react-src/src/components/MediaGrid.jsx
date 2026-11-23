import { mediaUrl, sizeLabel } from '../feedApi.js';

export default function MediaGrid({ items = [], onOpenImage }) {
  if (!items.length) return null;
  return (
    <div className={`feed-media count-${Math.min(items.length, 4)}`}>
      {items.map((item, index) => {
        const url = mediaUrl(item.media);
        const name = item.name || 'arquivo';
        const mime = String(item.mime || '');
        if (mime.startsWith('image/')) {
          return (
            <button
              key={index}
              type="button"
              className="feed-media-item"
              title={`Ampliar ${name}`}
              onClick={() => onOpenImage({ url, name })}
            >
              <img src={url} alt={name} loading="lazy" />
            </button>
          );
        }
        if (mime.startsWith('video/')) {
          return <video key={index} className="feed-media-item" controls preload="metadata" src={url} />;
        }
        return (
          <a key={index} className="feed-media-file" href={url} download={name} target="_blank" rel="noopener">
            📎 <strong>{name}</strong>
            <small>{sizeLabel(item.size)}</small>
          </a>
        );
      })}
    </div>
  );
}
