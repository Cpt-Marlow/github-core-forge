// A local development entry: the same app main.ts builds, listening on a fixed port so the kit's
// runner (sdk/run.ts) can drive it without an env. Not used in a trial.

import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 8099);
const server = createApp();
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[dev] listening on ${port}\n`);
});
