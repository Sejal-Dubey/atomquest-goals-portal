import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  ArrowRight,
  BellRing,
  BookOpen,
  BadgeCheck,
  Building2,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  FileDown,
  FileClock,
  Gauge,
  Goal,
  Lock,
  MessageSquareWarning,
  ShieldCheck,
  Share2,
  Siren,
  Mail,
  Plus,
  RefreshCcw,
  Save,
  Send,
  Sparkles,
  Trash2,
  Unlock,
  UserRound,
  UsersRound
} from 'lucide-react';
import './styles.css';

type Role = 'Employee' | 'Manager' | 'Admin' | 'Setup';
type SheetStatus = 'Draft' | 'Submitted' | 'ReturnedForRework' | 'Approved';
type UomType = 'Numeric' | 'Percentage' | 'Timeline' | 'ZeroBased';
type GoalDirection = 'Min' | 'Max';
type ProgressStatus = 'NotStarted' | 'OnTrack' | 'Completed';
type Tab = 'dashboard' | 'sheet' | 'checkin';

type GoalItem = {
  id?: string;
  thrustArea: string;
  title: string;
  description: string;
  uomType: UomType;
  direction: GoalDirection;
  target: number;
  weightage: number;
  actualAchievement?: number;
  progressStatus?: ProgressStatus;
  score?: number;
  sharedTemplateId?: string | null;
};

type GoalSheet = {
  id: string;
  employeeName?: string;
  cycleName: string;
  status: SheetStatus;
  isLocked: boolean;
  managerComment?: string | null;
  goals: GoalItem[];
};

type ValidationResult = { isValid: boolean; errors: string[] };
type SharedTemplate = {
  id: string;
  title: string;
  description: string;
  target: number;
  uomType: UomType;
  direction: GoalDirection;
};

type DashboardData = {
  employee: { name: string; department: string };
  cycle: { name: string; currentWindow: string; status: string };
  goalSheetStatus: SheetStatus;
  isLocked: boolean;
  managerComment?: string | null;
  totalGoals: number;
  totalWeightage: number;
  validation: ValidationResult;
  pendingAction: string;
};

const API = import.meta.env.VITE_API_BASE_URL ?? import.meta.env.VITE_API_URL ?? 'http://localhost:5000';
const employeeHeaders = { 'X-Demo-Role': 'Employee' };
const headersFor = (role: Role) => ({ 'X-Demo-Role': role === 'Setup' ? 'Admin' : role });

const emptyGoal = (): GoalItem => ({
  thrustArea: 'Revenue Growth',
  title: '',
  description: '',
  uomType: 'Numeric',
  direction: 'Min',
  target: 0,
  weightage: 10,
  progressStatus: 'NotStarted',
  sharedTemplateId: null
});

function App() {
  const [role, setRole] = useState<Role>('Setup');
  const [tab, setTab] = useState<Tab>('dashboard');
  const [sheet, setSheet] = useState<GoalSheet | null>(null);
  const [draftGoals, setDraftGoals] = useState<GoalItem[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [sharedTemplates, setSharedTemplates] = useState<SharedTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  const totalWeight = useMemo(() => draftGoals.reduce((sum, g) => sum + Number(g.weightage || 0), 0), [draftGoals]);
  const validation = useMemo<ValidationResult>(() => validateLocal(draftGoals), [draftGoals]);
  const locked = sheet?.isLocked || sheet?.status === 'Submitted' || sheet?.status === 'Approved';
  const canEdit = !locked;

  async function loadAll() {
    setLoading(true);
    setError('');
    try {
      const [sheetRes, dashRes, sharedRes] = await Promise.all([
        fetch(`${API}/goalsheets/me`, { headers: employeeHeaders }),
        fetch(`${API}/employee/dashboard`, { headers: employeeHeaders }),
        fetch(`${API}/shared-goals/available`)
      ]);
      if (!sheetRes.ok) throw new Error('Could not load goal sheet. Please confirm the API is running on port 5000.');
      const nextSheet: GoalSheet = await sheetRes.json();
      setSheet(nextSheet);
      setDraftGoals(nextSheet.goals.map(cleanGoalFromApi));
      if (dashRes.ok) setDashboard(await dashRes.json());
      if (sharedRes.ok) setSharedTemplates(await sharedRes.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong while loading data.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (role === 'Employee') loadAll();
  }, [role]);

  function updateGoal(index: number, patch: Partial<GoalItem>) {
    setDraftGoals(prev => prev.map((goal, i) => {
      if (i !== index) return goal;
      const next = { ...goal, ...patch };
      if (patch.sharedTemplateId) {
        const template = sharedTemplates.find(t => t.id === patch.sharedTemplateId);
        if (template) {
          next.title = template.title;
          next.description = template.description;
          next.target = Number(template.target);
          next.uomType = template.uomType;
          next.direction = template.direction;
        }
      }
      if (patch.sharedTemplateId === null) {
        next.title = '';
        next.description = '';
        next.target = 0;
        next.uomType = 'Numeric';
        next.direction = 'Min';
      }
      return next;
    }));
  }

  async function saveDraft(showToast = true): Promise<GoalSheet> {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`${API}/goalsheets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...employeeHeaders },
        body: JSON.stringify({ goals: draftGoals.map(goalPayload) })
      });
      if (!res.ok) throw new Error(await responseMessage(res));
      const updated = await res.json();
      setSheet(updated);
      setDraftGoals(updated.goals.map(cleanGoalFromApi));
      if (showToast) setToast('Draft saved successfully.');
      await refreshDashboardOnly();
      return updated;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save draft.';
      setError(message);
      throw new Error(message);
    } finally {
      setSaving(false);
    }
  }

  async function submitSheet() {
    if (!sheet) return;
    setSaving(true);
    setError('');
    try {
      // Critical fix: when a sheet is Returned for Rework, first save it back as Draft,
      // then submit the freshly returned sheet id/state. Do not submit stale React state.
      const savedSheet = await saveDraft(false);
      const res = await fetch(`${API}/goalsheets/${savedSheet.id}/submit`, { method: 'POST', headers: employeeHeaders });
      if (!res.ok) throw new Error(await responseMessage(res));
      const updated = await res.json();
      setSheet(updated);
      setDraftGoals(updated.goals.map(cleanGoalFromApi));
      setToast('Submitted for manager review. Editing is now locked.');
      setTab('dashboard');
      await refreshDashboardOnly();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit goal sheet.');
    } finally {
      setSaving(false);
    }
  }

  async function updateQuarterlyGoal(goalId: string, actualAchievement: number, status: ProgressStatus) {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`${API}/goals/${goalId}/quarterly-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...employeeHeaders },
        body: JSON.stringify({ actualAchievement: Number(actualAchievement), status, completionDate: null })
      });
      if (!res.ok) throw new Error(await responseMessage(res));
      const updatedGoal = await res.json();
      setSheet(prev => prev ? { ...prev, goals: prev.goals.map(g => g.id === goalId ? cleanGoalFromApi(updatedGoal) : g) } : prev);
      setDraftGoals(prev => prev.map(g => g.id === goalId ? cleanGoalFromApi(updatedGoal) : g));
      setToast('Progress updated successfully.');
      await refreshDashboardOnly();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save Q1 update.');
    } finally {
      setSaving(false);
    }
  }

  async function refreshDashboardOnly() {
    const res = await fetch(`${API}/employee/dashboard`, { headers: employeeHeaders });
    if (res.ok) setDashboard(await res.json());
  }

  if (role === 'Manager') {
    return <ManagerWorkspace role={role} setRole={setRole} />;
  }

  if (role === 'Admin') {
    return <AdminWorkspace role={role} setRole={setRole} />;
  }

  if (role === 'Setup') {
    return <SetupWorkspace role={role} setRole={setRole} />;
  }

  return <main>
    <ShellHeader role={role} setRole={setRole} />

    {toast && <div className="toast" onAnimationEnd={() => setToast('')}><CheckCircle2 size={18} /> {toast}</div>}
    {error && <div className="error"><AlertTriangle size={18} /> {error}</div>}

    <section className="hero-card">
      <div>
        <p className="eyebrow">Performance Cycle</p>
        <h1>Employee Workspace</h1>
        <p className="hero-subtitle">Create goals, submit them for manager review, and update quarterly progress.</p>
      </div>
      <StatusPill status={sheet?.status ?? 'Draft'} locked={Boolean(sheet?.isLocked)} />
    </section>

    <nav className="page-tabs">
      <button className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')}><Gauge size={16} /> Dashboard</button>
      <button className={tab === 'sheet' ? 'active' : ''} onClick={() => setTab('sheet')}><Goal size={16} /> Goal Sheet</button>
      <button className={tab === 'checkin' ? 'active' : ''} onClick={() => setTab('checkin')}><ClipboardCheck size={16} /> Q1 Check-in</button>
    </nav>

    {loading && <div className="card skeleton">Loading employee workspace…</div>}

    {!loading && tab === 'dashboard' && dashboard && sheet && <EmployeeDashboard dashboard={dashboard} sheet={sheet} setTab={setTab} validation={validation} />}

    {!loading && tab === 'sheet' && sheet && <GoalSheetEditor
      sheet={sheet}
      goals={draftGoals}
      sharedTemplates={sharedTemplates}
      canEdit={canEdit}
      validation={validation}
      totalWeight={totalWeight}
      saving={saving}
      updateGoal={updateGoal}
      addGoal={() => setDraftGoals(prev => [...prev, emptyGoal()])}
      removeGoal={(index) => setDraftGoals(prev => prev.filter((_, i) => i !== index))}
      saveDraft={saveDraft}
      submitSheet={submitSheet}
    />}

    {!loading && tab === 'checkin' && sheet && <CheckinPanel sheet={sheet} saving={saving} updateQuarterlyGoal={updateQuarterlyGoal} />}
  </main>;
}

