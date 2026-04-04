# Dashboard Visual Audit — April 3, 2026

Side-by-side screenshot comparison of the v2 dashboard (lifeos2 instance, port 3001) vs the mac-native dashboard (default instance, port 3002).

## Structure

```
dashboard-audit/
  v2/           — v2 dashboard (cortextos-v2, ~/.cortextos/lifeos2)
  mac-native/   — bash dashboard (cortextos, ~/.cortextos/default)
  README.md     — this file
```

## Page Index

| Page | v2 Screenshot | Mac-native Screenshot | Notes |
|------|--------------|----------------------|-------|
| Overview | v2/v2-dashboard-overview.png | mac-native/mac-overview.png | Mac has "13 actions needed" badge, v2 clean |
| Agents | v2/v2-agents.png | mac-native/mac-agents.png | Mac shows 12 agents, v2 shows 2 |
| Tasks | v2/v2-tasks.png | mac-native/mac-tasks.png | Mac has filters + List view + New Task button; v2 missing all three |
| Approvals | v2/v2-approvals.png | mac-native/mac-approvals.png | Both working; mac has real pending approval |
| Activity | v2/v2-activity.png | mac-native/mac-activity.png | v2 shows "Reconnecting..." SSE badge; mac shows "Live" |
| Workflows | v2/v2-workflows-fixed.png | mac-native/mac-workflows.png | Both working after v2 crash fix |
| Strategy | v2/v2-strategy.png | mac-native/mac-strategy.png | v2 has goals data; mac shows empty ("No goals yet") |
| Analytics | v2/v2-analytics.png | mac-native/mac-analytics.png | v2 works; mac CRASHES (used_pct undefined) |
| Knowledge Base | v2/v2-knowledge-base.png | mac-native/mac-knowledge-base.png | Both identical empty state |
| Experiments | v2/v2-experiments.png | mac-native/mac-experiments.png | v2 empty state; mac shows 11 experiments with full UI |
| Skills | v2/v2-skills.png | mac-native/mac-skills.png | v2: 0 installed; mac: 4 installed with agent tags |
| Settings | v2/v2-settings.png | mac-native/mac-settings.png | v2 works; mac shows "Organization not configured" |

## Key Differences Found

1. **Tasks page** — v2 missing filters, List view, and New Task button (audit item #21)
2. **Analytics crash** — mac-native crashes on `used_pct` (audit item #18)
3. **Experiments UI** — v2 empty, mac has full stats/tabs UI (audit item #22)
4. **SSE indicator** — v2 Activity shows "Reconnecting...", mac shows "Live" (audit item #13)
5. **Skills installed state** — expected difference between fresh and established instances
6. **Strategy goals** — expected difference; data not shared across instances
7. **Settings org config** — mac shows "not configured" due to bash/v2 format mismatch (audit item #20)

## Full bug list: see node-cortext-audit-4-3-26.md (items 1-23)
