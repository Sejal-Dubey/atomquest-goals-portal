using System.Globalization;
using System.Text.Json.Serialization;
using System.Net.Http.Json;
using CsvHelper;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHttpClient();

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy => policy
        .AllowAnyOrigin()
        .AllowAnyHeader()
        .AllowAnyMethod());
});

// Prevent EF navigation properties from creating JSON circular reference crashes during demo serialization.
builder.Services.ConfigureHttpJsonOptions(options =>
{
    // Important for React: enums must serialize as strings like "Draft", not numbers like 0.
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
    options.SerializerOptions.ReferenceHandler = ReferenceHandler.IgnoreCycles;
    options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
    options.SerializerOptions.WriteIndented = true;
});

var connectionString = builder.Configuration.GetConnectionString("Postgres");
if (!string.IsNullOrWhiteSpace(connectionString))
{
    builder.Services.AddDbContext<AppDbContext>(options => options.UseNpgsql(connectionString));
}
else
{
    builder.Services.AddDbContext<AppDbContext>(options => options.UseInMemoryDatabase("AtomQuestDemo"));
}

var app = builder.Build();
app.UseCors();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.EnsureCreated();
    SeedData.Run(db);
}

app.MapGet("/health", () => Results.Ok(new { ok = true, app = "AtomQuest PoC API", phase = "Final Hackathon Build" }));

app.MapGet("/integrations/status", (IConfiguration config) => Results.Ok(new
{
    TeamsWebhookConfigured = !string.IsNullOrWhiteSpace(config["TEAMS_WEBHOOK_URL"]),
    EntraAuthorityConfigured = !string.IsNullOrWhiteSpace(config["ENTRA_AUTHORITY"]),
    EntraClientConfigured = !string.IsNullOrWhiteSpace(config["ENTRA_CLIENT_ID"]),
    Mode = "Demo-safe: event log works without paid connectors; webhook can be enabled by environment variable."
}));

app.MapPost("/integrations/teams/test", async (IConfiguration config, IHttpClientFactory httpClientFactory, AppDbContext db) =>
{
    var title = "AtomQuest integration check";
    var message = "Teams notification pipeline is ready for goal approvals, returns, Q1 updates, and escalations.";
    var webhookUrl = config["TEAMS_WEBHOOK_URL"];

    DemoEvents.Notify(db, SeedIds.Manager, UserRole.Manager, "Teams", title, message);
    db.AuditLogs.Add(AuditLog.Create(SeedIds.Admin, "Integration", SeedIds.Manager, "TeamsWebhookTest", null, string.IsNullOrWhiteSpace(webhookUrl) ? "Simulated notification logged" : "Webhook notification attempted"));

    if (string.IsNullOrWhiteSpace(webhookUrl))
    {
        db.SaveChanges();
        return Results.Ok(new { ok = true, mode = "simulated", message = "No TEAMS_WEBHOOK_URL configured. Notification was saved in the in-app communication log." });
    }

    var client = httpClientFactory.CreateClient();
    var response = await client.PostAsJsonAsync(webhookUrl, new { text = $"**{title}**\n\n{message}" });
    db.SaveChanges();

    return response.IsSuccessStatusCode
        ? Results.Ok(new { ok = true, mode = "webhook", message = "Teams webhook accepted the test notification." })
        : Results.Problem($"Teams webhook returned {(int)response.StatusCode}: {response.ReasonPhrase}");
});

app.MapPost("/demo/reset", (AppDbContext db) =>
{
    db.CheckIns.RemoveRange(db.CheckIns);
    db.Goals.RemoveRange(db.Goals);
    db.GoalSheets.RemoveRange(db.GoalSheets);
    db.SharedGoalTemplates.RemoveRange(db.SharedGoalTemplates);
    db.AuditLogs.RemoveRange(db.AuditLogs);
    db.NotificationLogs.RemoveRange(db.NotificationLogs);
    db.EscalationRecords.RemoveRange(db.EscalationRecords);
    db.Users.RemoveRange(db.Users);
    db.SaveChanges();
    SeedData.Run(db);
    return Results.Ok(new { ok = true, message = "Demo data reset. Employee, manager, HR, shared KPI, audit, and notification seed data restored." });
});

app.MapGet("/demo/context", (HttpRequest request, AppDbContext db) =>
{
    var ctx = DemoContext.FromHeaders(request);
    return Results.Ok(new { ctx.Role, ctx.UserId, User = db.Users.FirstOrDefault(u => u.Id == ctx.UserId) });
});

app.MapGet("/cycle/current", () => Results.Ok(new CycleDto(
    "FY26 Goal Setting",
    "Goal Setting",
    "Open",
    "1 May",
    "Employees can create, edit, and submit goal sheets until manager approval."
)));

app.MapGet("/employee/dashboard", (HttpRequest request, AppDbContext db) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Employee) return Results.Forbid();

    var sheet = db.GoalSheets.Include(s => s.Goals).FirstOrDefault(s => s.EmployeeId == ctx.UserId);
    if (sheet is null) return Results.NotFound(new { message = "No goal sheet found." });

    var validation = GoalValidation.Validate(sheet.Goals.Select(GoalDto.FromEntity));
    return Results.Ok(new
    {
        Employee = db.Users.First(u => u.Id == ctx.UserId),
        Cycle = new { Name = sheet.CycleName, CurrentWindow = "Goal Setting", Status = "Open" },
        GoalSheetStatus = sheet.Status,
        sheet.IsLocked,
        sheet.ManagerComment,
        TotalGoals = sheet.Goals.Count,
        TotalWeightage = sheet.Goals.Sum(g => g.Weightage),
        Validation = validation,
        PendingAction = sheet.Status switch
        {
            GoalSheetStatus.Draft => "Complete goal sheet and submit for L1 review",
            GoalSheetStatus.ReturnedForRework => "Review manager feedback, edit goals, and resubmit",
            GoalSheetStatus.Submitted => "Waiting for L1 manager approval",
            GoalSheetStatus.Approved => "Goal sheet is locked. Continue to quarterly check-ins",
            _ => "Review goal sheet"
        }
    });
});

app.MapGet("/shared-goals/available", (AppDbContext db) => Results.Ok(db.SharedGoalTemplates.ToList()));

