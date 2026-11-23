import { initials } from '../feedApi.js';

export default function Avatar({ person, cls = 'feed-avatar' }) {
  const photo = String(person?.photo || '');
  const name = person?.name || '';
  return <span className={cls}>{photo ? <img src={photo} alt={name} loading="lazy" /> : initials(name)}</span>;
}