function ShellHeader({ role, setRole }: { role: Role; setRole: (role: Role) => void }) {
  return <header className="topbar">
    <div className="brand">
      <div className="brand-icon">AQ</div>
      <div>
        <h2>AtomQuest Goals Portal</h2>
        <p>Enterprise goal planning, review, and performance tracking</p>
      </div>
    </div>
    <div className="roles">
      {(['Setup', 'Employee', 'Manager', 'Admin'] as Role[]).map(r => <button key={r} onClick={() => setRole(r)} className={role === r ? 'active' : ''}>{r}</button>)}
    </div>
  </header>;
}


function SetupWorkspace({ role, setRole }: { role: Role; setRole: (role: Role) => void }) {
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  async function resetDemoData() {
    setError('');
    try {
      const res = await fetch(`${API}/demo/reset`, { method: 'POST', headers: headersFor('Admin') });
      if (!res.ok) throw new Error(await responseMessage(res));
      setToast('Demo data reset. Start with Employee → Goal Sheet.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset demo data.');
    }
  }

  const steps = [
    ['1', 'Employee', 'Create or edit goals. Keep total weightage at 100%, then submit for manager review.'],
    ['2', 'Manager', 'Open Approval Inbox, review the sheet, and return once with feedback.'],
    ['3', 'Employee', 'Apply the feedback, save the draft, and submit again.'],
    ['4', 'Manager', 'Fine-tune target or weightage, then approve and lock the sheet.'],
    ['5', 'Employee', 'Open Q1 Check-in, enter actuals, and save progress scores.'],
    ['6', 'Manager', 'Complete the team Q1 check-in with a comment.'],
    ['7', 'Admin', 'Review analytics, completion, audit trail, notifications, escalations, shared KPIs, and export CSV.']
  ];

  return <main>
    <ShellHeader role={role} setRole={setRole} />
    {toast && <div className="toast" onAnimationEnd={() => setToast('')}><CheckCircle2 size={18} /> {toast}</div>}
    {error && <div className="error"><AlertTriangle size={18} /> {error}</div>}

    <section className="hero-card admin-hero">
      <div>
        <p className="eyebrow">Demo Setup</p>
        <h1>Judge-ready walkthrough</h1>
        <p className="hero-subtitle">Use this page first to reset the sample data and follow the intended end-to-end evaluation flow.</p>
      </div>
      <button className="secondary danger-soft" onClick={resetDemoData}><Sparkles size={16} /> Reset Demo Data</button>
    </section>

    <section className="demo-guide-grid">
      <div className="card span2 employee-card">
        <div>
          <p className="eyebrow">Recommended Flow</p>
          <h2>Seven-step demo path</h2>
          <p>This keeps the app clean for judges: setup first, then Employee → Manager → Employee → Manager → Admin.</p>
        </div>
        <button onClick={() => setRole('Employee')}><ArrowRight size={16} /> Start as Employee</button>
      </div>

      <div className="card span2">
        <h3>Walkthrough checklist</h3>
        <div className="demo-steps">
          {steps.map(([no, owner, copy]) => <div className="demo-step" key={no}>
            <b>{no}</b>
            <span><strong>{owner}</strong><small>{copy}</small></span>
          </div>)}
        </div>
      </div>

      <div className="card span2 admin-action-strip">
        <button className="secondary" onClick={() => setRole('Employee')}><UserRound size={16} /> Employee Workspace</button>
        <button className="secondary" onClick={() => setRole('Manager')}><UsersRound size={16} /> Manager Workspace</button>
        <button className="secondary" onClick={() => setRole('Admin')}><ShieldCheck size={16} /> Admin Workspace</button>
      </div>
    </section>
  </main>;
}

function EmployeeDashboard({ dashboard, sheet, setTab, validation }: { dashboard: DashboardData; sheet: GoalSheet; setTab: (tab: Tab) => void; validation: ValidationResult }) {
  return <section className="dashboard-grid">
    <div className="card employee-card span2">
      <div>
        <p className="eyebrow">Welcome back</p>
        <h2>{dashboard.employee.name}</h2>
        <p>{dashboard.employee.department} • {dashboard.cycle.name} • {dashboard.cycle.currentWindow} window is {dashboard.cycle.status}</p>
      </div>
      <button onClick={() => setTab('sheet')}>{sheet.status === 'Approved' ? 'View Approved Goals' : 'Continue Goal Sheet'} <ArrowRight size={16} /></button>
    </div>

    <MetricCard label="Goal Sheet Status" value={dashboard.goalSheetStatus} icon={<UserRound size={18} />} />
    <MetricCard label="Total Goals" value={String(dashboard.totalGoals)} icon={<Goal size={18} />} />
    <MetricCard label="Total Weightage" value={`${dashboard.totalWeightage}%`} icon={<Gauge size={18} />} intent={dashboard.totalWeightage === 100 ? 'good' : 'warn'} />
    <MetricCard label="Lock State" value={dashboard.isLocked ? 'Locked' : 'Editable'} icon={dashboard.isLocked ? <Lock size={18} /> : <Unlock size={18} />} />

    <div className="card span2 action-card">
      <div>
        <h3>Pending action</h3>
        <p>{dashboard.pendingAction}</p>
        {dashboard.managerComment && <div className="manager-note"><MessageSquareWarning size={18} /><span><b>Manager feedback:</b> {dashboard.managerComment}</span></div>}
      </div>
      <ValidationPanel validation={validation} />
    </div>

    <div className="card span2 timeline-card">
      <h3><CalendarClock size={18} /> Performance Cycle Timeline</h3>
      <div className="timeline">
        {['Goal Planning — May', 'Q1 Review — July', 'Q2 Review — October', 'Q3 Review — January', 'Annual Review — March-April'].map((item, i) => <div key={item} className={i === 0 ? 'current' : ''}>{item}</div>)}
      </div>
    </div>
  </section>;
}

function GoalSheetEditor(props: {
  sheet: GoalSheet;
  goals: GoalItem[];
  sharedTemplates: SharedTemplate[];
  canEdit: boolean;
  validation: ValidationResult;
  totalWeight: number;
  saving: boolean;
  updateGoal: (index: number, patch: Partial<GoalItem>) => void;
  addGoal: () => void;
  removeGoal: (index: number) => void;
  saveDraft: () => void;
  submitSheet: () => void;
}) {
  const { sheet, goals, sharedTemplates, canEdit, validation, totalWeight, saving, updateGoal, addGoal, removeGoal, saveDraft, submitSheet } = props;
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (selectedIndex > goals.length - 1) setSelectedIndex(Math.max(0, goals.length - 1));
  }, [goals.length, selectedIndex]);

  const selectedGoal = goals[selectedIndex] ?? goals[0];

  return <section className="editor-layout">
    <div className="card span2 editor-header">
      <div>
        <p className="eyebrow">Goal Planning</p>
        <h2>Employee Goal Sheet</h2>
        <p>Define your goals, assign weightage, and submit them for manager review.</p>
      </div>
      <WeightageMeter total={totalWeight} valid={validation.isValid} />
    </div>

    {sheet.managerComment && <div className="card span2 manager-note"><MessageSquareWarning size={18} /><span><b>Returned for rework:</b> {sheet.managerComment}</span></div>}

    {sheet.status === 'Submitted' && <div className="card span2 info-lock"><Lock size={18} /> This sheet has been submitted for manager review. Editing is locked until it is returned or approved.</div>}
    {sheet.status === 'Approved' && <div className="card span2 info-lock success"><BadgeCheck size={18} /> This sheet is approved and locked. Changes require HR/Admin intervention.</div>}

    <div className="goal-builder span2">
      <aside className="card goal-stack">
        <div className="stack-head">
          <div>
            <p className="eyebrow">Goal stack</p>
            <h3>{goals.length}/8 goals</h3>
          </div>
          <span className={validation.isValid ? 'mini-badge good' : 'mini-badge warn'}>{totalWeight}%</span>
        </div>

        <div className="goal-stack-list">
          {goals.map((goal, index) => {
            const isSelected = index === selectedIndex;
            const isShared = Boolean(goal.sharedTemplateId);
            return <button
              key={goal.id ?? index}
              type="button"
              className={`goal-stack-item ${isSelected ? 'selected' : ''}`}
              onClick={() => setSelectedIndex(index)}
            >
              <div className="goal-stack-number">{index + 1}</div>
              <div className="goal-stack-copy">
                <b>{goal.title || 'Untitled goal'}</b>
                <small>{goal.thrustArea} • {goal.weightage}% weightage</small>
              </div>
              <span className={isShared ? 'tiny-chip shared' : 'tiny-chip'}>{isShared ? 'Shared' : 'Own'}</span>
            </button>;
          })}
        </div>

        <button className="secondary full-width" disabled={!canEdit || goals.length >= 8} onClick={() => { addGoal(); setSelectedIndex(goals.length); }}>
          <Plus size={16} /> Add another goal
        </button>
      </aside>

      <section className="card goal-detail-panel">
        {selectedGoal ? <GoalDetailPanel
          index={selectedIndex}
          goal={selectedGoal}
          sharedTemplates={sharedTemplates}
          canEdit={canEdit}
          updateGoal={updateGoal}
          removeGoal={removeGoal}
          canRemove={goals.length > 1 && canEdit}
        /> : <div>No goal selected.</div>}
      </section>
    </div>

    <div className="card span2 footer-actions sticky-actions">
      <ValidationPanel validation={validation} />
      <div className="push" />
      <button className="secondary" disabled={!canEdit || saving} onClick={saveDraft}><Save size={16} /> Save Draft</button>
      <button disabled={!canEdit || !validation.isValid || saving} onClick={submitSheet}><Send size={16} /> Submit for Manager Review</button>
    </div>
  </section>;
}

