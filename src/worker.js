// Cloudflare Workers entry. Every request runs here first (assets.run_worker_first), so the
// session check happens before any static file is served from env.ASSETS.
import { createApp } from './app.js';
import { d1Driver } from './db/drivers.js';
import { createRepo } from './db/repo.js';

const app = createApp({
  repo: env => createRepo(d1Driver(env.DB)),
  assets: async (request, env) => {
    if (!env.ASSETS) return null;
    const res = await env.ASSETS.fetch(request);
    return res.status === 404 ? null : res;
  },
});

export default {
  fetch: (request, env, ctx) => app.fetch(request, { ...env, RUNTIME: 'worker' }, ctx),
  scheduled: (event, env, ctx) => { ctx.waitUntil(app.scheduled(event, { ...env, RUNTIME: 'worker' })); },
};
