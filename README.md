# Central IA CRM Backend Render

Use `npm.cmd` no PowerShell.

## Local
```powershell
npm.cmd install
copy .env.example .env
npm.cmd run dev
```

Teste: http://localhost:3000/health

## Render
Build Command: `npm install`
Start Command: `npm start`

Webhook Z-PRO:
`https://SEU-SERVICO.onrender.com/webhooks/zpro/WEBHOOK_PUBLIC_ID`

`WEBHOOK_PUBLIC_ID` vem de `crm_ai_integrations.webhook_public_id`.