function GoalDetailPanel({ index, goal, sharedTemplates, canEdit, updateGoal, removeGoal, canRemove }: {
  index: number;
  goal: GoalItem;
  sharedTemplates: SharedTemplate[];
  canEdit: boolean;
  updateGoal: (index: number, patch: Partial<GoalItem>) => void;
  removeGoal: (index: number) => void;
  canRemove: boolean;
}) {
  const isShared = Boolean(goal.sharedTemplateId);
  return <div>
    <div className="goal-detail-head">
      <div>
        <p className="eyebrow">Goal Details</p>
        <h3>{goal.title || 'New goal'}</h3>
        <p>{isShared ? 'Shared KPI fields are locked from the template. Employee can only tune weightage.' : 'Individual goal. Employee can edit all details before submission.'}</p>
      </div>
      <div className={isShared ? 'shared-chip' : 'individual-chip'}>{isShared ? 'Shared KPI' : 'Individual'}</div>
    </div>

    <div className="smart-form-grid">
      <label>Goal Source
        <select disabled={!canEdit} value={goal.sharedTemplateId ?? ''} onChange={e => updateGoal(index, { sharedTemplateId: e.target.value ? e.target.value : null })}>
          <option value="">Individual Goal</option>
          {sharedTemplates.map(t => <option key={t.id} value={t.id}>Shared KPI: {t.title}</option>)}
        </select>
      </label>

      <label>Thrust Area
        <select disabled={!canEdit || isShared} value={goal.thrustArea} onChange={e => updateGoal(index, { thrustArea: e.target.value })}>
          <option>Revenue Growth</option>
          <option>Customer Experience</option>
          <option>Operational Excellence</option>
          <option>People Development</option>
          <option>Quality & Compliance</option>
        </select>
      </label>

      <label className="full">Goal Title {isShared && <small>Read-only from shared KPI</small>}
        <input disabled={!canEdit || isShared} value={goal.title} onChange={e => updateGoal(index, { title: e.target.value })} placeholder="Example: Increase enterprise revenue" />
      </label>

      <label className="full">Description {isShared && <small>Read-only from shared KPI</small>}
        <textarea disabled={!canEdit || isShared} value={goal.description} onChange={e => updateGoal(index, { description: e.target.value })} placeholder="What outcome does this goal drive?" />
      </label>

      <label>UoM Type {isShared && <small>Locked</small>}
        <select disabled={!canEdit || isShared} value={goal.uomType} onChange={e => updateGoal(index, { uomType: e.target.value as UomType })}>
          <option value="Numeric">Numeric</option>
          <option value="Percentage">Percentage</option>
          <option value="Timeline">Timeline</option>
          <option value="ZeroBased">Zero-based</option>
        </select>
      </label>

      <label>Success Measure
        <select disabled={!canEdit || isShared || goal.uomType === 'ZeroBased' || goal.uomType === 'Timeline'} value={goal.direction} onChange={e => updateGoal(index, { direction: e.target.value as GoalDirection })}>
          <option value="Min">Higher value is better</option>
          <option value="Max">Lower value is better</option>
        </select>
      </label>

      <label>Target {isShared && <small>Read-only</small>}
        <input disabled={!canEdit || isShared} type="number" value={goal.target} onChange={e => updateGoal(index, { target: Number(e.target.value) })} />
      </label>

      <label>Weightage %
        <input disabled={!canEdit} type="number" min="10" value={goal.weightage} onChange={e => updateGoal(index, { weightage: Number(e.target.value) })} />
      </label>
    </div>

    <div className="goal-detail-footer">
      <div className="helper-box">
        {isShared ? 'Shared KPI lock active: title, description, target, unit, and success measure come from the template.' : 'Tip: keep the goal clear, measurable, and aligned to the selected thrust area.'}
      </div>
      <button className="danger ghost" disabled={!canRemove} onClick={() => removeGoal(index)}><Trash2 size={16} /> Remove goal</button>
    </div>
  </div>;
}

function CheckinPanel({ sheet, saving, updateQuarterlyGoal }: {
  sheet: GoalSheet;
  saving: boolean;
  updateQuarterlyGoal: (goalId: string, actualAchievement: number, status: ProgressStatus) => Promise<void>;
}) {
  const approved = sheet.status === 'Approved';
  const [local, setLocal] = useState<Record<string, { actualAchievement: string; status: ProgressStatus }>>({});

  useEffect(() => {
    const next: Record<string, { actualAchievement: string; status: ProgressStatus }> = {};
    sheet.goals.forEach((goal, index) => {
      const key = goal.id ?? String(index);
      next[key] = {
        actualAchievement: String(Number(goal.actualAchievement ?? 0)),
        status: goal.progressStatus ?? 'NotStarted'
      };
    });
    setLocal(next);
  }, [sheet.id, sheet.status, sheet.goals.length]);

  const scoredGoals = sheet.goals.filter(goal => goal.score !== undefined && goal.score !== null).length;
  const averageScore = scoredGoals === 0 ? 0 : Math.round(sheet.goals.reduce((sum, goal) => sum + Number(goal.score ?? 0), 0) / scoredGoals);

  return <section className="checkin-workspace">
    <div className="card span2 checkin-hero-card">
      <div>
        <p className="eyebrow">Quarterly Check-in</p>
        <h2><ClipboardCheck size={22} /> Quarterly Check-in</h2>
        <p>Update actual achievement against approved targets. Scores are calculated automatically.</p>
      </div>
      <div className="score-summary">
        <span>{scoredGoals}/{sheet.goals.length} updated</span>
        <b>{scoredGoals === 0 ? 'Pending approval' : `${averageScore}% avg score`}</b>
      </div>
    </div>

    {!approved && <div className="card span2 info-lock"><Lock size={18} /> Quarterly progress updates will unlock after your manager approves the goal sheet.</div>}

    <div className="checkin-grid">
      {sheet.goals.map((goal, index) => {
        const key = goal.id ?? String(index);
        const value = local[key] ?? { actualAchievement: String(Number(goal.actualAchievement ?? 0)), status: goal.progressStatus ?? 'NotStarted' };
        const score = goal.score == null ? '—' : `${Math.round(Number(goal.score))}%`;
        return <div className="card checkin-goal-card" key={key}>
          <div className="goal-card-head">
            <div>
              <p className="eyebrow">Goal {index + 1} • {goal.thrustArea}</p>
              <h3>{goal.title}</h3>
              <p>{scoreFormulaLabel(goal)}</p>
            </div>
            <div className={`status-chip ${scoreTone(goal.score)}`}>{score}</div>
          </div>

          <div className="checkin-metrics">
            <div><small>Planned Target</small><b>{goal.target}</b></div>
            <div><small>UoM</small><b>{goal.uomType}</b></div>
            <div><small>Weightage</small><b>{goal.weightage}%</b></div>
          </div>

          <div className="checkin-inputs">
            <label>Actual Achievement
              <input
                disabled={!approved}
                type="number"
                min="0"
                value={value.actualAchievement}
                onFocus={() => {
                  if (value.actualAchievement === '0') {
                    setLocal(prev => ({ ...prev, [key]: { ...value, actualAchievement: '' } }));
                  }
                }}
                onChange={e => {
                  const cleaned = e.target.value.replace(/^0+(?=\d)/, '');
                  setLocal(prev => ({ ...prev, [key]: { ...value, actualAchievement: cleaned } }));
                }}
                onBlur={() => {
                  if (value.actualAchievement === '') {
                    setLocal(prev => ({ ...prev, [key]: { ...value, actualAchievement: '0' } }));
                  }
                }}
              />
            </label>
            <label>Status
              <select disabled={!approved} value={value.status} onChange={e => setLocal(prev => ({ ...prev, [key]: { ...value, status: e.target.value as ProgressStatus } }))}>
                <option value="NotStarted">Not Started</option>
                <option value="OnTrack">On Track</option>
                <option value="Completed">Completed</option>
              </select>
            </label>
            <button disabled={!approved || saving || !goal.id} onClick={() => updateQuarterlyGoal(goal.id!, Number(value.actualAchievement || 0), value.status)}><Save size={16} /> Save Progress</button>
          </div>
        </div>;
      })}
    </div>
  </section>;
}


type ManagerTab = 'dashboard' | 'inbox' | 'review' | 'checkins';
type ManagerDashboardData = {
  manager: { name: string; department: string };
  totalTeamMembers: number;
  totalGoalSheets: number;
  draftGoalSheets: number;
  pendingApprovals: number;
  returnedForRework: number;
  approvedGoalSheets: number;
  approvalCompletionPct: number;
  completedCheckIns: number;
  pendingAction: string;
};