app.MapGet("/goalsheets/me", (HttpRequest request, AppDbContext db) =>
{
    var ctx = DemoContext.FromHeaders(request);
    var sheet = db.GoalSheets
        .Include(s => s.Employee)
        .Include(s => s.Goals)
        .FirstOrDefault(s => s.EmployeeId == ctx.UserId);
    return sheet is null ? Results.NotFound() : Results.Ok(sheet);
});

app.MapPost("/goalsheets", (HttpRequest request, AppDbContext db, GoalSheetUpsertDto dto) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Employee) return Results.Forbid();

    var normalizedGoals = NormalizeSharedGoals(db, dto.Goals ?? []);
    var validation = GoalValidation.Validate(normalizedGoals);
    if (!validation.IsValid) return Results.BadRequest(validation);

    var existing = db.GoalSheets.Include(s => s.Goals).FirstOrDefault(s => s.EmployeeId == ctx.UserId);
    if (existing is not null && existing.Status == GoalSheetStatus.Approved)
        return Results.BadRequest(new { message = "Approved sheets are locked. Contact HR/Admin for unlock." });
    if (existing is not null && existing.Status == GoalSheetStatus.Submitted)
        return Results.BadRequest(new { message = "Submitted sheets are frozen until the manager returns them or approves them." });

    var sheet = existing ?? new GoalSheet
    {
        Id = Guid.NewGuid(),
        EmployeeId = ctx.UserId,
        CycleName = "FY26",
        Status = GoalSheetStatus.Draft,
        CreatedAtUtc = DateTime.UtcNow
    };

    // If manager returned it, the first employee save converts it back to Draft but keeps the feedback visible until submit.
    if (existing is not null && sheet.Status == GoalSheetStatus.ReturnedForRework)
        sheet.Status = GoalSheetStatus.Draft;

    if (existing is null)
    {
        db.GoalSheets.Add(sheet);
        db.SaveChanges(); // create parent first so child Goal rows have a valid required FK
    }
    else
    {
        // Stable EF fix: remove existing child rows using DbSet, save that delete, then add replacement rows.
        // This avoids required relationship severing crashes from sheet.Goals.Clear().
        var oldGoals = db.Goals.Where(g => g.GoalSheetId == sheet.Id).ToList();
        if (oldGoals.Count > 0)
        {
            db.Goals.RemoveRange(oldGoals);
            db.SaveChanges();
        }
        sheet.Goals = [];
    }

    var newGoals = normalizedGoals.Select(g => new Goal
    {
        Id = Guid.NewGuid(),
        GoalSheetId = sheet.Id,
        SharedTemplateId = g.SharedTemplateId,
        ThrustArea = (g.ThrustArea ?? "").Trim(),
        Title = (g.Title ?? "").Trim(),
        Description = (g.Description ?? "").Trim(),
        UomType = g.UomType,
        Direction = g.Direction,
        Target = g.Target,
        Weightage = g.Weightage,
        ProgressStatus = ProgressStatus.NotStarted
    }).ToList();

    db.Goals.AddRange(newGoals);
    db.AuditLogs.Add(AuditLog.Create(ctx.UserId, "GoalSheet", sheet.Id, "SavedDraft", null, $"Goals={newGoals.Count}, Weightage={newGoals.Sum(g => g.Weightage)}"));
    db.SaveChanges();

    var result = db.GoalSheets.Include(s => s.Employee).Include(s => s.Goals).First(s => s.Id == sheet.Id);
    return Results.Ok(result);
});

app.MapPost("/goalsheets/validate", (AppDbContext db, GoalSheetUpsertDto dto) =>
{
    var normalizedGoals = NormalizeSharedGoals(db, dto.Goals);
    return Results.Ok(GoalValidation.Validate(normalizedGoals));
});

app.MapPost("/goalsheets/{id:guid}/submit", (HttpRequest request, AppDbContext db, Guid id) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Employee) return Results.Forbid();

    var sheet = db.GoalSheets.Include(s => s.Goals).FirstOrDefault(s => s.Id == id && s.EmployeeId == ctx.UserId);
    if (sheet is null) return Results.NotFound();
    if (sheet.Status == GoalSheetStatus.Approved) return Results.BadRequest(new { message = "Approved sheets are locked." });

    var validation = GoalValidation.Validate(sheet.Goals.Select(GoalDto.FromEntity));
    if (!validation.IsValid) return Results.BadRequest(validation);

    sheet.Status = GoalSheetStatus.Submitted;
    sheet.SubmittedAtUtc = DateTime.UtcNow;
    sheet.ManagerComment = null;
    db.AuditLogs.Add(AuditLog.Create(ctx.UserId, "GoalSheet", sheet.Id, "Submitted", null, "Submitted to L1 Manager"));
    var employee = db.Users.First(u => u.Id == ctx.UserId);
    if (employee.ManagerId.HasValue) DemoEvents.Notify(db, employee.ManagerId.Value, UserRole.Manager, "Teams", "Goal sheet submitted", $"{employee.Name} submitted FY26 goals for L1 review.");
    db.SaveChanges();
    return Results.Ok(sheet);
});

app.MapGet("/manager/inbox", (HttpRequest request, AppDbContext db) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Manager) return Results.Forbid();

    var employeeIds = db.Users.Where(u => u.ManagerId == ctx.UserId).Select(u => u.Id).ToList();
    var sheets = db.GoalSheets.Include(s => s.Employee).Include(s => s.Goals)
        .Where(s => employeeIds.Contains(s.EmployeeId) && s.Status == GoalSheetStatus.Submitted)
        .ToList();
    return Results.Ok(sheets);
});



