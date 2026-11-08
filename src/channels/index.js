// Alert delivery channels. Each exports { name, send(target, digest, ctx), validateTarget(input) }.
// Telegram (later) plugs in here on the same alert_targets / alert_queue tables (docs/ai/ALERTS.md).
import * as webpush from './webpush.js';

export const channels = { webpush };
