import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

export const EVAL_ORIGIN = 'http://127.0.0.1:6173';
export const EVAL_PAGE = `${EVAL_ORIGIN}/eval/harness/eval.html`;

export async function startEvalServer(): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: false,
    root: new URL('../../', import.meta.url).pathname, // frontend/
    plugins: [react()],
    worker: { format: 'es' },
    server: { host: '127.0.0.1', port: 6173, strictPort: true },
  });
  await server.listen();
  return server;
}