app.MapGet("/manager/dashboard", (HttpRequest request, AppDbContext db) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Manager) return Results.Forbid();

    var employeeIds = db.Users.Where(u => u.ManagerId == ctx.UserId).Select(u => u.Id).ToList();
    var sheets = db.GoalSheets.Include(s => s.Employee).Include(s => s.Goals)
        .Where(s => employeeIds.Contains(s.EmployeeId))
        .ToList();

    var total = sheets.Count;
    var pending = sheets.Count(s => s.Status == GoalSheetStatus.Submitted);
    var returned = sheets.Count(s => s.Status == GoalSheetStatus.ReturnedForRework);
    var approved = sheets.Count(s => s.Status == GoalSheetStatus.Approved);
    var draft = sheets.Count(s => s.Status == GoalSheetStatus.Draft);
    var checkins = db.CheckIns.Count(c => sheets.Select(s => s.Id).Contains(c.GoalSheetId));

    return Results.Ok(new
    {
        Manager = db.Users.First(u => u.Id == ctx.UserId),
        TotalTeamMembers = employeeIds.Count,
        TotalGoalSheets = total,
        DraftGoalSheets = draft,
        PendingApprovals = pending,
        ReturnedForRework = returned,
        ApprovedGoalSheets = approved,
        ApprovalCompletionPct = total == 0 ? 0 : Math.Round((approved * 100.0) / total, 2),
        CompletedCheckIns = checkins,
        PendingAction = pending > 0 ? "Review submitted goal sheets" : "No pending approval right now"
    });
});

app.MapGet("/manager/team-sheets", (HttpRequest request, AppDbContext db) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Manager) return Results.Forbid();

    var employeeIds = db.Users.Where(u => u.ManagerId == ctx.UserId).Select(u => u.Id).ToList();
    var sheets = db.GoalSheets.Include(s => s.Employee).Include(s => s.Goals)
        .Where(s => employeeIds.Contains(s.EmployeeId))
        .OrderByDescending(s => s.SubmittedAtUtc ?? s.CreatedAtUtc)
        .ToList();
    return Results.Ok(sheets);
});

app.MapGet("/manager/goalsheets/{id:guid}", (HttpRequest request, AppDbContext db, Guid id) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Manager) return Results.Forbid();

    var sheet = db.GoalSheets.Include(s => s.Employee).Include(s => s.Goals).FirstOrDefault(s => s.Id == id);
    if (sheet is null) return Results.NotFound();
    var employee = db.Users.First(u => u.Id == sheet.EmployeeId);
    if (employee.ManagerId != ctx.UserId) return Results.Forbid();
    return Results.Ok(sheet);
});

app.MapPatch("/manager/goals/{goalId:guid}", (HttpRequest request, AppDbContext db, Guid goalId, ManagerInlineEditDto dto) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Manager) return Results.Forbid();

    var goal = db.Goals.Include(g => g.GoalSheet).FirstOrDefault(g => g.Id == goalId);
    if (goal is null) return Results.NotFound();
    if (goal.GoalSheet.Status != GoalSheetStatus.Submitted)
        return Results.BadRequest(new { message = "Manager inline edits are only allowed while sheet is Submitted." });

    var employee = db.Users.First(u => u.Id == goal.GoalSheet.EmployeeId);
    if (employee.ManagerId != ctx.UserId) return Results.Forbid();

    var oldTarget = goal.Target;
    var oldWeightage = goal.Weightage;
    if (dto.Target.HasValue && goal.SharedTemplateId is null) goal.Target = dto.Target.Value;
    if (dto.Weightage.HasValue) goal.Weightage = dto.Weightage.Value;

    var allGoals = db.Goals.Where(g => g.GoalSheetId == goal.GoalSheetId).ToList();
    var validation = GoalValidation.Validate(allGoals.Select(GoalDto.FromEntity));
    if (!validation.IsValid) return Results.BadRequest(validation);

    db.AuditLogs.Add(AuditLog.Create(ctx.UserId, "Goal", goal.Id, "ManagerInlineEdit", $"Target={oldTarget}, Weight={oldWeightage}", $"Target={goal.Target}, Weight={goal.Weightage}"));
    db.SaveChanges();
    return Results.Ok(goal);
});

app.MapPost("/manager/goalsheets/{id:guid}/return", (HttpRequest request, AppDbContext db, Guid id, ReturnForReworkDto dto) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Manager) return Results.Forbid();
    if (string.IsNullOrWhiteSpace(dto.Comment)) return Results.BadRequest(new { message = "Return comment is required." });

    var sheet = db.GoalSheets.FirstOrDefault(s => s.Id == id);
    if (sheet is null) return Results.NotFound();
    var employee = db.Users.First(u => u.Id == sheet.EmployeeId);
    if (employee.ManagerId != ctx.UserId) return Results.Forbid();

    sheet.Status = GoalSheetStatus.ReturnedForRework;
    sheet.IsLocked = false;
    sheet.ManagerComment = dto.Comment.Trim();
    db.AuditLogs.Add(AuditLog.Create(ctx.UserId, "GoalSheet", sheet.Id, "ReturnedForRework", null, sheet.ManagerComment));
    DemoEvents.Notify(db, sheet.EmployeeId, UserRole.Employee, "Email", "Goals returned for rework", $"Manager feedback: {sheet.ManagerComment}");
    db.SaveChanges();
    return Results.Ok(sheet);
});

app.MapPost("/manager/goalsheets/{id:guid}/approve", (HttpRequest request, AppDbContext db, Guid id) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Manager) return Results.Forbid();

    var sheet = db.GoalSheets.Include(s => s.Goals).FirstOrDefault(s => s.Id == id);
    if (sheet is null) return Results.NotFound();
    var employee = db.Users.First(u => u.Id == sheet.EmployeeId);
    if (employee.ManagerId != ctx.UserId) return Results.Forbid();

    var validation = GoalValidation.Validate(sheet.Goals.Select(GoalDto.FromEntity));
    if (!validation.IsValid) return Results.BadRequest(validation);

    sheet.Status = GoalSheetStatus.Approved;
    sheet.ApprovedAtUtc = DateTime.UtcNow;
    sheet.IsLocked = true;
    sheet.ManagerComment = null;
    db.AuditLogs.Add(AuditLog.Create(ctx.UserId, "GoalSheet", sheet.Id, "ApprovedLocked", null, "Approved and locked"));
    DemoEvents.Notify(db, sheet.EmployeeId, UserRole.Employee, "Teams", "Goals approved and locked", "Your FY26 goal sheet is approved. Q1 achievement capture is now available.");
    db.SaveChanges();
    return Results.Ok(sheet);
});

