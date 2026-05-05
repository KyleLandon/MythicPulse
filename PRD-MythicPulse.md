# MythicPulse — Product Requirements Document

**Version:** 1.0  
**Date:** May 5, 2026  
**Author:** Kyle Landon  

---

## 1. Overview

MythicPulse is a player performance analysis platform for World of Warcraft Mythic+ dungeons. It consists of three components: a lightweight WoW addon that surfaces basic stats in-game, a desktop companion app that automatically syncs combat logs, and a web application that parses those logs into detailed performance breakdowns and a composite **Player Rating**.

Unlike Warcraft Logs, which focuses primarily on damage and healing throughput, MythicPulse rates players on the *full picture* — interrupts, defensives, positioning deaths, potion usage, crowd control, and more — weighted by role and spec. The goal is to answer: "How good is this player, really?" and to show them exactly where to improve.

---

## 2. Target Audience

Competitive Mythic+ pushers — players running keys at the +10 and above level who are actively trying to improve their gameplay, optimize their runs, and evaluate potential group members. These players already use tools like Warcraft Logs, Raider.IO, and Details! but want a more holistic picture of performance beyond raw throughput.

---

## 3. Product Components

### 3.1 WoW Addon

A lightweight in-game addon written in Lua that:

- Tracks KPIs in real time during a dungeon run using the combat log event API (`COMBAT_LOG_EVENT_UNFILTERED`)
- Displays a compact post-dungeon summary frame showing key stats for all party members (interrupts hit/missed, deaths, defensive usage, damage/healing done)
- Optionally shows a minimal live HUD during combat (toggle-able) with personal interrupt count, defensive cooldown tracking, and death counter
- Writes structured metadata to `SavedVariables` that the desktop app can read (run ID, dungeon name, key level, affixes, timestamp, party composition)
- Does NOT attempt to parse full combat logs itself — the heavy lifting happens server-side

**Addon scope is intentionally thin.** The combat log file (`WoWCombatLog.txt`) already captures everything needed. The addon's job is to provide light in-game feedback and enrich the log with metadata that isn't available from the raw log alone (like key level and affix set via `C_ChallengeMode` API).

### 3.2 Desktop Companion App (Electron)

A system-tray application that:

- Watches the WoW combat log directory (`World of Warcraft/_retail_/Logs/`) for new or modified log files
- Detects dungeon completion events (end-of-run markers in the log) and segments the log into individual runs
- Uploads segmented log data + addon metadata to the MythicPulse API via authenticated HTTPS
- Shows upload status, history, and basic connectivity info in a minimal tray UI
- Handles authentication via OAuth (Battle.net or email/password)
- Supports configurable log directory path for non-standard WoW installs
- Auto-updates via Electron's built-in update mechanism

### 3.3 Web Application (Next.js + Supabase)

The primary interface where players view their performance data, ratings, and improvement suggestions. Detailed in sections below.

---

## 4. Key Performance Indicators (KPIs)

KPIs are organized into categories. Each KPI is tracked per player per run, then aggregated for rating calculations.

### 4.1 Core KPIs (All Roles)

