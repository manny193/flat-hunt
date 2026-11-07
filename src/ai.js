// AI extraction hook (placeholder). The regex parser in core/logic.js fills rent, BHK, deposit and the
// rest; a model can later correct or complete those fields. Nothing here calls a provider yet: the
// researcher is choosing the model, and enrich() is a no-op unless env.AI_PROVIDER is set.
//
// Interface:
//   enrich(listings, env) -> Promise<Array<{ id, fields, confidence, status }>>
//     listings   listing objects about to be saved by ingest (new or just merged); each has posts[]
//                (latest first, text up to 3,000 chars) plus the regex-extracted fields.
//     returns    one entry per listing the model looked at:
//                  id          listing id
//                  fields      corrections to merge into the listing; only keys in AI_FIELDS are applied
//                  confidence  0..1, stored in listings.ai_confidence
//                  status      'done' | 'failed' | 'skipped' (stored in listings.ai_status)
//
// Constraints a provider must respect (Workers Free): 10 ms CPU per invocation (network wait is free),
// at most 50 subrequests per invocation (ingest already uses ~5), so batch every listing of a page into
// one request, set a short timeout, and on any error return [] so ingest still saves the regex result.

export const AI_FIELDS = ['rent', 'bhk', 'type', 'deposit', 'depositMonths', 'maintenance', 'brokerage', 'brokerageAmount', 'furnishing', 'gender', 'availableFrom', 'society', 'kind'];

/** Providers register here: name -> async (listings, env) => updates. None yet. */
export const PROVIDERS = {};

export async function enrich(listings, env = {}) {
  const name = env.AI_PROVIDER;
  if (!name || !Array.isArray(listings) || !listings.length) return [];
  const provider = PROVIDERS[name];
  if (!provider) { console.warn(`AI_PROVIDER "${String(name).slice(0, 40)}" is not implemented; skipping enrichment`); return []; }
  try {
    const out = await provider(listings, env);
    return (Array.isArray(out) ? out : []).map(u => ({
      id: u?.id,
      fields: Object.fromEntries(Object.entries(u?.fields || {}).filter(([k]) => AI_FIELDS.includes(k))),
      confidence: typeof u?.confidence === 'number' ? Math.max(0, Math.min(1, u.confidence)) : null,
      status: ['done', 'failed', 'skipped'].includes(u?.status) ? u.status : 'done',
    })).filter(u => typeof u.id === 'string');
  } catch (e) {
    console.error('AI enrichment failed; keeping regex fields', e?.message || e);
    return [];
  }
}

/** Admin view of AI extraction (filled in once a provider is wired). */
export async function aiStatus(repo, env) {
  return { provider: env.AI_PROVIDER || null, enabled: !!env.AI_PROVIDER };
}