app.MapPost("/goals/{goalId:guid}/quarterly-update", (HttpRequest request, AppDbContext db, Guid goalId, QuarterlyUpdateDto dto) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Employee) return Results.Forbid();

    var goal = db.Goals.Include(g => g.GoalSheet).FirstOrDefault(g => g.Id == goalId);
    if (goal is null) return Results.NotFound();
    if (goal.GoalSheet.EmployeeId != ctx.UserId) return Results.Forbid();
    if (goal.GoalSheet.Status != GoalSheetStatus.Approved)
        return Results.BadRequest(new { message = "Quarterly updates are only allowed after manager approval." });

    goal.ActualAchievement = dto.ActualAchievement;
    goal.ProgressStatus = dto.Status;
    goal.CompletionDate = dto.CompletionDate;
    goal.Score = ScoreEngine.Calculate(goal);

    if (goal.SharedTemplateId is not null)
    {
        var template = db.SharedGoalTemplates.First(t => t.Id == goal.SharedTemplateId);
        if (template.PrimaryOwnerId == ctx.UserId)
        {
            var linkedGoals = db.Goals.Where(g => g.SharedTemplateId == goal.SharedTemplateId && g.Id != goal.Id).ToList();
            foreach (var linked in linkedGoals)
            {
                linked.ActualAchievement = goal.ActualAchievement;
                linked.ProgressStatus = goal.ProgressStatus;
                linked.CompletionDate = goal.CompletionDate;
                linked.Score = ScoreEngine.Calculate(linked);
            }
        }
    }

    db.AuditLogs.Add(AuditLog.Create(ctx.UserId, "Goal", goal.Id, "QuarterlyUpdate", null, $"Actual={dto.ActualAchievement}, Status={dto.Status}"));
    var updEmployee = db.Users.First(u => u.Id == ctx.UserId);
    if (updEmployee.ManagerId.HasValue) DemoEvents.Notify(db, updEmployee.ManagerId.Value, UserRole.Manager, "Teams", "Q1 achievement updated", $"{updEmployee.Name} updated actuals for {goal.Title}.");
    db.SaveChanges();
    return Results.Ok(goal);
});

app.MapPost("/manager/checkins", (HttpRequest request, AppDbContext db, CheckInDto dto) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Manager) return Results.Forbid();
    if (string.IsNullOrWhiteSpace(dto.Comment)) return Results.BadRequest(new { message = "Check-in comment is required." });

    var sheet = db.GoalSheets.FirstOrDefault(s => s.Id == dto.GoalSheetId);
    if (sheet is null) return Results.NotFound();
    var employee = db.Users.First(u => u.Id == sheet.EmployeeId);
    if (employee.ManagerId != ctx.UserId) return Results.Forbid();

    db.CheckIns.Add(new CheckIn { Id = Guid.NewGuid(), GoalSheetId = dto.GoalSheetId, Quarter = dto.Quarter, ManagerId = ctx.UserId, Comment = dto.Comment.Trim(), CreatedAtUtc = DateTime.UtcNow });
    db.AuditLogs.Add(AuditLog.Create(ctx.UserId, "GoalSheet", sheet.Id, "CheckInCompleted", null, dto.Comment));
    DemoEvents.Notify(db, sheet.EmployeeId, UserRole.Employee, "Email", "Q1 check-in completed", $"Manager completed Q1 check-in: {dto.Comment.Trim()}");
    DemoEvents.Notify(db, SeedIds.Admin, UserRole.Admin, "Teams", "Manager check-in completed", $"{employee.Name} now has a completed Q1 check-in.");
    db.SaveChanges();
    return Results.Ok(new { message = "Check-in completed" });
});

app.MapGet("/admin/dashboard", (HttpRequest request, AppDbContext db) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Admin) return Results.Forbid();

    var total = db.GoalSheets.Count();
    var approved = db.GoalSheets.Count(s => s.Status == GoalSheetStatus.Approved);
    var submitted = db.GoalSheets.Count(s => s.Status == GoalSheetStatus.Submitted);
    var returned = db.GoalSheets.Count(s => s.Status == GoalSheetStatus.ReturnedForRework);
    var checkins = db.CheckIns.Count();
    return Results.Ok(new
    {
        TotalGoalSheets = total,
        SubmittedGoalSheets = submitted,
        ReturnedGoalSheets = returned,
        ApprovedGoalSheets = approved,
        ApprovalCompletionPct = total == 0 ? 0 : Math.Round((approved * 100.0) / total, 2),
        CompletedCheckIns = checkins,
        OpenEscalations = db.EscalationRecords.Count(e => e.Status == "Open"),
        Notifications = db.NotificationLogs.Count(),
        AuditEvents = db.AuditLogs.OrderByDescending(a => a.CreatedAtUtc).Take(20).ToList()
    });
});



app.MapGet("/admin/analytics", (HttpRequest request, AppDbContext db) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Admin) return Results.Forbid();

    var sheets = db.GoalSheets.Include(s => s.Goals).Include(s => s.Employee).ToList();
    var goals = sheets.SelectMany(s => s.Goals.Select(g => new { Goal = g, Sheet = s })).ToList();
    var scoredGoals = goals.Where(x => x.Goal.Score.HasValue).ToList();
    var approvedSheets = sheets.Count(s => s.Status == GoalSheetStatus.Approved);
    var checkIns = db.CheckIns.ToList();
    var totalSheets = Math.Max(1, sheets.Count);

    var goalsByThrustArea = goals
        .GroupBy(x => x.Goal.ThrustArea)
        .Select(g => new { Label = string.IsNullOrWhiteSpace(g.Key) ? "Unassigned" : g.Key, Count = g.Count(), Weightage = g.Sum(x => x.Goal.Weightage) })
        .OrderByDescending(x => x.Weightage)
        .ToList();

    var goalsByStatus = sheets
        .GroupBy(s => s.Status.ToString())
        .Select(g => new { Label = g.Key == "ReturnedForRework" ? "Returned" : g.Key, Count = g.Count(), Weightage = 0m })
        .ToList();

    var scoreBands = new[]
    {
        new { Label = "Green >= 90", Count = scoredGoals.Count(x => x.Goal.Score!.Value >= 90), Weightage = 0m },
        new { Label = "Amber 70-89", Count = scoredGoals.Count(x => x.Goal.Score!.Value >= 70 && x.Goal.Score!.Value < 90), Weightage = 0m },
        new { Label = "Red < 70", Count = scoredGoals.Count(x => x.Goal.Score!.Value < 70), Weightage = 0m }
    };

    var rankedGoals = scoredGoals
        .Select(x => new
        {
            x.Goal.Title,
            Employee = x.Sheet.Employee.Name,
            Score = x.Goal.Score ?? 0,
            x.Goal.ThrustArea
        })
        .ToList();

    return Results.Ok(new
    {
        AverageScore = scoredGoals.Count == 0 ? 0 : Math.Round(scoredGoals.Average(x => (double)(x.Goal.Score ?? 0)), 2),
        ScoredGoals = scoredGoals.Count,
        TotalGoals = goals.Count,
        GoalSheets = sheets.Count,
        ApprovalCompletionPct = Math.Round((approvedSheets * 100.0) / totalSheets, 2),
        CheckInCompletionPct = approvedSheets == 0 ? 0 : Math.Round((checkIns.Count * 100.0) / approvedSheets, 2),
        SubmittedSheets = sheets.Count(s => s.Status == GoalSheetStatus.Submitted),
        ReturnedSheets = sheets.Count(s => s.Status == GoalSheetStatus.ReturnedForRework),
        ApprovedSheets = approvedSheets,
        OpenEscalations = db.EscalationRecords.Count(e => e.Status == "Open"),
        NotificationCount = db.NotificationLogs.Count(),
        GoalsByThrustArea = goalsByThrustArea,
        GoalsByStatus = goalsByStatus,
        ScoreBands = scoreBands,
        TopGoals = rankedGoals.OrderByDescending(g => g.Score).Take(5).ToList(),
        LowGoals = rankedGoals.OrderBy(g => g.Score).Take(5).ToList()
    });
});

