import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { zproWebhookRouter } from './routes/zproWebhook.js';
import { adminRouter } from './routes/admin.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'central-ia-crm-backend',
    mode: process.env.APP_MODE || 'live',
    time: new Date().toISOString(),
  });
});

app.use('/webhooks/zpro', zproWebhookRouter);

app.use('/api', adminRouter);

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    ok: false,
    error: 'Erro interno do backend',
    detail: String(err.message || err),
  });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Central IA CRM Backend rodando na porta ${port}`);
});