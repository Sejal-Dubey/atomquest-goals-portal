# AtomQuest Goals Portal

AtomQuest Goals Portal is a judge-ready enterprise goal planning, manager review, HR governance, and performance tracking proof of concept.

The portal demonstrates an end-to-end goal lifecycle across three business roles:

- Employee
- Manager
- HR/Admin

It supports goal creation, L1 manager review, return-for-rework, approval locking, quarterly progress updates, manager check-ins, HR analytics, audit history, shared KPI templates, escalation monitoring, notification tracking, CSV export, and demo reset.

---

## Submission Deliverables

### 1. Live Hosted Demo URL

**Frontend Portal:**  
https://atomquest-goals-portal-pyqq.vercel.app/

**Backend API Health Check:**  
https://atomquest-goals-portal.onrender.com/health

### 2. Source Code Repository

https://github.com/Sejal-Dubey/atomquest-goals-portal

### 3. Architecture Diagram

The architecture diagram is included separately as a PDF/image.

### 4. Role Access

No login credentials are required.

Judges can switch between journeys directly using the top navigation:

- Setup
- Employee
- Manager
- Admin

This keeps evaluation fast and avoids authentication friction during judging.

---

## Recommended Demo Flow

Use the following path to test the complete workflow.

### 1. Reset Demo Data

Go to:

**Setup**

Click:

**Reset Demo Data**

This restores the default sample workspace so the complete flow can be tested from the beginning.

---

### 2. Employee Creates and Submits Goals

Go to:

**Employee → Goal Sheet**

The employee can:

- Review existing goals
- Add or edit individual goals
- Select shared KPI templates
- Maintain total weightage at 100%
- Save draft
- Submit goals to L1 Manager

Expected result:

- Goal sheet status becomes **Submitted**
- Employee editing is locked
- Manager receives the sheet in **Approval Inbox**

---

### 3. Manager Reviews Submitted Goals

Go to:

**Manager → Approval Inbox**

Open the employee goal sheet.

The manager can:

- Review all goals
- Adjust targets and weightage inline
- Return the sheet for rework with comments
- Approve and lock the sheet

---

### 4. Return for Rework Flow

Go to:

**Manager → Review Sheet**

Click:

**Return for Rework**

Expected result:

- Employee can edit the sheet again
- Manager feedback is visible
- Goal sheet status becomes **Returned**

---

### 5. Employee Resubmits

Go to:

**Employee → Goal Sheet**

Make a small change, then click:

**Submit to L1 Manager**

Expected result:

- Goal sheet status becomes **Submitted** again
- Editing is frozen again
- Manager can review it again

---

### 6. Manager Approves and Locks

Go to:

**Manager → Review Sheet**

Click:

**Approve & Lock**

Expected result:

- Goal sheet status becomes **Approved**
- Employee goal editing is locked
- Quarterly check-in becomes available

---

### 7. Employee Captures Quarterly Progress

Go to:

**Employee → Q1 Check-in**

Enter actual achievement values and save progress.

The backend calculates scores automatically using the goal success measure:

- Higher value is better
- Lower value is better

Example scoring:

- Higher is better: `Score = Actual / Target × 100`
- Lower is better: `Score = Target / Actual × 100`

Score colors:

- Green: `>= 90`
- Amber: `70–89`
- Red: `< 70`

---

### 8. Manager Completes Team Check-in

Go to:

**Manager → Team Check-ins**

The manager can:

- Review planned vs actual performance
- See calculated scores
- Add a structured manager comment
- Complete the quarterly check-in

Expected result:

- Q1 check-in is marked complete
- HR/Admin dashboards update
- Audit trail captures the action
- Notification log captures the action

---

### 9. HR/Admin Governance Review

Go to:

**Admin**

The HR/Admin workspace includes:

- Dashboard
- Analytics
- Completion tracking
- Audit Trail
- Shared KPIs
- Escalations
- Notifications
- CSV export

HR/Admin can review the entire goal cycle from a governance perspective.

---

## Key Features

### Employee Workspace

The employee workspace supports:

- Goal planning
- Draft saving
- Goal submission
- Shared KPI selection
- Return-for-rework correction
- Quarterly actual achievement entry
- Backend-calculated progress score display

### Manager Workspace

The manager workspace supports:

- Approval inbox
- Goal review
- Inline target and weightage edits
- Return for rework with comment
- Approve and lock workflow
- Team quarterly check-in review
- Manager check-in completion

### HR/Admin Workspace

The HR/Admin workspace supports:

- Governance overview
- Performance analytics
- Completion dashboard
- Audit trail
- Shared KPI template management
- Escalation monitoring
- Notification event tracking
- Achievement CSV export
- Demo data reset

---

## Architecture Overview

AtomQuest Goals Portal uses a separated frontend and backend architecture.