app.MapGet("/admin/completion-dashboard", (HttpRequest request, AppDbContext db) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Admin) return Results.Forbid();

    var employees = db.Users.Where(u => u.Role == UserRole.Employee).ToList();
    var managers = db.Users.ToDictionary(u => u.Id, u => u.Name);
    var sheets = db.GoalSheets.Include(s => s.Goals).ToList();
    var checkins = db.CheckIns.ToList();

    var rows = employees.Select(employee =>
    {
        var sheet = sheets.FirstOrDefault(s => s.EmployeeId == employee.Id);
        return new
        {
            EmployeeId = employee.Id,
            Employee = employee.Name,
            employee.Department,
            Manager = employee.ManagerId.HasValue && managers.ContainsKey(employee.ManagerId.Value) ? managers[employee.ManagerId.Value] : "Unassigned",
            GoalSheetId = sheet?.Id,
            GoalSheetStatus = sheet?.Status.ToString() ?? "NotCreated",
            Goals = sheet?.Goals.Count ?? 0,
            Weightage = sheet?.Goals.Sum(g => g.Weightage) ?? 0,
            IsLocked = sheet?.IsLocked ?? false,
            Q1Status = sheet is null ? "NotStarted" : checkins.Any(c => c.GoalSheetId == sheet.Id && c.Quarter == "Q1") ? "Completed" : "Pending",
            LastUpdated = sheet?.ApprovedAtUtc ?? sheet?.SubmittedAtUtc ?? sheet?.CreatedAtUtc
        };
    }).ToList();

    return Results.Ok(rows);
});

app.MapGet("/admin/audit-logs", (HttpRequest request, AppDbContext db) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Admin) return Results.Forbid();

    var rows = db.AuditLogs
        .OrderByDescending(a => a.CreatedAtUtc)
        .Take(100)
        .AsEnumerable()
        .Select(a => new
        {
            a.Id,
            Actor = db.Users.FirstOrDefault(u => u.Id == a.ActorUserId)?.Name ?? "System",
            a.EntityName,
            a.EntityId,
            a.Action,
            a.OldValue,
            a.NewValue,
            a.CreatedAtUtc
        })
        .ToList();

    return Results.Ok(rows);
});


app.MapGet("/admin/notifications", (HttpRequest request, AppDbContext db) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Admin) return Results.Forbid();

    var users = db.Users.ToDictionary(u => u.Id, u => u.Name);
    var rows = db.NotificationLogs
        .OrderByDescending(n => n.CreatedAtUtc)
        .Take(100)
        .AsEnumerable()
        .Select(n => new
        {
            n.Id,
            Recipient = n.RecipientUserId.HasValue && users.ContainsKey(n.RecipientUserId.Value) ? users[n.RecipientUserId.Value] : n.RecipientRole.ToString(),
            n.RecipientRole,
            n.Channel,
            n.Title,
            n.Message,
            n.IsRead,
            n.CreatedAtUtc
        })
        .ToList();
    return Results.Ok(rows);
});

app.MapGet("/admin/escalations", (HttpRequest request, AppDbContext db) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Admin) return Results.Forbid();

    var users = db.Users.ToDictionary(u => u.Id, u => u.Name);
    var rows = db.EscalationRecords
        .OrderByDescending(e => e.CreatedAtUtc)
        .Take(100)
        .AsEnumerable()
        .Select(e => new
        {
            e.Id,
            e.RuleName,
            e.Severity,
            e.Subject,
            Owner = e.OwnerUserId.HasValue && users.ContainsKey(e.OwnerUserId.Value) ? users[e.OwnerUserId.Value] : e.OwnerRole.ToString(),
            e.OwnerRole,
            e.Status,
            e.NextAction,
            e.CreatedAtUtc
        })
        .ToList();
    return Results.Ok(rows);
});