function ManagerWorkspace({ role, setRole }: { role: Role; setRole: (role: Role) => void }) {
  const [tab, setTab] = useState<ManagerTab>('dashboard');
  const [dashboard, setDashboard] = useState<ManagerDashboardData | null>(null);
  const [sheets, setSheets] = useState<GoalSheet[]>([]);
  const [selectedSheet, setSelectedSheet] = useState<GoalSheet | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  async function loadManagerData() {
    setLoading(true);
    setError('');
    try {
      const [dashRes, sheetsRes] = await Promise.all([
        fetch(`${API}/manager/dashboard`, { headers: headersFor('Manager') }),
        fetch(`${API}/manager/team-sheets`, { headers: headersFor('Manager') })
      ]);
      if (!dashRes.ok) throw new Error(await responseMessage(dashRes));
      if (!sheetsRes.ok) throw new Error(await responseMessage(sheetsRes));
      const nextDashboard = await dashRes.json();
      const nextSheets = await sheetsRes.json();
      setDashboard(nextDashboard);
      setSheets(nextSheets);
      if (selectedSheet) {
        const refreshed = nextSheets.find((s: GoalSheet) => s.id === selectedSheet.id);
        setSelectedSheet(refreshed ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load manager workspace.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadManagerData(); }, []);

  function reviewSheet(sheet: GoalSheet) {
    setSelectedSheet(sheet);
    setTab('review');
  }

  async function reloadSelected(id: string) {
    const res = await fetch(`${API}/manager/goalsheets/${id}`, { headers: headersFor('Manager') });
    if (res.ok) setSelectedSheet(await res.json());
    await loadManagerData();
  }

  async function inlineEdit(goalId: string, patch: { target?: number; weightage?: number }) {
    setError('');
    try {
      const res = await fetch(`${API}/manager/goals/${goalId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headersFor('Manager') },
        body: JSON.stringify(patch)
      });
      if (!res.ok) throw new Error(await responseMessage(res));
      setToast('Changes saved successfully.');
      if (selectedSheet) await reloadSelected(selectedSheet.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Inline edit failed.');
    }
  }

  async function approveSheet(sheetId: string) {
    setError('');
    try {
      const res = await fetch(`${API}/manager/goalsheets/${sheetId}/approve`, { method: 'POST', headers: headersFor('Manager') });
      if (!res.ok) throw new Error(await responseMessage(res));
      setToast('Approved and locked. Employee edits are now blocked.');
      await reloadSelected(sheetId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed.');
    }
  }

  async function returnForRework(sheetId: string, comment: string) {
    setError('');
    try {
      const res = await fetch(`${API}/manager/goalsheets/${sheetId}/return`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headersFor('Manager') },
        body: JSON.stringify({ comment })
      });
      if (!res.ok) throw new Error(await responseMessage(res));
      setToast('Returned for rework with manager feedback.');
      await reloadSelected(sheetId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Return for rework failed.');
    }
  }

  async function completeCheckin(sheetId: string, comment: string) {
    setError('');
    try {
      const res = await fetch(`${API}/manager/checkins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headersFor('Manager') },
        body: JSON.stringify({ goalSheetId: sheetId, quarter: 'Q1', comment })
      });
      if (!res.ok) throw new Error(await responseMessage(res));
      setToast('Q1 check-in completed successfully.');
      await loadManagerData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete manager check-in.');
    }
  }

  return <main>
    <ShellHeader role={role} setRole={setRole} />
    {toast && <div className="toast" onAnimationEnd={() => setToast('')}><CheckCircle2 size={18} /> {toast}</div>}
    {error && <div className="error"><AlertTriangle size={18} /> {error}</div>}

    <section className="hero-card manager-hero">
      <div>
        <p className="eyebrow">Manager Review & Approval</p>
        <h1>Manager Workspace</h1>
        <p className="hero-subtitle">Review team goals, provide feedback, approve goal sheets, and complete quarterly check-ins.</p>
      </div>
      <button className="secondary" onClick={loadManagerData}><RefreshCcw size={16} /> Refresh</button>
    </section>

    <nav className="page-tabs">
      <button className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')}><Gauge size={16} /> Dashboard</button>
      <button className={tab === 'inbox' ? 'active' : ''} onClick={() => setTab('inbox')}><UsersRound size={16} /> Approval Inbox</button>
      <button className={tab === 'review' ? 'active' : ''} disabled={!selectedSheet} onClick={() => setTab('review')}><ClipboardCheck size={16} /> Review Sheet</button>
      <button className={tab === 'checkins' ? 'active' : ''} onClick={() => setTab('checkins')}><BadgeCheck size={16} /> Team Check-ins</button>
    </nav>

    {loading && <div className="card skeleton">Loading manager workspace…</div>}
    {!loading && tab === 'dashboard' && dashboard && <ManagerDashboard dashboard={dashboard} sheets={sheets} reviewSheet={reviewSheet} setTab={setTab} />}
    {!loading && tab === 'inbox' && <ManagerInbox sheets={sheets} reviewSheet={reviewSheet} />}
    {!loading && tab === 'review' && selectedSheet && <ManagerReviewSheet sheet={selectedSheet} inlineEdit={inlineEdit} approveSheet={approveSheet} returnForRework={returnForRework} />}
    {!loading && tab === 'checkins' && <ManagerCheckins sheets={sheets} completeCheckin={completeCheckin} />}
  </main>;
}

function ManagerDashboard({ dashboard, sheets, reviewSheet, setTab }: { dashboard: ManagerDashboardData; sheets: GoalSheet[]; reviewSheet: (sheet: GoalSheet) => void; setTab: (tab: ManagerTab) => void }) {
  const pending = sheets.filter(s => s.status === 'Submitted');
  return <section className="dashboard-grid">
    <div className="card employee-card span2">
      <div>
        <p className="eyebrow">Manager</p>
        <h2>{dashboard.manager.name}</h2>
        <p>{dashboard.manager.department} • {dashboard.pendingAction}</p>
      </div>
      <button onClick={() => setTab('inbox')}>View Pending Approvals <ArrowRight size={16} /></button>
    </div>
    <MetricCard label="Team Members" value={String(dashboard.totalTeamMembers)} icon={<UsersRound size={18} />} />
    <MetricCard label="Pending Approvals" value={String(dashboard.pendingApprovals)} icon={<ClipboardCheck size={18} />} intent={dashboard.pendingApprovals > 0 ? 'warn' : 'good'} />
    <MetricCard label="Approved Sheets" value={String(dashboard.approvedGoalSheets)} icon={<BadgeCheck size={18} />} intent="good" />
    <MetricCard label="Approval Completion" value={`${dashboard.approvalCompletionPct}%`} icon={<Gauge size={18} />} />

    <div className="card span2">
      <h3>Pending Actions</h3>
      {pending.length === 0 ? <p>No submitted sheets are waiting for review.</p> : <div className="mini-list">
        {pending.map(sheet => <button key={sheet.id} className="mini-row" onClick={() => reviewSheet(sheet)}>
          <span><b>{sheet.employeeName ?? (sheet as any).employee?.name ?? 'Employee'}</b><small>{sheet.goals.length} goals • {sheet.goals.reduce((sum, g) => sum + Number(g.weightage), 0)}% weightage</small></span>
          <ArrowRight size={16} />
        </button>)}
      </div>}
    </div>

  </section>;
}

function ManagerInbox({ sheets, reviewSheet }: { sheets: GoalSheet[]; reviewSheet: (sheet: GoalSheet) => void }) {
  const pendingSheets = sheets.filter(s => s.status === 'Submitted');
  return <section className="card inbox-card">
    <div className="section-title">
      <div>
        <p className="eyebrow">Approval Inbox</p>
        <h2>Submitted goal sheets</h2>
      </div>
      <span>{pendingSheets.length} pending</span>
    </div>
    {pendingSheets.length === 0 ? <div className="empty-state">
      <h3>No goal sheets are pending manager review.</h3>
      <p>Submitted goal sheets will appear here when employees send them for approval.</p>
    </div> : <div className="table-list">
      {pendingSheets.map(sheet => {
        const total = sheet.goals.reduce((sum, g) => sum + Number(g.weightage), 0);
        const employee = (sheet as any).employee?.name ?? sheet.employeeName ?? 'Employee';
        return <button key={sheet.id} className="table-row" onClick={() => reviewSheet(sheet)}>
          <span><b>{employee}</b><small>{(sheet as any).employee?.department ?? 'Sales'}</small></span>
          <span>{sheet.goals.length} goals</span>
          <span className={total === 100 ? 'good-text' : 'bad-text'}>{total}%</span>
          <StatusPill status={sheet.status} locked={sheet.isLocked} />
          <span className="row-action">Open Review <ArrowRight size={16} /></span>
        </button>;
      })}
    </div>}
  </section>;
}

function ManagerReviewSheet({ sheet, inlineEdit, approveSheet, returnForRework }: {
  sheet: GoalSheet;
  inlineEdit: (goalId: string, patch: { target?: number; weightage?: number }) => Promise<void>;
  approveSheet: (sheetId: string) => Promise<void>;
  returnForRework: (sheetId: string, comment: string) => Promise<void>;
}) {
  const [localGoals, setLocalGoals] = useState<GoalItem[]>(sheet.goals.map(cleanGoalFromApi));
  const [comment, setComment] = useState('Please revise the goal targets/weightage and resubmit.');
  const validation = validateLocal(localGoals);
  const canManagerEdit = sheet.status === 'Submitted';

  useEffect(() => { setLocalGoals(sheet.goals.map(cleanGoalFromApi)); }, [sheet.id, sheet.status, sheet.goals.length]);

  function updateLocal(index: number, patch: Partial<GoalItem>) {
    setLocalGoals(prev => prev.map((g, i) => i === index ? { ...g, ...patch } : g));
  }

  return <section className="editor-layout">
    <div className="card span2 editor-header">
      <div>
        <p className="eyebrow">Goal Sheet Review</p>
        <h2>{(sheet as any).employee?.name ?? sheet.employeeName ?? 'Employee'} — {sheet.cycleName}</h2>
        <p>Review goals, adjust targets or weightage, then approve or return with feedback.</p>
      </div>
      <StatusPill status={sheet.status} locked={sheet.isLocked} />
    </div>

    {sheet.status !== 'Submitted' && <div className="card span2 info-lock"><Lock size={18} /> This sheet is {formatStatusLabel(sheet.status)}. Approval actions are available only for submitted sheets.</div>}

    <div className="goal-list span2">
      {localGoals.map((goal, index) => {
        const isShared = Boolean(goal.sharedTemplateId);
        return <div className="goal-card manager-review-card" key={goal.id ?? index}>
          <div className="goal-card-head">
            <div>
              <p className="eyebrow">Goal {index + 1} • {goal.thrustArea}</p>
              <h3>{goal.title}</h3>
              <p>{isShared ? 'Managed centrally by HR/Admin. Only assigned weightage can be adjusted.' : goal.description}</p>
            </div>
            <div className={isShared ? 'shared-chip' : 'individual-chip'}>{isShared ? 'Shared KPI' : 'Individual'}</div>
          </div>
          <div className="manager-edit-grid">
            <label>UoM<input disabled value={goal.uomType} /></label>
            <label>Success Measure<input disabled value={goal.uomType === 'ZeroBased' ? 'Zero exceptions expected' : goal.uomType === 'Timeline' ? 'Milestone completion' : goal.direction === 'Max' ? 'Lower value is better' : 'Higher value is better'} /></label>
            <label>Target {isShared && <small>Locked from shared KPI template</small>}
              <input disabled={!canManagerEdit || isShared} type="number" value={goal.target} onChange={e => updateLocal(index, { target: Number(e.target.value) })} />
            </label>
            <label>Weightage %
              <input disabled={!canManagerEdit} type="number" min="10" value={goal.weightage} onChange={e => updateLocal(index, { weightage: Number(e.target.value) })} />
            </label>
            <button disabled={!canManagerEdit || !goal.id} onClick={() => inlineEdit(goal.id!, { target: Number(goal.target), weightage: Number(goal.weightage) })}>Save Changes</button>
          </div>
        </div>;
      })}
    </div>

    <div className="card span2">
      <ValidationPanel validation={validation} />
    </div>

    <div className="card span2 manager-decision-card">
      <div>
        <h3>Manager Decision</h3>
        <p>Approve the goal sheet to lock it for the cycle, or return it with feedback for employee revision.</p>
      </div>
      <textarea disabled={!canManagerEdit} value={comment} onChange={e => setComment(e.target.value)} />
      <div className="footer-actions compact">
        <button className="secondary" disabled={!canManagerEdit || !comment.trim()} onClick={() => returnForRework(sheet.id, comment)}><MessageSquareWarning size={16} /> Return with Feedback</button>
        <button disabled={!canManagerEdit || !validation.isValid} onClick={() => approveSheet(sheet.id)}><BadgeCheck size={16} /> Approve & Lock</button>
      </div>
    </div>
  </section>;
}