```text
+-----------------------------+
|         User Browser         |
|  Employee / Manager / Admin |
+--------------+--------------+
               |
               | HTTPS
               v
+-----------------------------+
|        Frontend App          |
|        React + Vite          |
|        Hosted on Vercel      |
+--------------+--------------+
               |
               | REST API Calls
               v
+-----------------------------+
|        Backend API           |
|    ASP.NET Core Web API      |
|        Hosted on Render      |
+--------------+--------------+
               |
               | In-memory demo data
               v
+-----------------------------+
|       Demo Data Layer        |
| Employees, Goals, Reviews,  |
| Q1 Updates, Audit Events,   |
| Notifications, Escalations  |
+-----------------------------+

```

## Technology Stack

### Frontend

- React
- TypeScript
- Vite
- CSS
- Vercel Hosting

The frontend is responsible for:

- Role-based journey switching
- Employee, Manager, Admin, and Setup views
- Form interactions
- API calls
- Displaying workflow status
- Showing analytics, audit trail, notifications, and score summaries

### Backend

- ASP.NET Core Web API
- C#
- Docker
- Render Hosting

The backend is responsible for:

- Goal lifecycle APIs
- Submission and approval state changes
- Return-for-rework workflow
- Q1 score calculation
- Manager check-in completion
- Audit event creation
- Notification event creation
- Escalation check logic
- Demo reset endpoint
- CSV export endpoint

### Hosting

- Vercel was selected for frontend hosting because it provides fast static deployment for React/Vite applications.
- Render was selected for backend hosting because it supports containerized ASP.NET Core Web API deployment using Docker.
- GitHub is used for source control and deployment integration.

---

## Important API Capabilities

The backend exposes REST APIs for:

- Health check
- Demo reset
- Goal sheet retrieval
- Goal creation and update
- Goal submission
- Manager return for rework
- Manager approval and locking
- Quarterly actual updates
- Manager check-in completion
- Admin analytics
- Completion dashboard
- Audit trail
- Shared KPI templates
- Escalation checks
- Notification log
- CSV export

---

## Workflow State Model

The goal sheet moves through the following states:

- Draft
- Submitted
- Returned
- Submitted again after rework
- Approved
- Q1 In Progress
- Q1 Completed

### State Behavior

#### Draft

- Employee can create and edit goals.
- Employee can save draft.
- Employee can submit the sheet to the manager.

#### Submitted

- Employee editing is locked.
- Manager can review the submitted sheet.
- Manager can approve the sheet or return it for rework.

#### Returned

- Employee editing is unlocked.
- Manager feedback is visible to the employee.
- Employee can update the goals and resubmit.

#### Approved

- Goal sheet is locked.
- Q1 achievement capture becomes available.
- Employee can enter actual achievement values.

#### Q1 Completed

- Manager has completed the quarterly review.
- HR/Admin can view final progress, audit records, notifications, and governance data.

---

## Notification Design

The application includes a notification-ready architecture.

Instead of sending real external emails or Microsoft Teams messages during judging, the system records outbound communication events in the Admin notification center.

This demonstrates where enterprise integrations would connect while keeping the deployed demo stable and reliable.

### Notification Examples

- Goal sheet submitted
- Goal sheet returned for rework
- Goal sheet approved and locked
- Q1 achievement updated
- Manager check-in completed
- Escalation generated

### Planned Production Integrations

- Microsoft Teams webhook
- Email notification service
- Microsoft Entra ID identity integration
- Role-based access control
- Persistent database storage

---

## Escalation Design

The escalation module identifies delayed or incomplete workflow actions.

Current escalation checks include:

- Employee has not submitted goals
- Manager has not approved submitted goals
- Q1 check-in is pending after approval

Escalations appear in the HR/Admin escalation monitor and are also captured as notification-ready events.

---

## Audit Trail

The audit trail records important workflow events in an append-only style.

### Audit Trail Examples

- Goal sheet submitted
- Manager inline edit
- Returned for rework
- Approved and locked
- Quarterly update saved
- Manager check-in completed
- Demo data reset

This supports governance, traceability, and appraisal readiness.

---

## CSV Export

HR/Admin can export achievement data as CSV.

The export includes goal and progress information that can be used for:

- HR reporting
- Appraisal preparation
- Compliance review
- Offline analysis
- Leadership summaries

---

## Demo Reset

The Setup page provides a reset option:

- Reset Demo Data

This is important because it allows the portal to be restored instantly without restarting the backend or redeploying the application.

Backend endpoint:

```http
POST /demo/reset
```

## Why This Architecture Works

This architecture was designed to prioritize:

- Fast evaluation
- Stable hosted demo
- Clear role-based workflows
- Traceable business process
- Backend-driven scoring logic
- Governance visibility
- Deployment simplicity
- Enterprise extensibility

The proof of concept intentionally avoids risky half-integrations such as real authentication or live Teams messaging during judging.

Instead, it shows an integration-ready architecture through:

- Notification events
- Role-based journeys
- Audit logs
- Hosted APIs
- Admin governance dashboards
- Escalation monitoring

---

## Production Roadmap

If extended beyond the hackathon, the next steps would be:

- Microsoft Entra ID authentication
- Role-based authorization
- Persistent database such as PostgreSQL or SQL Server
- Real Microsoft Teams notifications
- Real email notifications
- Manager hierarchy configuration
- Multi-employee goal cycles
- Advanced analytics dashboards
- Excel/PDF reporting
- Cloud storage for appraisal records