app.MapPost("/admin/escalations/run", (HttpRequest request, AppDbContext db) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Admin) return Results.Forbid();

    var created = new List<EscalationRecord>();
    var employees = db.Users.Where(u => u.Role == UserRole.Employee).ToList();
    var sheets = db.GoalSheets.Include(s => s.Goals).ToList();
    var checkins = db.CheckIns.ToList();

    foreach (var employee in employees)
    {
        var sheet = sheets.FirstOrDefault(s => s.EmployeeId == employee.Id);
        if (sheet is null || sheet.Status is GoalSheetStatus.Draft or GoalSheetStatus.ReturnedForRework)
        {
            var record = DemoEvents.Escalate(db, "Goal submission overdue", "Medium", employee.Name, employee.Id, UserRole.Employee, "Notify employee, then manager after 2 days");
            created.Add(record);
            DemoEvents.Notify(db, employee.Id, UserRole.Employee, "Email", "Goal submission reminder", "Please complete and submit your FY26 goal sheet.");
            if (employee.ManagerId.HasValue) DemoEvents.Notify(db, employee.ManagerId.Value, UserRole.Manager, "Teams", "Employee goal submission pending", $"{employee.Name} has not submitted goals yet.");
        }
        else if (sheet.Status == GoalSheetStatus.Submitted)
        {
            var ownerId = employee.ManagerId ?? SeedIds.Admin;
            var record = DemoEvents.Escalate(db, "Manager approval pending", "High", employee.Name, ownerId, employee.ManagerId.HasValue ? UserRole.Manager : UserRole.Admin, "Notify L1 manager, escalate to HR if not approved");
            created.Add(record);
            DemoEvents.Notify(db, ownerId, employee.ManagerId.HasValue ? UserRole.Manager : UserRole.Admin, "Teams", "Approval pending", $"{employee.Name}'s submitted goals are waiting for approval.");
        }
        else if (sheet.Status == GoalSheetStatus.Approved && !checkins.Any(c => c.GoalSheetId == sheet.Id && c.Quarter == "Q1"))
        {
            var ownerId = employee.ManagerId ?? SeedIds.Admin;
            var record = DemoEvents.Escalate(db, "Quarterly check-in pending", "Medium", employee.Name, ownerId, employee.ManagerId.HasValue ? UserRole.Manager : UserRole.Admin, "Remind manager to complete Q1 check-in comment");
            created.Add(record);
            DemoEvents.Notify(db, ownerId, employee.ManagerId.HasValue ? UserRole.Manager : UserRole.Admin, "Teams", "Q1 check-in pending", $"Complete Q1 check-in for {employee.Name}.");
        }
    }

    db.AuditLogs.Add(AuditLog.Create(ctx.UserId, "Escalation", Guid.NewGuid(), "EscalationCheckRun", null, $"Created={created.Count}"));
    db.SaveChanges();
    return Results.Ok(new { Created = created.Count, Escalations = created });
});

app.MapPost("/admin/shared-goals", (HttpRequest request, AppDbContext db, SharedGoalCreateDto dto) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Admin) return Results.Forbid();
    if (string.IsNullOrWhiteSpace(dto.Title)) return Results.BadRequest(new { message = "Shared goal title is required." });
    if (dto.Target < 0) return Results.BadRequest(new { message = "Target cannot be negative." });

    var primaryOwner = db.Users.FirstOrDefault(u => u.Id == dto.PrimaryOwnerId && u.Role == UserRole.Employee) ?? db.Users.First(u => u.Role == UserRole.Employee);
    var template = new SharedGoalTemplate
    {
        Id = Guid.NewGuid(),
        Title = dto.Title.Trim(),
        Description = dto.Description.Trim(),
        Target = dto.Target,
        UomType = dto.UomType,
        Direction = dto.Direction,
        PrimaryOwnerId = primaryOwner.Id
    };

    db.SharedGoalTemplates.Add(template);
    db.AuditLogs.Add(AuditLog.Create(ctx.UserId, "SharedGoalTemplate", template.Id, "SharedGoalCreated", null, $"{template.Title} / Target={template.Target}"));
    DemoEvents.Notify(db, SeedIds.Manager, UserRole.Manager, "Teams", "New shared KPI available", $"HR created shared KPI: {template.Title}.");
    db.SaveChanges();
    return Results.Ok(template);
});

app.MapPost("/admin/goalsheets/{id:guid}/unlock", (HttpRequest request, AppDbContext db, Guid id, AdminUnlockDto dto) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Admin) return Results.Forbid();

    var sheet = db.GoalSheets.FirstOrDefault(s => s.Id == id);
    if (sheet is null) return Results.NotFound();

    var old = $"Status={sheet.Status}, Locked={sheet.IsLocked}";
    sheet.Status = GoalSheetStatus.ReturnedForRework;
    sheet.IsLocked = false;
    sheet.ManagerComment = string.IsNullOrWhiteSpace(dto.Reason) ? "Unlocked by HR/Admin for exception handling." : dto.Reason.Trim();
    db.AuditLogs.Add(AuditLog.Create(ctx.UserId, "GoalSheet", sheet.Id, "AdminUnlock", old, $"Status={sheet.Status}, Locked={sheet.IsLocked}, Reason={sheet.ManagerComment}"));
    DemoEvents.Notify(db, sheet.EmployeeId, UserRole.Employee, "Email", "Goal sheet unlocked by HR", sheet.ManagerComment ?? "Your sheet is unlocked for revisions.");
    db.SaveChanges();
    return Results.Ok(sheet);
});

app.MapGet("/admin/export-achievements", (HttpRequest request, AppDbContext db) =>
{
    var ctx = DemoContext.FromHeaders(request);
    if (ctx.Role != UserRole.Admin) return Results.Forbid();

    using var writer = new StringWriter();
    using var csv = new CsvWriter(writer, CultureInfo.InvariantCulture);
    var rows = db.Goals.Include(g => g.GoalSheet).ThenInclude(s => s.Employee).Select(g => new
    {
        Employee = g.GoalSheet.Employee.Name,
        Department = g.GoalSheet.Employee.Department,
        GoalStatus = g.GoalSheet.Status,
        g.ThrustArea,
        g.Title,
        g.UomType,
        g.Direction,
        PlannedTarget = g.Target,
        ActualAchievement = g.ActualAchievement,
        g.Weightage,
        g.Score,
        g.ProgressStatus
    }).ToList();
    csv.WriteRecords(rows);
    var bytes = System.Text.Encoding.UTF8.GetBytes(writer.ToString());
    return Results.File(bytes, "text/csv", "atomquest-achievement-report.csv");
});

app.Run();

static List<GoalDto> NormalizeSharedGoals(AppDbContext db, IEnumerable<GoalDto> goals)
{
    return goals.Select(g =>
    {
        if (g.SharedTemplateId is null) return g;
        var template = db.SharedGoalTemplates.FirstOrDefault(t => t.Id == g.SharedTemplateId);
        return template is null
            ? g
            : g with
            {
                Title = template.Title,
                Description = template.Description,
                Target = template.Target,
                UomType = template.UomType,
                Direction = template.Direction
            };
    }).ToList();
}

