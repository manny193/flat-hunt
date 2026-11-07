// Watched Facebook sources. The group scraper (Apify) reads public *groups* only; Facebook *Pages*
// (facebook.com/<name>) are accepted with a warning and left out of the actor input, so they are
// flagged in the admin UI instead of failing silently.
import { HttpError } from './http.js';
import { fnv } from './core/logic.js';

const RESERVED = new Set(['groups', 'profile.php', 'watch', 'marketplace', 'events', 'gaming', 'login', 'share', 'sharer', 'story.php', 'permalink.php', 'photo', 'photo.php', 'reel', 'reels', 'search', 'hashtag']);
export const PAGE_WARNING = 'This is a Facebook Page, not a group. The group scraper cannot read Pages, so it is skipped when runs start.';

/** Classify and normalise one Facebook URL. Returns {url, kind:'group'|'page'} or null. */
export function classifyFacebookUrl(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' || !/(^|\.)facebook\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'groups' && parts[1]) return { url: `https://www.facebook.com/groups/${parts[1]}`, kind: 'group' };
  if (parts[0] === 'pg' && parts[1]) return { url: `https://www.facebook.com/${parts[1]}`, kind: 'page' };
  if (parts.length === 1 && !RESERVED.has(parts[0].toLowerCase()) && /^[A-Za-z0-9.\-]{3,80}$/.test(parts[0])) return { url: `https://www.facebook.com/${parts[0]}`, kind: 'page' };
  return null;
}
export const groupId = url => 'g' + fnv(String(url).toLowerCase());
export const isPage = g => (g?.kind || classifyFacebookUrl(g?.url)?.kind) === 'page';

/** Validate an admin-supplied list. Throws 400 on a bad URL; returns {groups, warnings}. */
export function validateGroups(list) {
  if (!Array.isArray(list) || list.length > 50) throw new HttpError(400, 'bad_groups', 'groups must be a list of at most 50.');
  const warnings = [];
  const groups = list.map((g, i) => {
    const name = (typeof g?.name === 'string' ? g.name.slice(0, 120) : '').trim();
    const c = classifyFacebookUrl(typeof g?.url === 'string' ? g.url.slice(0, 300) : '');
    if (!c) throw new HttpError(400, 'bad_group_url', `Group ${i + 1}: use a facebook.com/groups/… link (paste the full link, like https://www.facebook.com/groups/123).`);
    if (c.kind === 'page') warnings.push({ index: i, url: c.url, warning: PAGE_WARNING });
    return c.kind === 'page' ? { name, url: c.url, active: g?.active !== false, kind: 'page' } : { name, url: c.url, active: g?.active !== false };
  });
  return { groups, warnings };
}

/** Admin view of watched groups, with ids and support flags. */
export function groupsView(list) {
  return (Array.isArray(list) ? list : []).map(g => {
    const page = isPage(g);
    return { id: groupId(g.url), name: g.name || '', url: g.url, active: g.active !== false, kind: page ? 'page' : 'group', supported: !page, ...(page ? { warning: PAGE_WARNING } : {}) };
  });
}