function ManagerCheckins({ sheets, completeCheckin }: { sheets: GoalSheet[]; completeCheckin: (sheetId: string, comment: string) => Promise<void> }) {
  const approved = sheets.filter(s => s.status === 'Approved');
  const [comments, setComments] = useState<Record<string, string>>({});

  return <section className="checkin-workspace">
    <div className="card span2 editor-header">
      <div>
        <p className="eyebrow">Team Progress Review</p>
        <h2>Team Q1 Check-ins</h2>
        <p>Review employee progress, compare actuals against approved targets, and record manager feedback.</p>
      </div>
      <span className="status-chip good">{approved.length} approved sheets</span>
    </div>

    {approved.length === 0 && <div className="card span2 info-lock"><Lock size={18} /> No approved sheets yet. Approve an employee goal sheet first to unlock check-ins.</div>}

    {approved.map(sheet => {
      const employee = (sheet as any).employee?.name ?? sheet.employeeName ?? 'Employee';
      const scoredGoals = sheet.goals.filter(g => g.score != null);
      const allScored = sheet.goals.length > 0 && scoredGoals.length === sheet.goals.length;
      const avg = scoredGoals.length === 0 ? null : Math.round(scoredGoals.reduce((sum, g) => sum + Number(g.score ?? 0), 0) / scoredGoals.length);
      const comment = comments[sheet.id] ?? '';
      return <div className="card span2 manager-checkin-card" key={sheet.id}>
        <div className="section-title">
          <div>
            <p className="eyebrow">Q1 Progress Summary</p>
            <h2>{employee}</h2>
          </div>
          <span>{avg == null ? 'Awaiting update' : `${avg}% avg score`}</span>
        </div>
        <div className="checkin-review-table">
          {sheet.goals.map((goal, index) => <div className="checkin-review-row" key={goal.id ?? index}>
            <span><b>{goal.title}</b><small>{goal.thrustArea}</small></span>
            <span>Plan: {goal.target}</span>
            <span>Actual: {goal.actualAchievement ?? 'Awaiting update'}</span>
            <span>Status: {formatProgress(goal.progressStatus)}</span>
            <span className={`${scoreTone(goal.score)}-text`}>Score: {goal.score == null ? 'Pending' : `${Math.round(Number(goal.score))}%`}</span>
          </div>)}
        </div>
        {!allScored && <div className="info-lock subtle"><Lock size={16} /> Q1 check-in can be completed after the employee submits progress updates for all goals.</div>}
        <textarea placeholder="Add manager feedback after reviewing employee progress." value={comment} onChange={e => setComments(prev => ({ ...prev, [sheet.id]: e.target.value }))} />
        <div className="footer-actions compact">
          <button disabled={!allScored || !comment.trim()} onClick={() => completeCheckin(sheet.id, comment)}><BadgeCheck size={16} /> Complete Q1 Check-in</button>
        </div>
      </div>;
    })}
  </section>;
}


type AdminTab = 'dashboard' | 'analytics' | 'completion' | 'audit' | 'shared' | 'escalations' | 'notifications' | 'guide';
type AdminDashboardData = {
  totalGoalSheets: number;
  submittedGoalSheets: number;
  returnedGoalSheets: number;
  approvedGoalSheets: number;
  approvalCompletionPct: number;
  completedCheckIns: number;
  openEscalations?: number;
  notifications?: number;
  auditEvents: AuditEvent[];
};
type CompletionRow = {
  employeeId: string;
  employee: string;
  department: string;
  manager: string;
  goalSheetId?: string | null;
  goalSheetStatus: string;
  goals: number;
  weightage: number;
  isLocked: boolean;
  q1Status: string;
  lastUpdated?: string | null;
};
type AuditEvent = {
  id: string;
  actor?: string;
  actorUserId?: string;
  entityName: string;
  entityId: string;
  action: string;
  oldValue?: string | null;
  newValue?: string | null;
  createdAtUtc: string;
};

type NotificationItem = {
  id: string;
  recipient: string;
  recipientRole: Role;
  channel: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAtUtc: string;
};

type EscalationItem = {
  id: string;
  ruleName: string;
  severity: string;
  subject: string;
  owner: string;
  ownerRole: Role;
  status: string;
  nextAction: string;
  createdAtUtc: string;
};


type AnalyticsGroup = { label: string; count: number; weightage?: number };
type AnalyticsGoal = { title: string; employee: string; score: number; thrustArea: string };
type AnalyticsData = {
  averageScore: number;
  scoredGoals: number;
  totalGoals: number;
  goalSheets: number;
  approvalCompletionPct: number;
  checkInCompletionPct: number;
  submittedSheets: number;
  returnedSheets: number;
  approvedSheets: number;
  openEscalations: number;
  notificationCount: number;
  goalsByThrustArea: AnalyticsGroup[];
  goalsByStatus: AnalyticsGroup[];
  scoreBands: AnalyticsGroup[];
  topGoals: AnalyticsGoal[];
  lowGoals: AnalyticsGoal[];
};

type SharedGoalForm = {
  title: string;
  description: string;
  target: number;
  uomType: UomType;
  direction: GoalDirection;
};

