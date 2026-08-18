import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { zproWebhookRouter } from './routes/zproWebhook.js';
import { adminRouter } from './routes/admin.js';
import { createRequestId, logError, logInfo, sanitizeHeaders } from './lib/logging.js';
import { getFollowupWorkerStatus, startFollowupWorker } from './services/followupWorker.js';

const app = express();

function captureRawBody(req, res, buf) {
  if (buf?.length) req.rawBody = buf.toString('utf8');
}

app.use(cors());

app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || createRequestId();
  logInfo('http.request.received', {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    headers: sanitizeHeaders(req.headers),
  });
  next();
});

app.use(express.json({ limit: '5mb', verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, limit: '5mb', verify: captureRawBody }));
app.use(express.raw({ type: '*/*', limit: '5mb', verify: captureRawBody }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'central-ia-crm-backend',
    mode: process.env.APP_MODE || 'live',
    time: new Date().toISOString(),
    followups: getFollowupWorkerStatus(),
  });
});

app.use('/webhooks/zpro', zproWebhookRouter);

app.use('/api', adminRouter);

app.use((err, req, res, next) => {
  const statusCode = Number(err.statusCode || err.status || 500);

  logError('http.request.error', {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    statusCode,
    error: err.message || String(err),
    stack: err.stack,
  });

  res.status(statusCode).json({
    ok: false,
    error: statusCode >= 500 ? 'Erro interno do backend' : err.message || String(err),
    message: err.message || String(err),
    detail: String(err.message || err),
  });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Central IA CRM Backend rodando na porta ${port}`);
  startFollowupWorker();
});