public sealed record DemoContext(Guid UserId, UserRole Role)
{
    public static DemoContext FromHeaders(HttpRequest request)
    {
        var roleRaw = request.Headers["X-Demo-Role"].FirstOrDefault() ?? "Employee";
        var role = Enum.TryParse<UserRole>(roleRaw, true, out var parsed) ? parsed : UserRole.Employee;
        var defaultUserId = role switch
        {
            UserRole.Manager => SeedIds.Manager,
            UserRole.Admin => SeedIds.Admin,
            _ => SeedIds.Employee
        };
        var userIdRaw = request.Headers["X-Demo-UserId"].FirstOrDefault();
        var userId = Guid.TryParse(userIdRaw, out var parsedId) ? parsedId : defaultUserId;
        return new DemoContext(userId, role);
    }
}

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<GoalSheet> GoalSheets => Set<GoalSheet>();
    public DbSet<Goal> Goals => Set<Goal>();
    public DbSet<SharedGoalTemplate> SharedGoalTemplates => Set<SharedGoalTemplate>();
    public DbSet<CheckIn> CheckIns => Set<CheckIn>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<NotificationLog> NotificationLogs => Set<NotificationLog>();
    public DbSet<EscalationRecord> EscalationRecords => Set<EscalationRecord>();
}

public static class SeedIds
{
    public static readonly Guid Employee = Guid.Parse("11111111-1111-1111-1111-111111111111");
    public static readonly Guid Employee2 = Guid.Parse("22222222-2222-2222-2222-222222222222");
    public static readonly Guid Manager = Guid.Parse("33333333-3333-3333-3333-333333333333");
    public static readonly Guid Admin = Guid.Parse("44444444-4444-4444-4444-444444444444");
    public static readonly Guid SharedTemplate = Guid.Parse("55555555-5555-5555-5555-555555555555");
}

public static class SeedData
{
    public static void Run(AppDbContext db)
    {
        if (db.Users.Any()) return;

        db.Users.AddRange(
            new User { Id = SeedIds.Employee, Name = "Aarav Employee", Role = UserRole.Employee, Department = "Sales", ManagerId = SeedIds.Manager },
            new User { Id = SeedIds.Employee2, Name = "Diya Employee", Role = UserRole.Employee, Department = "Sales", ManagerId = SeedIds.Manager },
            new User { Id = SeedIds.Manager, Name = "Meera Manager", Role = UserRole.Manager, Department = "Sales" },
            new User { Id = SeedIds.Admin, Name = "HR Admin", Role = UserRole.Admin, Department = "HR" }
        );

        db.SharedGoalTemplates.Add(new SharedGoalTemplate
        {
            Id = SeedIds.SharedTemplate,
            Title = "Improve Department NPS",
            Description = "Shared KPI pushed to multiple employees. Recipients may only adjust weightage.",
            Target = 75,
            UomType = UomType.Numeric,
            Direction = GoalDirection.Min,
            PrimaryOwnerId = SeedIds.Employee
        });

        var sheet = new GoalSheet
        {
            Id = Guid.NewGuid(),
            EmployeeId = SeedIds.Employee,
            CycleName = "FY26",
            Status = GoalSheetStatus.Draft,
            IsLocked = false,
            CreatedAtUtc = DateTime.UtcNow
        };

        sheet.Goals.AddRange([
            new Goal { Id = Guid.NewGuid(), GoalSheetId = sheet.Id, ThrustArea = "Revenue Growth", Title = "Increase enterprise revenue", Description = "Drive new enterprise accounts", UomType = UomType.Numeric, Direction = GoalDirection.Min, Target = 100, Weightage = 40, ProgressStatus = ProgressStatus.NotStarted },
            new Goal { Id = Guid.NewGuid(), GoalSheetId = sheet.Id, SharedTemplateId = SeedIds.SharedTemplate, ThrustArea = "Customer Experience", Title = "Improve Department NPS", Description = "Shared KPI pushed to multiple employees. Recipients may only adjust weightage.", UomType = UomType.Numeric, Direction = GoalDirection.Min, Target = 75, Weightage = 30, ProgressStatus = ProgressStatus.NotStarted },
            new Goal { Id = Guid.NewGuid(), GoalSheetId = sheet.Id, ThrustArea = "Operational Excellence", Title = "Reduce TAT", Description = "Lower turnaround time", UomType = UomType.Numeric, Direction = GoalDirection.Max, Target = 4, Weightage = 30, ProgressStatus = ProgressStatus.NotStarted }
        ]);

        db.GoalSheets.Add(sheet);
        db.AuditLogs.Add(AuditLog.Create(SeedIds.Admin, "System", sheet.Id, "SeededDemo", null, "Phase 1 demo data loaded"));
        DemoEvents.Notify(db, SeedIds.Admin, UserRole.Admin, "Teams", "Demo workspace ready", "Seeded employee, manager, shared KPI, and audit data are ready for the judge flow.");
        db.SaveChanges();
    }
}

