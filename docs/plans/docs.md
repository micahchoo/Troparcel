---
shaping: true
---

# Documentation Rewrite — V-Plan

Parent: [SHAPING.md](../SHAPING.md) → [slices.md](../design/slices.md)
Source: [SHAPING.md](../SHAPING.md) R7 → [slices.md](../design/slices.md) Docs

## Demo Criterion

All user-facing docs reflect the new safety model (ownership guard), connection string UX, transport options, attribution tags, and auto-lists. A new user can set up troparcel from GUIDE.md alone.

## File Scope

| File | Key Changes |
|------|-------------|
| `docs/GUIDE.md` | Connection string setup (§5), ownership model (§3), attribution + auto-lists (§9.3), simplified presets (§6) |
| `docs/SETUP.md` | Add file + snapshot transport scenarios. Connection string in all scenarios. |
| `docs/CONFLICTS.md` | Entity-type ownership table. Update tag/list semantics. |
| `docs/CHANGELOG.md` | v6.0 entry: transport, ownership, attribution, auto-lists, deploy |

## Build Sequence

1. GUIDE.md §5: Replace settings card with connection string workflow
2. GUIDE.md §3: Rewrite deletion model → author-scoped for notes/sel/tx, add-wins for tags/lists
3. GUIDE.md §9.3: Add attribution tags + auto-lists documentation
4. GUIDE.md §6: Simplify presets to 3-field tables (connection + name + mode)
5. SETUP.md: Add Scenario 4 (shared folder) + Scenario 5 (snapshot)
6. CONFLICTS.md: Add Ownership Model (V2) table
7. CHANGELOG.md: v6.0 entry
