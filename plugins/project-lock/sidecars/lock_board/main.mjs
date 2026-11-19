/**
 * Lock & Tooling Antigravity Sidecar entrypoint.
 *
 * Uses `SidecarApp` from `'sidecar_sdk'` when running inside an Antigravity
 * sidecar runtime, and cleanly exports controller/DB/watchdog helpers so
 * `node --test` can unit-test outside Antigravity without needing `sidecar_sdk`.
 */

import { pathToFileURL } from 'node:url';
import { createLockBoardController, createStandaloneHttpServer } from './router.mjs';
import { createWatchdog } from './watchdog.mjs';

export * from './lock_db.mjs';
export * from './tooling_xray.mjs';
export * from './watchdog.mjs';
export * from './router.mjs';

function isSidecarEnv() {
  return Boolean(
    process.env.ANTIGRAVITY_LS_ADDRESS &&
      process.env.ANTIGRAVITY_CSRF_TOKEN &&
      process.env.ANTIGRAVITY_SIDECAR_WEB_PORT
  );
}

export async function startSidecar(options = {}) {
  if (isSidecarEnv()) {
    const { SidecarApp, Response } = await import('sidecar_sdk');
    const app = new SidecarApp();
    const controller = createLockBoardController({ ...options, app });
    const watchdog = createWatchdog({
      dbPath: options.dbPath,
      app,
      intervalMs: options.intervalMs ?? 1000,
    });

    const wrap = (result) =>
      new Response(result.body, {
        status: result.status,
        contentType: result.contentType,
      });

    app.page('/', () => wrap(controller.readStatic('/')));
    app.api('/app.js', () => wrap(controller.readStatic('/app.js')), 'GET');
    app.api('/styles.css', () => wrap(controller.readStatic('/styles.css')), 'GET');
    app.api('/api/state', async (data) => wrap(await controller.handleGetState(data)), 'GET');
    app.api('/api/unlock', async (data) => wrap(await controller.handlePostUnlock(data)), 'POST');
    app.api(
      '/api/queue/cancel',
      async (data) => wrap(await controller.handlePostQueueCancel(data)),
      'POST'
    );
    app.api(
      '/api/auto-wake',
      async (data) => wrap(await controller.handlePostAutoWake(data)),
      'POST'
    );
    app.api(
      '/api/wake',
      async (data) => wrap(await controller.handlePostWake(data)),
      'POST'
    );

    const shutdown = async () => {
      watchdog.stop();
      await app.close();
      process.exit(0);
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());

    watchdog.start();
    const server = await app.run();
    return { mode: 'sidecar', app, server, watchdog, controller };
  }

  const controller = createLockBoardController(options);
  const port = Number(process.env.LOCK_BOARD_PORT ?? options.port ?? 3791);
  const server = createStandaloneHttpServer(controller);
  const watchdog = createWatchdog({
    dbPath: options.dbPath,
    intervalMs: options.intervalMs ?? 1000,
  });

  await new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      process.stdout.write(`[lock_board standalone] listening on http://127.0.0.1:${actualPort}\n`);
      resolve();
    });
  });

  watchdog.start();
  return { mode: 'standalone', server, watchdog, controller };
}

const isMain =
  Boolean(process.argv[1]) &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  startSidecar().catch((err) => {
    console.error('[lock_board] fatal startup error:', err);
    process.exit(1);
  });
}
