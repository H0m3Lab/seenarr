import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config.js';
import { migrate } from './db.js';
import { registerRoutes } from './routes.js';
import { startScheduler } from './services/jobs.js';

migrate();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true, bodyLimit: 1024 * 1024 });

await app.register(cookie);
await app.register(rateLimit, { global: false });

app.addHook('onSend', async (_req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https://static.tvmaze.com; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  return payload;
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid input', issues: err.issues });
  const { statusCode, message } = err as { statusCode?: number; message?: string };
  if (statusCode) return reply.code(statusCode).send({ error: message ?? 'Request failed' });
  req.log.error({ err }, 'request failed');
  return reply.code(500).send({ error: 'Something went wrong' });
});

registerRoutes(app);

await app.register(fastifyStatic, { root: fileURLToPath(new URL('../../web/dist', import.meta.url)), wildcard: false });

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/') || req.method !== 'GET') return reply.code(404).send({ error: 'Not found' });
  return reply.sendFile('index.html');
});

await app.listen({ host: '0.0.0.0', port: config.port });
startScheduler();