public class User { public Guid Id { get; set; } public string Name { get; set; } = ""; public UserRole Role { get; set; } public string Department { get; set; } = ""; public Guid? ManagerId { get; set; } }
public class GoalSheet { public Guid Id { get; set; } public Guid EmployeeId { get; set; } public User Employee { get; set; } = default!; public string CycleName { get; set; } = "FY26"; public GoalSheetStatus Status { get; set; } public bool IsLocked { get; set; } public string? ManagerComment { get; set; } public DateTime CreatedAtUtc { get; set; } public DateTime? SubmittedAtUtc { get; set; } public DateTime? ApprovedAtUtc { get; set; } public List<Goal> Goals { get; set; } = []; }
public class Goal { public Guid Id { get; set; } public Guid GoalSheetId { get; set; } public GoalSheet GoalSheet { get; set; } = default!; public Guid? SharedTemplateId { get; set; } public string ThrustArea { get; set; } = ""; public string Title { get; set; } = ""; public string Description { get; set; } = ""; public UomType UomType { get; set; } public GoalDirection Direction { get; set; } public decimal Target { get; set; } public decimal Weightage { get; set; } public decimal? ActualAchievement { get; set; } public DateOnly? CompletionDate { get; set; } public ProgressStatus ProgressStatus { get; set; } public decimal? Score { get; set; } }
public class SharedGoalTemplate { public Guid Id { get; set; } public string Title { get; set; } = ""; public string Description { get; set; } = ""; public decimal Target { get; set; } public UomType UomType { get; set; } public GoalDirection Direction { get; set; } public Guid PrimaryOwnerId { get; set; } }
public class CheckIn { public Guid Id { get; set; } public Guid GoalSheetId { get; set; } public string Quarter { get; set; } = "Q1"; public Guid ManagerId { get; set; } public string Comment { get; set; } = ""; public DateTime CreatedAtUtc { get; set; } }
public class NotificationLog { public Guid Id { get; set; } public Guid? RecipientUserId { get; set; } public UserRole RecipientRole { get; set; } public string Channel { get; set; } = "Teams"; public string Title { get; set; } = ""; public string Message { get; set; } = ""; public bool IsRead { get; set; } public DateTime CreatedAtUtc { get; set; } }
public class EscalationRecord { public Guid Id { get; set; } public string RuleName { get; set; } = ""; public string Severity { get; set; } = "Medium"; public string Subject { get; set; } = ""; public Guid? OwnerUserId { get; set; } public UserRole OwnerRole { get; set; } public string Status { get; set; } = "Open"; public string NextAction { get; set; } = ""; public DateTime CreatedAtUtc { get; set; } }
public class AuditLog { public Guid Id { get; set; } public Guid ActorUserId { get; set; } public string EntityName { get; set; } = ""; public Guid EntityId { get; set; } public string Action { get; set; } = ""; public string? OldValue { get; set; } public string? NewValue { get; set; } public DateTime CreatedAtUtc { get; set; } public static AuditLog Create(Guid actor, string entity, Guid entityId, string action, string? oldValue, string? newValue) => new() { Id = Guid.NewGuid(), ActorUserId = actor, EntityName = entity, EntityId = entityId, Action = action, OldValue = oldValue, NewValue = newValue, CreatedAtUtc = DateTime.UtcNow }; }

public enum UserRole { Employee, Manager, Admin }
public enum GoalSheetStatus { Draft, Submitted, ReturnedForRework, Approved }
public enum UomType { Numeric, Percentage, Timeline, ZeroBased }
public enum GoalDirection { Min, Max }
public enum ProgressStatus { NotStarted, OnTrack, Completed }

public sealed record CycleDto(string Name, string Window, string Status, string Opens, string Message);
public sealed record GoalSheetUpsertDto(List<GoalDto> Goals);
public sealed record GoalDto(string ThrustArea, string Title, string Description, UomType UomType, GoalDirection Direction, decimal Target, decimal Weightage, Guid? SharedTemplateId = null)
{
    public static GoalDto FromEntity(Goal g) => new(g.ThrustArea, g.Title, g.Description, g.UomType, g.Direction, g.Target, g.Weightage, g.SharedTemplateId);
}
public sealed record ManagerInlineEditDto(decimal? Target, decimal? Weightage);
public sealed record ReturnForReworkDto(string Comment);
public sealed record QuarterlyUpdateDto(decimal ActualAchievement, ProgressStatus Status, DateOnly? CompletionDate);
public sealed record CheckInDto(Guid GoalSheetId, string Quarter, string Comment);
public sealed record SharedGoalCreateDto(string Title, string Description, decimal Target, UomType UomType, GoalDirection Direction, Guid PrimaryOwnerId);
public sealed record AdminUnlockDto(string Reason);


public static class DemoEvents
{
    public static void Notify(AppDbContext db, Guid? recipientUserId, UserRole recipientRole, string channel, string title, string message)
    {
        db.NotificationLogs.Add(new NotificationLog
        {
            Id = Guid.NewGuid(),
            RecipientUserId = recipientUserId,
            RecipientRole = recipientRole,
            Channel = channel,
            Title = title,
            Message = message,
            IsRead = false,
            CreatedAtUtc = DateTime.UtcNow
        });
    }

    public static EscalationRecord Escalate(AppDbContext db, string ruleName, string severity, string subject, Guid? ownerUserId, UserRole ownerRole, string nextAction)
    {
        var record = new EscalationRecord
        {
            Id = Guid.NewGuid(),
            RuleName = ruleName,
            Severity = severity,
            Subject = subject,
            OwnerUserId = ownerUserId,
            OwnerRole = ownerRole,
            Status = "Open",
            NextAction = nextAction,
            CreatedAtUtc = DateTime.UtcNow
        };
        db.EscalationRecords.Add(record);
        return record;
    }
}

public static class GoalValidation
{
    public static ValidationResult Validate(IEnumerable<GoalDto> goalsEnumerable)
    {
        var goals = goalsEnumerable.ToList();
        var errors = new List<string>();
        if (goals.Count == 0) errors.Add("At least one goal is required.");
        if (goals.Count > 8) errors.Add("Maximum 8 goals are allowed.");
        if (goals.Any(g => string.IsNullOrWhiteSpace(g.ThrustArea))) errors.Add("Every goal needs a thrust area.");
        if (goals.Any(g => string.IsNullOrWhiteSpace(g.Title))) errors.Add("Every goal needs a title.");
        if (goals.Any(g => g.Target < 0)) errors.Add("Targets cannot be negative.");
        if (goals.Any(g => g.Weightage < 10)) errors.Add("Each goal must have at least 10% weightage.");
        if (goals.Sum(g => g.Weightage) != 100) errors.Add("Total weightage must equal exactly 100%.");
        return new ValidationResult(errors.Count == 0, errors);
    }
}
public sealed record ValidationResult(bool IsValid, List<string> Errors);

public static class ScoreEngine
{
    public static decimal Calculate(Goal goal)
    {
        if (goal.UomType == UomType.ZeroBased) return goal.ActualAchievement == 0 ? 100 : 0;
        if (goal.ActualAchievement is null || goal.Target <= 0) return 0;
        if (goal.UomType == UomType.Timeline) return goal.ProgressStatus == ProgressStatus.Completed ? 100 : 50;
        if (goal.Direction == GoalDirection.Max) return goal.ActualAchievement.Value == 0 ? 100 : Math.Round((goal.Target / goal.ActualAchievement.Value) * 100, 2);
        return Math.Round((goal.ActualAchievement.Value / goal.Target) * 100, 2);
    }
}