function AdminWorkspace({ role, setRole }: { role: Role; setRole: (role: Role) => void }) {
  const [tab, setTab] = useState<AdminTab>('dashboard');
  const [dashboard, setDashboard] = useState<AdminDashboardData | null>(null);
  const [completion, setCompletion] = useState<CompletionRow[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditEvent[]>([]);
  const [sharedTemplates, setSharedTemplates] = useState<SharedTemplate[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [escalations, setEscalations] = useState<EscalationItem[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [form, setForm] = useState<SharedGoalForm>({ title: 'Reduce warranty claims', description: 'Track and reduce warranty claim rate across the department.', target: 2, uomType: 'Percentage', direction: 'Max' });
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  async function loadAdminData() {
    setLoading(true);
    setError('');
    try {
      const [dashRes, completionRes, auditRes, sharedRes, notificationRes, escalationRes, analyticsRes] = await Promise.all([
        fetch(`${API}/admin/dashboard`, { headers: headersFor('Admin') }),
        fetch(`${API}/admin/completion-dashboard`, { headers: headersFor('Admin') }),
        fetch(`${API}/admin/audit-logs`, { headers: headersFor('Admin') }),
        fetch(`${API}/shared-goals/available`),
        fetch(`${API}/admin/notifications`, { headers: headersFor('Admin') }),
        fetch(`${API}/admin/escalations`, { headers: headersFor('Admin') }),
        fetch(`${API}/admin/analytics`, { headers: headersFor('Admin') })
      ]);
      if (!dashRes.ok) throw new Error(await responseMessage(dashRes));
      if (!completionRes.ok) throw new Error(await responseMessage(completionRes));
      setDashboard(await dashRes.json());
      setCompletion(await completionRes.json());
      if (auditRes.ok) setAuditLogs(await auditRes.json());
      if (sharedRes.ok) setSharedTemplates(await sharedRes.json());
      if (notificationRes.ok) setNotifications(await notificationRes.json());
      if (escalationRes.ok) setEscalations(await escalationRes.json());
      if (analyticsRes.ok) setAnalytics(await analyticsRes.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load HR/Admin workspace.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAdminData(); }, []);

  async function exportCsv() {
    setError('');
    try {
      const res = await fetch(`${API}/admin/export-achievements`, { headers: headersFor('Admin') });
      if (!res.ok) throw new Error(await responseMessage(res));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'atomquest-achievement-report.csv';
      a.click();
      URL.revokeObjectURL(url);
      setToast('CSV/Excel-compatible achievement report downloaded.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.');
    }
  }

  async function unlockSheet(row: CompletionRow) {
    if (!row.goalSheetId) return;
    setError('');
    try {
      const res = await fetch(`${API}/admin/goalsheets/${row.goalSheetId}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headersFor('Admin') },
        body: JSON.stringify({ reason: 'HR/Admin exception unlock: employee can revise and resubmit.' })
      });
      if (!res.ok) throw new Error(await responseMessage(res));
      setToast(`${row.employee}'s sheet unlocked and audit trail updated.`);
      await loadAdminData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlock sheet.');
    }
  }

  async function createSharedGoal() {
    setError('');
    try {
      if (!form.title.trim()) throw new Error('Shared KPI title is required.');
      if (Number.isNaN(Number(form.target)) || Number(form.target) < 0) throw new Error('Target must be zero or greater.');
      const primaryOwnerId = completion[0]?.employeeId;
      const res = await fetch(`${API}/admin/shared-goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headersFor('Admin') },
        body: JSON.stringify({ ...form, target: Number(form.target), primaryOwnerId })
      });
      if (!res.ok) throw new Error(await responseMessage(res));
      setToast(`Shared KPI “${form.title}” created. Switch to Employee → Goal Sheet → Goal Source to use it.`);
      setForm({ title: '', description: '', target: 0, uomType: 'Numeric', direction: 'Min' });
      await loadAdminData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create shared KPI.');
    }
  }


  async function runEscalationCheck() {
    setError('');
    try {
      const res = await fetch(`${API}/admin/escalations/run`, {
        method: 'POST',
        headers: { ...headersFor('Admin') }
      });
      if (!res.ok) throw new Error(await responseMessage(res));
      const data = await res.json();
      setToast(`Escalation check completed. ${data.created ?? data.Created ?? 0} action(s) generated.`);
      await loadAdminData();
      setTab('escalations');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not run escalation check.');
    }
  }

  async function resetDemoData() {
    setError('');
    try {
      const res = await fetch(`${API}/demo/reset`, { method: 'POST', headers: headersFor('Admin') });
      if (!res.ok) throw new Error(await responseMessage(res));
      setToast('Demo data reset. Start the guided workflow from Setup.');
      setRole('Setup');
      await loadAdminData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset demo data.');
    }
  }

  return <main>
    <ShellHeader role={role} setRole={setRole} />
    {toast && <div className="toast" onAnimationEnd={() => setToast('')}><CheckCircle2 size={18} /> {toast}</div>}
    {error && <div className="error"><AlertTriangle size={18} /> {error}</div>}

    <section className="hero-card admin-hero">
      <div>
        <p className="eyebrow">HR Governance & Analytics</p>
        <h1>HR/Admin Workspace</h1>
        <p className="hero-subtitle">Monitor completion, reporting, reusable KPIs, audit history, escalations, and outbound notifications from one workspace.</p>
      </div>
      <div className="hero-actions">
        <button className="secondary" onClick={loadAdminData}><RefreshCcw size={16} /> Refresh</button>
        <button className="secondary danger-soft" onClick={resetDemoData}><Sparkles size={16} /> Reset Demo Data</button>
      </div>
    </section>

    <nav className="page-tabs">
      <button className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')}><ShieldCheck size={16} /> Dashboard</button>
      <button className={tab === 'analytics' ? 'active' : ''} onClick={() => setTab('analytics')}><Gauge size={16} /> Analytics</button>
      <button className={tab === 'completion' ? 'active' : ''} onClick={() => setTab('completion')}><ClipboardCheck size={16} /> Completion</button>
      <button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}><FileClock size={16} /> Audit Trail</button>
      <button className={tab === 'shared' ? 'active' : ''} onClick={() => setTab('shared')}><Share2 size={16} /> Shared KPIs</button>
      <button className={tab === 'escalations' ? 'active' : ''} onClick={() => setTab('escalations')}><Siren size={16} /> Escalations</button>
      <button className={tab === 'notifications' ? 'active' : ''} onClick={() => setTab('notifications')}><BellRing size={16} /> Notifications</button>
    </nav>

    {loading && <div className="card skeleton">Loading HR/Admin workspace…</div>}
    {!loading && dashboard && tab === 'dashboard' && <AdminDashboard dashboard={dashboard} completion={completion} exportCsv={exportCsv} setTab={setTab} />}
    {!loading && tab === 'analytics' && analytics && <AdminAnalytics analytics={analytics} setTab={setTab} />}
    {!loading && tab === 'completion' && <AdminCompletion rows={completion} unlockSheet={unlockSheet} />}
    {!loading && tab === 'audit' && <AdminAudit logs={auditLogs.length ? auditLogs : dashboard?.auditEvents ?? []} />}
    {!loading && tab === 'shared' && <AdminSharedGoals form={form} setForm={setForm} createSharedGoal={createSharedGoal} templates={sharedTemplates} />}
    {!loading && tab === 'escalations' && <AdminEscalations rows={escalations} runEscalationCheck={runEscalationCheck} />}
    {!loading && tab === 'notifications' && <AdminNotifications rows={notifications} />}
  </main>;
}


function AdminAnalytics({ analytics, setTab }: { analytics: AnalyticsData; setTab: (tab: AdminTab) => void }) {
  const maxThrust = Math.max(1, ...analytics.goalsByThrustArea.map(x => x.count));
  const maxStatus = Math.max(1, ...analytics.goalsByStatus.map(x => x.count));
  const maxBand = Math.max(1, ...analytics.scoreBands.map(x => x.count));
  return <section className="analytics-grid">
    <div className="card span2 employee-card">
      <div>
        <p className="eyebrow">Decision Analytics</p>
        <h2>Performance insights</h2>
        <p>Summarizes goal distribution, score bands, and exceptions for leadership review.</p>
      </div>
      <button onClick={() => setTab('completion')}><ClipboardCheck size={16} /> View Completion</button>
    </div>

    <MetricCard label="Average Q1 Score" value={`${Math.round(analytics.averageScore)}%`} icon={<Gauge size={18} />} intent={analytics.averageScore >= 90 ? 'good' : analytics.averageScore >= 70 ? 'warn' : 'bad'} />
    <MetricCard label="Scored Goals" value={`${analytics.scoredGoals}/${analytics.totalGoals}`} icon={<Goal size={18} />} />
    <MetricCard label="Approval Completion" value={`${analytics.approvalCompletionPct}%`} icon={<BadgeCheck size={18} />} intent={analytics.approvalCompletionPct >= 90 ? 'good' : 'warn'} />
    <MetricCard label="Q1 Check-in Completion" value={`${analytics.checkInCompletionPct}%`} icon={<ClipboardCheck size={18} />} intent={analytics.checkInCompletionPct >= 90 ? 'good' : 'warn'} />

    <div className="card analytics-panel">
      <h3>Goals by thrust area</h3>
      <div className="bar-list">
        {analytics.goalsByThrustArea.map(row => <AnalyticsBar key={row.label} label={row.label} value={row.count} max={maxThrust} note={row.weightage != null ? `${row.weightage}% weightage` : undefined} />)}
        {analytics.goalsByThrustArea.length === 0 && <div className="empty-state"><Goal size={22} /> No goals yet. Reset demo data or create a goal sheet.</div>}
      </div>
    </div>

    <div className="card analytics-panel">
      <h3>Workflow status split</h3>
      <div className="bar-list">
        {analytics.goalsByStatus.map(row => <AnalyticsBar key={row.label} label={formatStatusLabel(row.label)} value={row.count} max={maxStatus} />)}
        {analytics.goalsByStatus.length === 0 && <div className="empty-state"><ShieldCheck size={22} /> No sheets found yet.</div>}
      </div>
    </div>

    <div className="card analytics-panel">
      <h3>Score bands</h3>
      <div className="bar-list">
        {analytics.scoreBands.map(row => <AnalyticsBar key={row.label} label={row.label} value={row.count} max={maxBand} tone={row.label.startsWith('Green') ? 'good' : row.label.startsWith('Amber') ? 'warn' : 'bad'} />)}
      </div>
      <p className="muted-copy">Green ≥ 90, amber 70–89, red below 70.</p>
    </div>

    <div className="card analytics-panel">
      <h3>Workflow signals</h3>
      <div className="signal-grid">
        <span><b>{analytics.openEscalations}</b><small>Open escalations</small></span>
        <span><b>{analytics.notificationCount}</b><small>Notification events</small></span>
        <span><b>{analytics.returnedSheets}</b><small>Returned sheets</small></span>
        <span><b>{analytics.submittedSheets}</b><small>Pending approvals</small></span>
      </div>
    </div>

    <div className="card analytics-panel">
      <h3>Top performing goals</h3>
      <GoalRankList rows={analytics.topGoals} empty="Save Q1 actuals to populate top performers." />
    </div>
    <div className="card analytics-panel">
      <h3>Needs attention</h3>
      <GoalRankList rows={analytics.lowGoals} empty="No scored goals yet." />
    </div>
  </section>;
}

function AnalyticsBar({ label, value, max, note, tone }: { label: string; value: number; max: number; note?: string; tone?: 'good' | 'warn' | 'bad' }) {
  const width = Math.max(5, Math.round((value / max) * 100));
  return <div className="bar-row">
    <div className="bar-meta"><b>{label}</b><span>{value}{note ? ` • ${note}` : ''}</span></div>
    <div className={`analytics-meter ${tone ?? ''}`}><i style={{ width: `${width}%` }} /></div>
  </div>;
}

function GoalRankList({ rows, empty }: { rows: AnalyticsGoal[]; empty: string }) {
  const visibleRows = rows.filter(row => Number(row.score) > 0);
  return <div className="mini-list">
    {visibleRows.map(row => <div className="mini-row static" key={`${row.employee}-${row.title}-${row.score}`}>
      <span><b>{row.title}</b><small>{row.employee} • {row.thrustArea}</small></span>
      <span className={`${scoreTone(row.score)}-text score-pill`}>{Math.round(row.score)}%</span>
    </div>)}
    {visibleRows.length === 0 && <div className="empty-state"><Gauge size={22} /> {empty}</div>}
  </div>;
}

function AdminDashboard({ dashboard, completion, exportCsv, setTab }: { dashboard: AdminDashboardData; completion: CompletionRow[]; exportCsv: () => void; setTab: (tab: AdminTab) => void }) {
  const pendingApprovals = completion.filter(r => r.goalSheetStatus === 'Submitted').length;
  const openExceptions = completion.filter(r => r.goalSheetStatus === 'ReturnedForRework' || r.q1Status === 'Pending').length;
  return <section className="dashboard-grid">
    <div className="card employee-card span2">
      <div>
        <p className="eyebrow">HR Command Center</p>
        <h2>Governance overview</h2>
        <p>Track goal-sheet completion, approvals, Q1 check-ins, exceptions, and audit-ready reporting.</p>
      </div>
      <button onClick={exportCsv}><FileDown size={16} /> Export CSV</button>
    </div>
    <MetricCard label="Goal Sheets" value={String(dashboard.totalGoalSheets)} icon={<Building2 size={18} />} />
    <MetricCard label="Pending Review" value={String(pendingApprovals)} icon={<Send size={18} />} intent={pendingApprovals > 0 ? 'warn' : undefined} />
    <MetricCard label="Approved" value={String(dashboard.approvedGoalSheets)} icon={<BadgeCheck size={18} />} intent="good" />
    <MetricCard label="Approval Rate" value={`${dashboard.approvalCompletionPct}%`} icon={<Gauge size={18} />} intent={dashboard.approvalCompletionPct >= 90 ? 'good' : 'warn'} />
    <MetricCard label="Q1 Completed" value={String(dashboard.completedCheckIns)} icon={<ClipboardCheck size={18} />} />
    <MetricCard label="Exceptions" value={String(openExceptions)} icon={<AlertTriangle size={18} />} intent={openExceptions > 0 ? 'warn' : 'good'} />
    <MetricCard label="Escalations" value={String(dashboard.openEscalations ?? 0)} icon={<Siren size={18} />} intent={(dashboard.openEscalations ?? 0) > 0 ? 'warn' : undefined} />
    <MetricCard label="Notifications" value={String(dashboard.notifications ?? 0)} icon={<BellRing size={18} />} />

    <div className="card span2 admin-overview-note">
      <div>
        <h3>Recommended review path</h3>
        <p>Start with Completion, inspect Audit Trail for traceability, then use Analytics for performance insights.</p>
      </div>
      <div className="inline-actions">
        <button className="secondary" onClick={() => setTab('completion')}><ClipboardCheck size={16} /> Completion</button>
        <button className="secondary" onClick={() => setTab('analytics')}><Gauge size={16} /> Analytics</button>
        <button className="secondary" onClick={() => setTab('audit')}><FileClock size={16} /> Audit Trail</button>
      </div>
    </div>
  </section>;
}

function AdminCompletion({ rows, unlockSheet }: { rows: CompletionRow[]; unlockSheet: (row: CompletionRow) => void }) {
  return <section className="card admin-table-card">
    <div className="section-title">
      <div>
        <p className="eyebrow">Completion Dashboard</p>
        <h2>Employee and manager compliance</h2>
      </div>
      <span>{rows.length} employees</span>
    </div>
    <div className="admin-table">
      <div className="admin-table-head"><span>Employee</span><span>Manager</span><span>Sheet</span><span>Q1</span><span>Goals</span><span>Action</span></div>
      {rows.length === 0 && <div className="empty-state"><ClipboardCheck size={22} /> No employee completion records yet. Use Reset Demo Data to restore seeded users.</div>}
      {rows.map(row => <div className="admin-table-row" key={row.employeeId}>
        <span><b>{row.employee}</b><small>{row.department}</small></span>
        <span>{row.manager}</span>
        <span><StatusLabel value={row.goalSheetStatus} /></span>
        <span><StatusLabel value={row.q1Status} /></span>
        <span>{row.goals} goals • {row.weightage}%</span>
        <span><button className="secondary compact-button" disabled={!row.goalSheetId || row.goalSheetStatus !== 'Approved'} onClick={() => unlockSheet(row)}><Unlock size={14} /> {row.goalSheetStatus === 'Approved' ? 'Unlock' : 'Locked'}</button></span>
      </div>)}
    </div>
  </section>;
}

function AdminAudit({ logs }: { logs: AuditEvent[] }) {
  return <section className="card admin-table-card">
    <div className="section-title">
      <div>
        <p className="eyebrow">Append-only Audit Trail</p>
        <h2>Who changed what and when</h2>
      </div>
      <span>{logs.length} latest events</span>
    </div>
    <div className="audit-list">
      {logs.map(log => <div className="audit-row" key={log.id}>
        <div className="audit-dot" />
        <div>
          <b>{formatAuditAction(log.action)}</b>
          <p>{log.actor ?? log.actorUserId ?? 'System'} updated {formatEntityName(log.entityName)}</p>
          <small>{formatDate(log.createdAtUtc)} • {formatAuditChange(log.oldValue, log.newValue)}</small>
        </div>
      </div>)}
      {logs.length === 0 && <div className="empty-state"><FileClock size={22} /> No audit events yet. Save, submit, approve, return, or unlock a sheet to populate this ledger.</div>}
    </div>
  </section>;
}

function AdminSharedGoals({ form, setForm, createSharedGoal, templates }: { form: SharedGoalForm; setForm: (form: SharedGoalForm) => void; createSharedGoal: () => void; templates: SharedTemplate[] }) {
  const canCreate = form.title.trim().length > 0 && Number(form.target) >= 0;
  return <section className="editor-layout">
    <div className="card span2 editor-header">
      <div>
        <p className="eyebrow">Shared KPI Management</p>
        <h2>Shared KPI templates</h2>
        <p>Create reusable department KPIs with locked definitions so employees only adjust weightage.</p>
      </div>
      <span className="status-label good">{templates.length} templates available</span>
    </div>
    <div className="card span2 smart-form-grid">
      <label className="full">Shared KPI Title
        <input value={form.title} placeholder="Example: Reduce warranty claims" onChange={e => setForm({ ...form, title: e.target.value })} />
      </label>
      <label className="full">Description
        <textarea value={form.description} placeholder="Describe the department KPI employees will inherit." onChange={e => setForm({ ...form, description: e.target.value })} />
      </label>
      <label>Target
        <input type="number" value={form.target} onChange={e => setForm({ ...form, target: Number(e.target.value) })} />
      </label>
      <label>UoM Type
        <select value={form.uomType} onChange={e => setForm({ ...form, uomType: e.target.value as UomType })}>
          <option value="Numeric">Numeric</option>
          <option value="Percentage">Percentage</option>
          <option value="Timeline">Timeline</option>
          <option value="ZeroBased">Zero-based</option>
        </select>
      </label>
      <label>Success Measure
        <select value={form.direction} onChange={e => setForm({ ...form, direction: e.target.value as GoalDirection })}>
          <option value="Min">Higher value is better</option>
          <option value="Max">Lower value is better</option>
        </select>
      </label>
      <div className="form-actions full">
        <button disabled={!canCreate} onClick={createSharedGoal}><Share2 size={16} /> Create Shared KPI</button>
        <small>Employees can select this from Goal Source in their goal sheet.</small>
      </div>
    </div>
    <div className="card span2">
      <h3>Available shared KPI templates</h3>
      <div className="mini-list">
        {templates.map(t => <div className="mini-row static" key={t.id}>
          <span><b>{t.title}</b><small>{t.description || 'No description'} • Target {t.target} • {t.uomType} • {directionLabel(t.direction)}</small></span>
          <span className="tiny-chip shared">Shared</span>
        </div>)}
        {templates.length === 0 && <p>No shared KPI templates yet. Create one above, then use it in the Employee Goal Sheet.</p>}
      </div>
    </div>
  </section>;
}


function AdminEscalations({ rows, runEscalationCheck }: { rows: EscalationItem[]; runEscalationCheck: () => void }) {
  return <section className="card admin-table-card">
    <div className="section-title">
      <div>
        <p className="eyebrow">Escalation Monitor</p>
        <h2>Escalation monitor</h2>
        <p>Run checks for missing submissions, delayed approvals, and pending Q1 check-ins.</p>
      </div>
      <button onClick={runEscalationCheck}><Siren size={16} /> Run Escalation Check</button>
    </div>
    <div className="escalation-rule-grid">
      <div><b>Rule 1</b><span>Goal sheet not submitted</span></div>
      <div><b>Rule 2</b><span>Submitted sheet awaiting manager approval</span></div>
      <div><b>Rule 3</b><span>Approved sheet missing Q1 check-in</span></div>
    </div>
    <div className="admin-table escalation-table">
      <div className="admin-table-head"><span>Rule</span><span>Subject</span><span>Owner</span><span>Severity</span><span>Next action</span><span>Status</span></div>
      {rows.map(row => <div className="admin-table-row" key={row.id}>
        <span><b>{row.ruleName}</b><small>{formatDate(row.createdAtUtc)}</small></span>
        <span>{row.subject}</span>
        <span>{row.owner}</span>
        <span><StatusLabel value={row.severity} /></span>
        <span>{row.nextAction}</span>
        <span><StatusLabel value={row.status} /></span>
      </div>)}
    </div>
    {rows.length === 0 && <div className="empty-state"><Siren size={22} /> No escalations found. Current demo data is on track.</div>}
  </section>;
}

function AdminNotifications({ rows }: { rows: NotificationItem[] }) {
  return <section className="card admin-table-card">
    <div className="section-title">
      <div>
        <p className="eyebrow">Notification Center</p>
        <h2>Communication log</h2>
        <p>Shows notification events that would be sent through Microsoft Teams or email in production.</p>
      </div>
      <span>{rows.length} notifications</span>
    </div>
    <div className="notification-list">
      {rows.map(row => <div className="notification-row" key={row.id}>
        <div className="notification-icon">{row.channel === 'Email' ? <Mail size={18} /> : <BellRing size={18} />}</div>
        <div>
          <b>{row.title}</b>
          <p>{row.message}</p>
          <small>{row.channel} → {row.recipient} ({row.recipientRole}) • {formatDate(row.createdAtUtc)}</small>
        </div>
      </div>)}
      {rows.length === 0 && <div className="empty-state"><BellRing size={22} /> No notifications yet. Submit, approve, update check-ins, create KPIs, or run escalations.</div>}
    </div>
  </section>;
}

function DemoGuide({ resetDemoData, setTab, runEscalationCheck }: { resetDemoData: () => void; setTab: (tab: AdminTab) => void; runEscalationCheck: () => void }) {
  const steps = [
    ['1', 'Employee', 'Create/edit goals, keep weightage at 100%, then submit to Manager.'],
    ['2', 'Manager', 'Return once for rework, then employee edits and resubmits.'],
    ['3', 'Manager', 'Edit target/weightage inline, approve, and lock the sheet.'],
    ['4', 'Employee', 'Open Q1 Check-in, enter actuals, and save scores.'],
    ['5', 'Manager', 'Open Team Check-ins, add comment, complete Q1 check-in.'],
    ['6', 'Admin', 'Show Completion, Audit Trail, Notifications, Shared KPIs, Escalations, and CSV export.']
  ];
  return <section className="demo-guide-grid">
    <div className="card span2 employee-card">
      <div>
        <p className="eyebrow">Workspace Setup</p>
        <h2>Demo guide and reset</h2>
        <p>Use this page first during judging. Reset restores the default sample workspace and starts the guided flow.</p>
      </div>
      <button onClick={resetDemoData}><Sparkles size={16} /> Reset Demo Data</button>
    </div>
    <div className="card span2">
      <h3>Best demo path</h3>
      <div className="demo-steps">
        {steps.map(([no, role, copy]) => <div className="demo-step" key={no}>
          <b>{no}</b>
          <span><strong>{role}</strong><small>{copy}</small></span>
        </div>)}
      </div>
    </div>
    <div className="card span2 admin-action-strip">
      <button className="secondary" onClick={() => setTab('completion')}><ClipboardCheck size={16} /> View completion</button>
      <button className="secondary" onClick={() => setTab('audit')}><FileClock size={16} /> View audit trail</button>
      <button className="secondary" onClick={() => setTab('notifications')}><BellRing size={16} /> View notifications</button>
      <button className="secondary" onClick={runEscalationCheck}><Siren size={16} /> Run Escalation Check</button>
    </div>
  </section>;
}

function formatAuditAction(action?: string | null) {
  const value = action || 'Update';
  const labels: Record<string, string> = {
    QuarterlyUpdate: 'Q1 actual updated',
    ApprovedLocked: 'Goal sheet approved',
    ManagerInlineEdit: 'Manager edited goal',
    Submitted: 'Goal sheet submitted',
    ReturnedForRework: 'Returned for rework',
    Unlocked: 'Sheet unlocked',
    Created: 'Created',
    Updated: 'Updated'
  };
  return labels[value] ?? value.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function formatEntityName(entity?: string | null) {
  const value = entity || 'record';
  if (value === 'GoalSheet') return 'goal sheet';
  if (value === 'Goal') return 'goal';
  if (value === 'SharedGoalTemplate') return 'shared KPI template';
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function formatAuditChange(oldValue?: string | null, newValue?: string | null) {
  const next = newValue?.trim();
  const prev = oldValue?.trim();
  if (next && !prev) return next.replace(/Status=NotStarted/g, 'Status=Not Started');
  if (next && prev) return `${prev} → ${next}`.replace(/Status=NotStarted/g, 'Status=Not Started');
  return 'Change captured';
}

function directionLabel(direction: GoalDirection | string) {
  return direction === 'Max' ? 'Lower value is better' : 'Higher value is better';
}

function StatusLabel({ value }: { value: string }) {
  const clean = formatStatusLabel(value || 'Unknown');
  const good = clean === 'Approved' || clean === 'Completed' || clean === 'Low' || clean === 'Resolved';
  const warn = clean === 'Submitted' || clean === 'Pending' || clean === 'Returned' || clean === 'High' || clean === 'Medium' || clean === 'Open';
  const bad = clean === 'Blocked' || clean === 'Critical';
  return <span className={`status-label ${good ? 'good' : warn ? 'warn' : bad ? 'bad' : ''}`}>{clean}</span>;
}

function formatStatusLabel(value?: string | null) {
  if (!value) return 'Unknown';
  return value
    .replace('ReturnedForRework', 'Returned')
    .replace('NotCreated', 'Not Created')
    .replace('NotStarted', 'Not Started')
    .replace('OnTrack', 'On Track');
}

function scoreTone(score?: number | null) {
  if (score == null) return 'neutral';
  if (Number(score) >= 90) return 'good';
  if (Number(score) >= 70) return 'warn';
  return 'bad';
}

function formatDate(value?: string | null) {
  if (!value) return 'No timestamp';
  return new Date(value).toLocaleString();
}

function MetricCard({ label, value, icon, intent }: { label: string; value: string; icon: React.ReactNode; intent?: 'good' | 'warn' | 'bad' }) {
  return <div className={`card metric-card ${intent ?? ''}`}>
    <div className="metric-icon">{icon}</div>
    <p>{label}</p>
    <h3>{value}</h3>
  </div>;
}

function StatusPill({ status, locked }: { status: SheetStatus; locked: boolean }) {
  const label = status === 'ReturnedForRework' ? 'Returned' : status;
  return <div className={`status-pill ${status === 'ReturnedForRework' ? 'returned' : status.toLowerCase()}`}>
    {locked ? <Lock size={16} /> : <Unlock size={16} />}
    <span>{label}</span>
  </div>;
}

function WeightageMeter({ total, valid }: { total: number; valid: boolean }) {
  const capped = Math.min(total, 100);
  return <div className="weightage-box">
    <div className="weightage-head"><span>Total Weightage</span><b>{total}% / 100%</b></div>
    <div className="meter"><i style={{ width: `${capped}%` }} /></div>
    <small className={valid ? 'good-text' : 'bad-text'}>{valid ? 'Ready to submit' : 'Must equal 100%, min 10% each, max 8 goals'}</small>
  </div>;
}

function ValidationPanel({ validation }: { validation: ValidationResult }) {
  return <div className={validation.isValid ? 'validation good' : 'validation bad'}>
    {validation.isValid ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
    <div>
      <b>{validation.isValid ? 'Goal sheet validation passed' : 'Goal sheet validation blockers'}</b>
      {validation.isValid ? <p>Max 8 goals, minimum 10% each, and total weightage = 100%.</p> : <ul>{validation.errors.map(e => <li key={e}>{e}</li>)}</ul>}
    </div>
  </div>;
}

function validateLocal(goals: GoalItem[]): ValidationResult {
  const errors: string[] = [];
  if (goals.length === 0) errors.push('At least one goal is required.');
  if (goals.length > 8) errors.push('A goal sheet can include a maximum of 8 goals.');
  if (goals.some(g => !g.thrustArea?.trim())) errors.push('Every goal needs a thrust area.');
  if (goals.some(g => !g.title?.trim())) errors.push('Every goal needs a title.');
  if (goals.some(g => Number(g.weightage) < 10)) errors.push('Each goal must have at least 10% weightage.');
  if (goals.reduce((sum, g) => sum + Number(g.weightage || 0), 0) !== 100) errors.push('Total weightage must equal 100%.');
  if (goals.some(g => Number(g.target) < 0)) errors.push('Targets cannot be negative.');
  return { isValid: errors.length === 0, errors };
}


function scoreFormulaLabel(goal: GoalItem) {
  if (goal.uomType === 'ZeroBased') return 'Success measure: Zero exceptions expected';
  if (goal.uomType === 'Timeline') return 'Success measure: Milestone completion';
  if (goal.direction === 'Max') return 'Success measure: Lower value is better';
  return 'Success measure: Higher value is better';
}

function formatProgress(status?: ProgressStatus) {
  if (status === 'OnTrack') return 'On Track';
  if (status === 'Completed') return 'Completed';
  return 'Not Started';
}

function cleanGoalFromApi(goal: any): GoalItem {
  return {
    id: goal.id,
    thrustArea: goal.thrustArea ?? '',
    title: goal.title ?? '',
    description: goal.description ?? '',
    uomType: goal.uomType ?? 'Numeric',
    direction: goal.direction ?? 'Min',
    target: Number(goal.target ?? 0),
    weightage: Number(goal.weightage ?? 0),
    actualAchievement: goal.actualAchievement == null ? undefined : Number(goal.actualAchievement),
    progressStatus: goal.progressStatus ?? 'NotStarted',
    score: goal.score == null ? undefined : Number(goal.score),
    sharedTemplateId: goal.sharedTemplateId ?? null
  };
}

function goalPayload(goal: GoalItem) {
  return {
    thrustArea: goal.thrustArea,
    title: goal.title,
    description: goal.description,
    uomType: goal.uomType,
    direction: goal.direction,
    target: Number(goal.target),
    weightage: Number(goal.weightage),
    sharedTemplateId: goal.sharedTemplateId || null
  };
}

async function responseMessage(res: Response) {
  try {
    const body = await res.json();
    if (body.errors) return body.errors.join(' ');
    if (body.message) return body.message;
    return JSON.stringify(body);
  } catch {
    return res.statusText;
  }
}

createRoot(document.getElementById('root')!).render(<App />);