| KPI | Description | How It's Measured |
|-----|-------------|-------------------|
| **Deaths** | Total deaths and death context | Count + timestamp + cause of death (what killed them, avoidable vs. unavoidable) |
| **Interrupts** | Successful kicks vs. available interrupt opportunities | Kicks landed / kickable casts in range, factoring in diminishing returns and coordination |
| **Avoidable Damage Taken** | Damage from mechanics the player should have dodged | Damage from known avoidable spell IDs (swirlies, frontals, standing in bad) |
| **Defensive Usage** | How effectively defensives are used | Defensives used / total available uses over the run, plus timing quality (used before lethal damage vs. panic usage) |
| **Potion Usage** | Combat potions, health potions, healthstones | Did they pot on pull? Use health pots when low? Healthstone usage? |
| **Crowd Control** | CC applied and broken | CC abilities used, accidental CC breaks (tab-targeting DoTs, cleave into CC'd targets) |
| **Dispels** | Dispels performed (where applicable) | Dispels cast vs. dispellable debuffs active on party members |
| **Movement Efficiency** | Time spent moving vs. casting/attacking | Uptime percentage — how much of the fight is spent dealing damage vs. running around unnecessarily |

### 4.2 DPS-Specific KPIs

| KPI | Description |
|-----|-------------|
| **Damage Done** | Total and per-second, broken down by boss vs. trash, priority target vs. AoE |
| **Priority Target Damage** | Damage on high-priority mobs (e.g., Inspiring mobs, explosives, dangerous casters) |
| **Burst Window Efficiency** | Damage dealt during cooldown windows vs. theoretical maximum |
| **DoT/Buff Uptime** | Maintenance of key class buffs and DoTs (spec-specific) |
| **Damage Parse** | Percentile rank vs. other players of the same spec on the same dungeon/key level |

### 4.3 Healer-Specific KPIs

| KPI | Description |
|-----|-------------|
| **Healing Done** | Total and per-second, effective healing vs. overhealing ratio |
| **Damage Contributed** | DPS output — good healers deal significant damage in M+ |
| **Mana Efficiency** | Mana usage patterns — did they OOM? How much mana was wasted on overhealing? |
| **Healing Parse** | Percentile rank for effective healing vs. spec/dungeon/level |
| **Triage Accuracy** | Healing the right target — healing someone at 90% HP vs. saving the player at 20% |
| **Cooldown Alignment** | Major healing cooldowns used at optimal times (high incoming damage) vs. wasted |

### 4.4 Tank-Specific KPIs

| KPI | Description |
|-----|-------------|
| **Damage Taken (Mitigated)** | Raw damage taken vs. damage after mitigation — active mitigation uptime |
| **Self-Healing** | Amount of self-sustain provided, reducing healer burden |
| **Damage Done** | Tank damage output (increasingly important in M+) |
| **Active Mitigation Uptime** | Percentage of time active mitigation buffs were up during incoming damage |
| **Pull Efficiency** | (Future/advanced) Mob grouping efficiency, route adherence, time between pulls |
| **Threat Stability** | Threat generation consistency — did mobs peel off to DPS? |

### 4.5 Dungeon-Level KPIs

| KPI | Description |
|-----|-------------|
| **Completion Time** | Time vs. the timer, broken into boss time and trash time |
| **Deaths per Key Level** | Normalized death rate for the key level |
| **Overall Route Efficiency** | Total enemy forces % at completion (over-pulling vs. tight routing) |
| **Wipe Count** | Number of full party wipes |

---

## 5. Player Rating System

### 5.1 Philosophy

The Player Rating is designed to be a *more honest* indicator of player quality than a damage parse alone. A player who tops DPS but dies twice to avoidable mechanics, never kicks, and doesn't use defensives should not be rated as highly as a player who does solid damage while executing mechanics perfectly.

### 5.2 Rating Structure

The rating is a **composite score from 0 to 100**, built from percentile ranks across all tracked KPIs, with weights that vary by role.

**Layer 1 — Per-KPI Percentile Ranks (Spec-vs-Spec):**  
Each KPI is ranked against the population of the **same spec**, in the same dungeon, at a comparable key level bracket (e.g., +10–12, +13–15, +16–19, +20+). This produces a percentile (0–99) for each metric. Comparing spec-to-spec ensures fairness — a Resto Shaman's interrupt rate is compared only to other Resto Shamans, not to Holy Priests who lack an interrupt. A Fire Mage's damage profile is compared to other Fire Mages, not to Assassination Rogues. This eliminates the need for artificial weight redistribution across specs.

**Layer 2 — Weighted Composite Score:**  
Percentiles are combined using role-specific weights into a single score.

Example DPS weights (subject to tuning):

| KPI Category | Weight |
|-------------|--------|
| Damage output (parse) | 30% |
| Interrupts | 15% |
| Avoidable damage taken | 15% |
| Deaths | 15% |
| Defensive usage | 10% |
| CC / utility | 5% |
| Potion usage | 5% |
| Movement efficiency | 5% |

Example Tank weights:

| KPI Category | Weight |
|-------------|--------|
| Active mitigation uptime | 25% |
| Damage done | 20% |
| Deaths | 15% |
| Avoidable damage taken | 15% |
| Interrupts | 10% |
| Self-healing | 10% |
| Utility / CC | 5% |

Example Healer weights:

| KPI Category | Weight |
|-------------|--------|
| Damage contributed | 25% |
| Effective healing (minus overheal) | 20% |
| Deaths | 15% |
| Avoidable damage taken | 10% |
| Mana efficiency | 10% |
| Cooldown alignment | 10% |
| Dispels | 5% |
| Interrupts | 5% |

**Layer 3 — Rolling Player Rating:**  
A player's overall Player Rating is a weighted rolling average of their last N runs (e.g., last 20 timed keys), with more recent runs weighted more heavily. This smooths out variance from single bad runs while still reflecting improvement or decline.

### 5.3 Rating Tiers

| Rating | Tier Name | Approximate Population |
|--------|-----------|----------------------|
| 95–100 | Mythic Elite | Top 1% |
| 85–94 | Challenger | Top 10% |
| 70–84 | Skilled | Top 25% |
| 50–69 | Competent | Average |
| 30–49 | Developing | Below Average |
| 0–29 | Learning | Bottom quartile |

### 5.4 Improvement Recommendations

After each run, MythicPulse surfaces actionable improvement tips based on the player's weakest KPIs. Examples:

- "You missed 6 interrupt opportunities this run. Focus on tracking enemy cast bars — consider adding a nameplate cast bar addon like Plater."
- "Your defensive usage was 2/8 available casts. Try using Shield Wall proactively before big trash pulls rather than saving it for emergencies."
- "You took 340K avoidable damage from Sanguine pools. Work on repositioning mobs out of pools faster."

These are contextual, not generic — they reference specific moments from the run.

---

## 6. Web Application — Feature Breakdown

### 6.1 Authentication & Profiles

- Sign up / login via Battle.net OAuth (primary) or email/password (fallback)
- Player profile page showing: character name, realm, spec, current Player Rating, rating history graph, recent runs
- Public profiles enabled by default (opt-out available)
- Profile linked to Battle.net characters — supports multiple characters per account

### 6.2 Run Analysis Page

The core experience. After a log is uploaded and parsed, the player sees:

- **Run Summary Header:** Dungeon name, key level, affixes, completion time (vs. timer), date, party composition
- **Player Scorecard:** Composite score for this run + per-KPI breakdown with percentile bars
- **Timeline View:** Interactive timeline of the run showing boss pulls, deaths, defensive usage, interrupt events, and avoidable damage spikes
- **Death Breakdown:** For each death: what killed them, how much avoidable damage they'd taken in the preceding 10 seconds, whether defensives were available, what healing they received
- **Interrupt Audit:** Every kickable cast in the run — who kicked it, who was in range but didn't, what went un-kicked
- **Group Comparison:** Side-by-side performance of all 5 party members across all KPIs
- **Improvement Tips:** Contextual suggestions based on this specific run

### 6.3 Trends & History

- Rating over time graph (line chart, filterable by spec/dungeon/key range)
- Per-KPI trend lines — "Am I getting better at interrupting over time?"
- Best/worst runs with one-click drill-down
- Dungeon-specific performance comparison — "I perform well in Mists but poorly in Siege"

### 6.4 Leaderboards

- Global leaderboards by Player Rating, filterable by: role, spec, dungeon, key level bracket, region
- Weekly / seasonal / all-time views
- Friend/guild leaderboards (future phase)

### 6.5 Search & Lookup

- Search any player by character name + realm
- View their public profile, recent runs, and Player Rating
- "Look up your PUG" — paste a character name before inviting to your group to check their MythicPulse rating

---

## 7. Technical Architecture

### 7.1 Stack

| Component | Technology |
|-----------|-----------|
| WoW Addon | Lua (WoW API) |
| Desktop App | Electron + TypeScript |
| Web Frontend | Next.js (React), TypeScript, Tailwind CSS |
| Backend / API | Next.js API Routes + Supabase Edge Functions |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase Auth with Battle.net OAuth provider |
| File Storage | Supabase Storage (raw log archives) |
| Hosting | Vercel (web app) |

### 7.2 Data Flow

```
WoW Client
  ├── Combat Log (WoWCombatLog.txt) ──┐
  └── Addon SavedVariables ───────────┤
                                      ▼
                              Desktop App (Electron)
                                      │
                            Segments log by run
                            Attaches addon metadata
                                      │
                                      ▼
                              MythicPulse API
                                      │
                            ┌─────────┴─────────┐
                            ▼                   ▼
                      Log Parser           Raw Log Archive
                      (Edge Function)      (Supabase Storage)
                            │
                            ▼
                      Parsed Events
                      (PostgreSQL)
                            │
                            ▼
                      Rating Engine
                      (Edge Function)
                            │
                            ▼
                      Player Ratings
                      & KPI Percentiles
                      (PostgreSQL)
                            │
                            ▼
                      Web App (Next.js)
```

### 7.3 Database Schema (High-Level)

**Core tables:**

- `players` — Battle.net ID, characters (JSON array of name/realm/class/spec), account settings
- `runs` — run_id, dungeon, key_level, affixes, duration, timed (bool), timestamp, party_member IDs
- `run_players` — join table: run_id + player_id + role + spec + composite_score
- `kpi_scores` — run_id + player_id + kpi_name + raw_value + percentile_rank
- `events` — run_id + timestamp + event_type + source_player + target + spell_id + value (granular parsed events for timeline/drill-down)
- `player_ratings` — player_id + spec + current_rating + rating_history (JSONB) + last_updated
- `leaderboard_cache` — materialized/cached leaderboard entries, refreshed periodically

### 7.4 Log Parsing Strategy

WoW combat logs follow a well-documented format. Parsing happens server-side in Supabase Edge Functions (Deno/TypeScript):

1. **Segment:** Split the raw log into individual encounters using `ENCOUNTER_START` / `ENCOUNTER_END` and `CHALLENGE_MODE_START` / `CHALLENGE_MODE_END` markers
2. **Extract Events:** Parse each line into typed events (damage, healing, cast start, cast success, interrupt, aura applied/removed, unit died, etc.)
3. **Enrich:** Cross-reference spell IDs against a maintained spell database to classify: is this avoidable damage? Is this an interrupt-eligible cast? Is this a defensive cooldown? Is this a potion?
4. **Aggregate:** Compute KPI values from the event stream
5. **Rank:** Compare against historical percentile distributions to produce percentile ranks
6. **Score:** Apply role-specific weights to produce the composite Player Rating for this run
7. **Update:** Recalculate the player's rolling Player Rating

### 7.5 Spell Database

A critical dependency. MythicPulse needs a maintained mapping of spell IDs to categories:

- Avoidable damage spells (per dungeon)
- Interruptible casts (per dungeon)
- Defensive cooldowns (per spec)
- Offensive cooldowns (per spec)
- Potions and consumables
- CC abilities (per class)
- Dispellable debuffs (per dungeon)

This must be updated each WoW season/patch. Can be seeded from community resources (Wowhead, WoW API) and maintained as a JSON/DB table.

---

## 8. MVP Scope & Phasing

### Phase 1 — MVP (Target: 8–10 weeks)

**In scope:**

- WoW addon: post-run summary frame, SavedVariables metadata output
- Desktop app: file watcher, log segmentation, authenticated upload
- Web app: auth (Battle.net), run upload, log parsing for M+ dungeons
- Core KPI tracking: damage, healing, interrupts, deaths, avoidable damage, defensives, potions
- Per-run scorecard with percentile ranks and composite score
- Basic Player Rating (rolling average of recent runs)
- Public player profiles
- Group comparison view (5-player side-by-side)
- Global leaderboard (by rating, filterable by role/spec)
- Spell database for current M+ season dungeons

**Out of scope for MVP:**

- Raid support
- Rich in-game overlay / live HUD (addon shows post-run only)
- Advanced timeline view (simplified version in MVP)
- Guild/friends leaderboards
- Mobile app
- Pull efficiency / route analysis for tanks
- Triage accuracy for healers (complex to implement reliably)
- Burst window efficiency (requires per-spec cooldown modeling)

### Phase 2 — Post-Launch Enhancements

- Interactive timeline view with scrubbing
- In-game live HUD (minimal stats during combat)
- Death replay — "what happened in the 10 seconds before you died"
- Burst window analysis for DPS
- Healer triage scoring
- Tank route analysis
- Friend / guild leaderboards
- Seasonal tracking and historical season comparisons

### Phase 3 — Expansion

- Raid support (boss-by-boss analysis)
- Mobile companion app
- API for third-party integrations
- Embeddable widgets (for guild websites, Discord bots)
- Community features (guides, build recommendations based on top-rated players)

---

## 9. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Blizzard ToS compliance** | Addon rejection or account action | Addon only uses public WoW API. No memory reading, automation, or packet sniffing. Combat log parsing is done externally (same approach as Warcraft Logs). |
| **Combat log format changes** | Parsing breaks on WoW patches | Version the parser. Monitor PTR patch notes. Build automated tests against sample logs from each patch. |
| **Spell database maintenance** | Incorrect classifications ruin ratings | Automate seeding from Wowhead/WoW API. Community contribution system for corrections. Flag uncertain classifications. |
| **Population bootstrapping** | Percentiles meaningless with small sample size | Use absolute benchmarks initially (e.g., "X interrupts per minute is good for this dungeon"). Switch to population percentiles once N > 1000 runs per dungeon/bracket. |
| **Privacy / toxicity** | Players harassed based on rating | Opt-out for public profiles. Don't show other players' ratings in-game. Frame everything as "improvement" not "judgment." |
| **Log file size** | Full raid logs can be hundreds of MB | Segment logs by run on the desktop app before upload. Only upload M+ segments. Compress in transit. |

---

## 10. Success Metrics

- **Adoption:** 1,000 unique players uploading logs within 4 weeks of launch
- **Retention:** 50% of players upload logs from at least 3 separate sessions within their first month
- **Engagement:** Average 3+ run analysis page views per session
- **Rating accuracy:** Player Rating correlates with key level completion rate (higher-rated players time more keys)
- **Improvement signal:** Players who actively use MythicPulse show measurable KPI improvement over 30 days (lower avoidable damage, higher interrupt rate, etc.)

---

## 11. Additional Design Considerations

### 11.1 Affix-Aware Scoring

Affix combinations significantly affect expected performance. A Fortified + Bursting week plays very differently from Tyrannical + Bolstering. The rating engine must account for this:

- Store affix set per run and use it as a dimension when computing percentile ranks (i.e., compare players against runs with the same affix combo or affix difficulty tier)
- Group affixes into difficulty tiers so that percentile pools remain large enough to be statistically meaningful
- Seasonal affixes may warrant their own adjustment factor

### 11.2 Depleted / Untimed Key Handling

Not all runs are timed. Depleted keys still contain useful performance data but need special treatment:

- Depleted runs ARE included in KPI percentile calculations (a player who kicks well on a depletion still kicked well)
- Depleted runs receive a scoring penalty on the composite score (e.g., -10 points) to prevent rating inflation from repeated depletion farming
- The Player Rating rolling average weights timed runs more heavily than untimed runs

### 11.3 Duplicate Run Deduplication

When multiple party members upload logs from the same run, the system must detect and merge them:

- Deduplicate based on: dungeon + key level + timestamp (within a 5-second window) + party composition hash
- Accept the first upload as canonical; subsequent uploads from the same run enrich but don't duplicate
- All 5 party members' data is recorded regardless of who uploaded

### 11.4 Rate Limiting & Abuse Protection

- API rate limiting: max 10 uploads per hour per account, max 50 per day
- File size cap: 50 MB per upload (a single M+ log segment is typically 2–10 MB)
- Server-side validation: reject logs that don't contain valid M+ combat log markers
- IP-based throttling for unauthenticated endpoints

---

## 12. Resolved Decisions

1. **Weight tuning:** Current baseline weights (Section 5.2) are good enough to ship. Fine-tune with real data post-launch.
2. **Anti-gaming:** Deferred. Not a launch concern — address if/when it becomes a real problem with data to back it up.
3. **Spec normalization:** Resolved — **all percentile comparisons are spec-vs-spec.** A Resto Shaman is only compared to other Resto Shamans, a Fire Mage only to other Fire Mages, etc. This inherently solves the interrupt fairness problem (Resto Shamans who can kick are compared to other Resto Shamans, not to Holy Priests who can't). No KPI weight redistribution needed — the percentile pool itself handles it.
4. **Historical data:** Plan to import Warcraft Logs data via their public GraphQL API once the database is ready. See Section 13 for import strategy.
5. **Naming:** Deferred. Working title "MythicPulse" for now.

---

## 13. Warcraft Logs Data Import Strategy

Warcraft Logs provides a public **GraphQL API** (v2) that can be used to bootstrap the percentile database with historical run data. This is critical for solving the cold-start problem — without population data, percentile ranks are meaningless.

### 13.1 What's Available via the WCL API

- **Player reports:** Individual combat log reports including damage, healing, deaths, buffs/debuffs, casts, and interrupts — broken down per fight/encounter
- **Rankings:** Existing DPS/HPS percentile data per spec per encounter
- **Character data:** Gear, talents, spec for each logged character
- **Fight metadata:** Dungeon name, key level, affixes, duration, kill/wipe status, composition
- **Events:** Granular event-level data (damage events, healing events, casts, interrupts, debuff applications) — available per report

### 13.2 What's NOT Available (Gaps)

- **Avoidable damage classification:** WCL doesn't tag damage as "avoidable" — we'll need to cross-reference spell IDs against our own spell database after import
- **Defensive usage quality:** WCL tracks that a defensive was cast but not whether the timing was optimal — we can infer this from the surrounding damage events
- **Potion usage detail:** Available as buff/cast events but not pre-classified
- **Rate limits:** The WCL API has rate limits (~1,200 points/hour for free tier, higher with a paid API key). Bulk import will need to be throttled and run over days/weeks.

### 13.3 Import Plan

**Phase 1 — Seed percentile baselines (pre-launch):**
1. Register a WCL API client at warcraftlogs.com/api/clients
2. Query top M+ reports for the current season's dungeons across all key level brackets
3. For each report, pull fight-level summary data (damage, healing, deaths, composition, timing)
4. Pull event-level data for interrupts, buff/debuff tracking (defensives, potions)
5. Run imported data through the MythicPulse rating engine to build initial percentile distributions
6. Target: 10,000+ runs per dungeon across key level brackets to establish stable percentiles

**Phase 2 — Ongoing enrichment (post-launch):**
- Optionally allow users to link their WCL account and import their personal history
- Backfill percentile data as new seasons launch

### 13.4 Technical Approach

```
WCL GraphQL API
      │
      ▼
Import Worker (Edge Function, scheduled)
      │
      ├── Rate-limited query batches (~200 reports/hour)
      ├── Transform WCL event format → MythicPulse schema
      ├── Classify events using spell database
      │
      ▼
PostgreSQL (same tables as native uploads)
      │
      ▼
Rating Engine recalculates percentile distributions
```

The import worker runs as a scheduled Supabase Edge Function, processing batches within WCL's rate limits. Imported data is flagged with `source: 'wcl_import'` so it can be distinguished from native MythicPulse uploads.

### 13.5 API Access Requirements

- **Free tier:** 1,200 rate limit points/hour. A single report query costs ~3–5 points depending on complexity. Event-level queries cost more (~10–20 points per fight).
- **Paid tier / partnership:** Higher limits available. Worth reaching out to WCL once MythicPulse has traction — the tools are complementary, not competitive.
- **Auth:** OAuth2 client credentials flow. Register at https://www.warcraftlogs.com/api/clients
