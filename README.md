# AtomQuest Goals Portal — Hackathon PoC

A working enterprise goal-setting, L1 manager approval, quarterly check-in, HR governance, analytics, escalation, and notification-ready PoC for Atomberg's goal-management workflow.


## Live Demo

Frontend: https://atomquest-goals-portal-pyqq.vercel.app/  
Backend API Health: https://atomquest-goals-portal.onrender.com/health

## What is implemented

- Employee goal creation with validation: max 8 goals, minimum 10% weightage, total 100%.
- Shared KPI templates: HR creates reusable department KPIs; employees can pull them into sheets.
- L1 Manager review: inline target/weightage edits, return for rework, approve and lock.
- Employee Q1 progress capture: actuals entered by employee, score calculated by backend.
- Manager team check-in: manager reviews planned vs actual and records feedback.
- HR/Admin governance: completion dashboard, audit trail, shared KPI management, escalation monitor, notifications, CSV export.
- Demo reset: restores seeded data instantly through `POST /demo/reset`.
- Notification-ready architecture: in-app communication log plus optional Teams webhook test endpoint.
- Entra-ready configuration placeholders: clean environment variables for future Microsoft Entra ID OIDC integration.

## Tech stack

Frontend: React 19, TypeScript, Vite, Tailwind-style CSS, lucide-react.
Backend: .NET 10 Web API, EF Core 10, in-memory demo DB by default, optional PostgreSQL through connection string.

## Local run

### Backend

```bash
cd backend/AtomQuest.Api
dotnet restore
dotnet run --urls http://localhost:5000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open the Vite URL, normally `http://localhost:5173`.

## Demo path for judges

1. Click **Setup** in the top navigation.
2. Click **Reset Demo Data** so the app starts from a clean seeded state.
3. Go to **Employee → Goal Sheet** and submit the goal sheet.
4. Go to **Manager → Approval Inbox**, open the sheet, return once for rework.
5. Go back to **Employee → Goal Sheet**, edit, then resubmit.
6. Go to **Manager → Review Sheet**, optionally edit target/weightage, then approve and lock.
7. Go to **Employee → Q1 Check-in**, enter actuals, save progress.
8. Go to **Manager → Team Check-ins**, review scores, add feedback, complete check-in.
9. Go to **Admin** and review Analytics, Completion, Audit Trail, Shared KPIs, Escalations, Notifications, and CSV export.

## Deployment

### Backend on Render/Railway-style Docker hosting

Use `backend/AtomQuest.Api/Dockerfile`.

Recommended environment variables:

```bash
ASPNETCORE_ENVIRONMENT=Production
TEAMS_WEBHOOK_URL=optional
ENTRA_AUTHORITY=optional
ENTRA_CLIENT_ID=optional
ConnectionStrings__Postgres=optional
```

If no Postgres connection string is provided, the backend uses the in-memory demo database and `/demo/reset` remains available.

### Frontend on Vercel

Set project root to `frontend`.

Build command:

```bash
npm run build
```

Output directory:

```bash
dist
```

Environment variable:

```bash
VITE_API_BASE_URL=https://YOUR-BACKEND-URL
```

## Optional Teams test

The app works without a real Teams connector. To enable a real webhook test, set `TEAMS_WEBHOOK_URL` on the backend host and call:

```bash
POST /integrations/teams/test
```

Without the variable, the same action is stored in the in-app notification log, which keeps the demo stable.

## Key backend endpoints

- `GET /health`
- `POST /demo/reset`
- `GET /integrations/status`
- `POST /integrations/teams/test`
- `GET /goalsheets/me`
- `POST /goalsheets`
- `POST /goalsheets/{id}/submit`
- `GET /manager/inbox`
- `PATCH /manager/goals/{goalId}`
- `POST /manager/goalsheets/{id}/return`
- `POST /manager/goalsheets/{id}/approve`
- `POST /goals/{goalId}/quarterly-update`
- `POST /manager/checkins`
- `GET /admin/dashboard`
- `GET /admin/export-achievements`

