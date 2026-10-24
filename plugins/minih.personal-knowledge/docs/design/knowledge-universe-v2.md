# Knowledge Universe v2: 3D star-map redesign

- Status: Accepted by the user, 2026-10-24; revised the same day: 3D by default
- Amends: ADR 0001 §3 (type alias) and §10 (view)
- Replaces: the 0.2.0 view in `view/`; extends `lib/graph.mjs`
- Mockups: 3D (default) [`universe-3d-overview.svg`](universe-3d-overview.svg)
  and [`universe-3d-galaxy.svg`](universe-3d-galaxy.svg); flat chart mode
  [`universe-chart-overview.svg`](universe-chart-overview.svg) and
  [`universe-chart-galaxy.svg`](universe-chart-galaxy.svg). They were generated
  by running the layout of §4 on the user's real vault (228 notes) without
  writing to it. Their labels are anonymized because this repository is public.

## 1. Decisions

| Topic | Decision |
|---|---|
| Style | A 3D star map: the star chart's structure (crisp bodies, labeled galaxies, readable lines) rendered in 3D with depth, galaxy nebulae, bloom, and slow motion. The user found the flat chart alone too plain |
| Background | Deep-blue night sky |
| Default view | 3D (§7). The flat star chart (§5) is a reading mode behind the "星图" button, and the fallback when WebGL is unavailable |
| Layout | Fixed and deterministic. The same notes always give the same positions |
| Color | One color family per galaxy (project). A symbol shows the class |
| Events | Folded into a dotted ring around their galaxy. Inside a galaxy, a hovered planet shows its own events |

## 2. Problems in 0.2.0 that this fixes

| Problem | Evidence on the real vault |
|---|---|
| The map covers about a third of the screen | 11 top-bar controls, filter and legend panels open by default, a permanent timeline bar |
| Lines are invisible | 811 wikilinks drawn at opacity 0.06 and width 0.3 |
| One cluster dominates | The largest project has 42 planets and 120 events; 11 projects have only their project note |
| Radial clutter | 246 links come from navigation and overview pages |
| Nothing is named | No labels; every node needs a hover |
| Color carries class, not belonging | 12 class colors; galaxies cannot be told apart |
| Developer wording | Raw codes such as `topic` and `UNKNOWN_STATUS`; a "health 204" badge in the default view |
| Wrong class | 7 notes with `type: deployment`, all release records, are read as topics |

## 3. Graph payload additions

The layout and classification live in a new pure module, `lib/layout.mjs`.
`lib/graph.mjs` calls it, so the 2D view, the 3D view, and the tests use the
same numbers.

| Field | Values |
|---|---|
| `node.galaxy` | Galaxy id: a project note id, or `shared` |
| `node.kind` | `star`, `planet`, `moon`, `nav` |
| `node.ring` | `inner` or `outer` (planets only) |
| `node.x`, `node.y`, `node.z` | Layout position in world units (§4) |
| `link.kind` | One of the kinds in §3.4 |
| `galaxies[]` | `{ id, name, hue, planets, events, cx, cy, R }` |

### 3.1 Galaxy

The first rule that applies wins:

1. A project note is its own galaxy.
2. A note whose `project` points at a project note belongs to that project.
3. A note under `01 Projects/<Name>/` belongs to the project note whose title
   is `<prefix><Name>`. The prefixes come from `projectTitlePrefixes` in the
   ontology file (default `["项目 - "]`).
4. Anything else belongs to `shared`.

Rule 3 covers 23 notes that have no `project` today. The migration plan will
add the field; the view must not wait for it.

### 3.2 Kind

| Kind | Rule |
|---|---|
| `star` | Class `project` |
| `moon` | Family `event` (decision, release, incident, record) |
| `nav` | Family `navigation`, or an untyped note whose file name matches `navigationNamePatterns` in the ontology file (default `["(总览|索引)$", "^Home$"]`) |
| `planet` | Everything else. An untyped note that is not `nav` is a planet of class "unclassified" |

### 3.3 Ring

Inside a galaxy, sort the planets by degree (descending), then by id. The first
`ceil(n / 3)` planets are `inner`, the rest are `outer`. The class does not
choose the ring; the symbol shows the class (§5.3).

### 3.4 Link kind

Classify each unordered note pair once per predicate: two notes that link to
each other make one line. Apply the rules in this order. Counts are from the
real vault.

| Kind | Rule | Count | Default |
|---|---|---|---|
| `ghost` | The target does not exist | 18 | Hidden; health mode only |
| `hub` | Either end is `nav` | 246 | Hidden; health mode only |
| `typed` | Predicate other than `wikilink` and `project` | 4 | Shown |
| `parent` | Predicate `project`, or a wikilink between a star and a note of its own galaxy | 209 | Hidden: the orbits show belonging |
| `lane` | Wikilink between planets or stars of different galaxies | 42 links in 19 galaxy pairs | One line per galaxy pair |
| `tether` | Wikilink between an event and a planet | 145 | Galaxy view, hovered or selected planet only |
| `moon` | Wikilink between two events | 66 | Hovered event only |
| `constellation` | Wikilink between two planets of the same galaxy | 104 | Shown |

The overview shows 127 lines: 104 constellation lines, 19 lanes, 4 typed lines.

## 4. Layout

`lib/layout.mjs` exports one pure function from the classified payload to
positions. It uses no randomness, sorts with an id tie-break, and gives the same
result for any input order.

| Quantity | Rule |
|---|---|
| Galaxy radius | `R = 30 + 20 × √max(1, planets)` |
| Rings | Inner `0.48 R`, outer `0.86 R`, event ring `R + 12` |
| Ring slots | Even spacing. When the arc between slots is below 11, alternate slots at `0.88 r` and `1.12 r` |
| Ring start | Inner ring at `θ + π` (facing the center), outer ring at `θ + π + 0.3`, where `θ` is the galaxy's angle |
| Event order | By `created`, then id, clockwise from 12 o'clock |
| Shared galaxy | At the origin |
| Major galaxies | Galaxies with at least one planet. Sort by planets plus events (descending), then id. Each takes an angular share proportional to `R + 26`, placed in sequence from angle 0 |
| Major distance | `d = max(R_shared + 12 + 110 + R, (R + 26) / sin(min(share / 2, π / 2)))` |
| Macro stretch | Multiply galaxy-center x by `SX = 1.4`, because screens are wider than tall. Galaxies stay circular |
| Outer belt | Galaxies with no planet, sorted by name, on radius `max(reach of the other majors + 95, R_shared + 12 + 260)`. They spread over the full circle minus the largest galaxy's sector, half-width `atan2(R₀ + 60, d₀) + 0.12` |
| Frame | Radius = the largest node distance (`x / SX`, `y`) + 70 |
| 3D height | World `Y = −y`. Galaxy height `h`: 0 for the shared galaxy, `46 × sin(2θ + 1)` for major galaxies, `18 × sin(2θ + 1)` for the belt, where `θ = atan2(cy, cx)` |
| 3D disk tilt | Each galaxy's disk tilts by `TILT = 0.38` rad, far side up. A note at offset `(dx, dy)` from its galaxy center sits at `X = cx + dx`, `Y = −(cy + dy × cos TILT)`, `Z = h − dy × sin TILT` |

On the real vault this puts the largest galaxy at 22% of the frame width.

Entering a galaxy moves no node. Only the camera moves, and the line and label
rules change (§6).

## 5. Visual system (flat chart mode, and the base of §7)

### 5.1 Canvas

- Sky: radial gradient from `#13234a` at the center to `#070d1d` at the edge.
- Field stars: about 260 per 1600 × 1000 area from a fixed-seed generator.
  Radius 0.3–1.0, opacity 0.15–0.45, static, not interactive.
- Graticule, centered on the shared galaxy: three dashed ellipses (opacity
  0.10, dash `2 6`) and 12 radial lines (opacity 0.06).
- Planisphere frame: one ellipse (opacity 0.28) with 120 ticks; every tenth
  tick is longer.
- In the galaxy view the graticule is centered on the galaxy, and there is no
  frame.

### 5.2 Palette

| Galaxy | Hue |
|---|---|
| Largest four major galaxies, by size | `#f2c27b`, `#7fd3e0`, `#b9a7f5`, `#8fe3b0` |
| Further major galaxies | Cycle `#f0a3b5`, `#a3c8f0`, `#d9e38f` |
| Shared | `#dbe6ff` |
| Outer belt | `#e8e2d0` |

Planets mix their galaxy hue 55% toward white; galaxy labels mix it 25% toward
white.

### 5.3 Symbols

The magnitude class is `m = min(4, floor(log2(1 + degree) / 1.4))`. It gives a
planet radius `r` of 1.4, 1.9, 2.5, 3.2, or 4.0 px at the fit zoom. Multiply by
1.6 in the galaxy view.

| Class | Symbol |
|---|---|
| Project | White disk, `r = min(8, 3.5 + 0.8 × √(1 + planets))`, plus a 1 px ring at `r + 4` in the galaxy hue |
| Topic | Solid dot |
| Procedure | Dot with a horizontal bar of `2.2 r` on each side |
| Reference | Ring `1.5 r` with a center dot `0.55 r` |
| Environment | Dashed ring `1.7 r` with a dot `0.7 r` |
| Technology | Diamond outline, half-diagonal `1.4 r` |
| Convention | Open circle `1.2 r` |
| Organization | Ellipse outline `1.9 r × 0.9 r` |
| Unclassified | Solid dot at 50% opacity |
| Event | Dot `r = 1.1` (2.0 in the galaxy view) in the galaxy hue, opacity 0.7 (0.85) |
| Shared center | 3 px white dot with a 7 px ring |

### 5.4 Lines

| Kind | Style |
|---|---|
| Constellation | 0.8 px in the galaxy hue. Opacity 0.45 in the overview and 0.25 in the galaxy view. Both ends stop 2.5 px short of the symbol |
| Lane | Quadratic curve bowed by 12% of its length, dash `6 6`, galaxy hue, opacity 0.32, width `0.6 + 0.2 × links` up to 1.8 |
| Typed | 1.2 px white at 0.75 with a small arrowhead at mid-length. Hover shows the predicate in words |
| Tether | 0.8 px white at 0.7. Drawn only for the hovered or selected planet, and only when it has at most 12 events. Above that, its events light up on the ring (radius × 1.6, opacity 1) and the drawer lists them. One planet on the real vault has 105 links |
| Orbits | Inner and outer rings, 0.6 px, galaxy hue at 0.10 |
| Event ring | Dotted (`1 3`), galaxy hue at 0.30 in the overview and 0.22 in the galaxy view |

### 5.5 Typography

| Text | Style |
|---|---|
| Galaxy name | Serif stack `"Songti SC", "Noto Serif SC", "Source Han Serif SC", serif`. 17 px, semibold, letter-spacing 0.14 em, below the event ring |
| Galaxy caption | 11 px at 70% opacity, for example "42 颗行星 · 120 个事件" |
| Belt name | Sans 11 px |
| Planet name | Sans 10.5 px in the overview and 12 px in the galaxy view, `#c9d4f0`. Drop the prefixes "`<galaxy name> - `" and "`资料 - `" |
| Halo | Every label gets a 3 px `#0a1430` halo (`paint-order: stroke`) |

Label budget:

- Galaxy names are always shown.
- Planet names are chosen by degree with greedy collision avoidance: at most
  12 in the overview and 18 in the galaxy view.
- The hovered node's name always wins a collision.
- In the overview, planet names appear only at 1.6 × the fit zoom or more.

### 5.6 States

| State | Effect |
|---|---|
| Rest | As above |
| Hover | The node's lines turn white (opacity 0.9, width 1.3); all other lines drop to 40% of their opacity. A card shows the title, the class in words, the galaxy, and `updated` |
| Selected | White ring at `r + 6`; the drawer opens |
| Search hit | The ring pulses twice; no pulse under reduced motion |

## 6. Views and navigation

1. The overview fits the frame and shows every galaxy name.
2. Click a star or a galaxy name, or press Enter on a search hit, to enter its
   galaxy. The camera eases for 400 ms until the event ring fills 80% of the
   height, left of the drawer.
3. The breadcrumb reads "宇宙 › <galaxy>". Press Esc or click "宇宙" to return.
4. Use the wheel, a pinch, or the + and − buttons to zoom. Double-click empty
   sky to fit.
5. Click a planet to open the drawer. It has these groups:
   - "<class> · 属于 <galaxy>";
   - 关联: constellation and typed neighbors;
   - 相关事件: tethers;
   - 被引用: backlinks;
   - 维护提示: collapsed by default, with issues in words;
   - the redacted preview from `kg.note`;
   - the "复制 Obsidian 链接" button.

## 7. 3D view (default)

The 3D view draws the same galaxies, symbols, line kinds, label budget, and
states as the chart, placed with the 3D rules of §4. It adds the following.

| Element | Specification |
|---|---|
| Camera | Perspective, FOV 40°. Overview: elevation 0.60 rad above the plane, target `(0, −70, 0)`, distance chosen so the frame fills 92% of the viewport width. Galaxy view: elevation 0.62 rad, target the galaxy center, distance `4.2 × event-ring radius`, view center shifted to 37% of the width so the drawer covers nothing |
| Controls | Orbit on drag, zoom on wheel or pinch, pan with right-drag. Elevation is clamped to 0.15–1.35 rad |
| Starfield | 2,500 points on a shell at `6 × frame` from a fixed seed. 7% are bright (1.6–2.4 px), the rest 0.4–1.0 px. Colors: 15% warm `#ffd9b0`, 15% cool `#b9d0ff`, the rest `#e6ecff`. No size attenuation |
| Nebulae | One additive sprite per major galaxy and one for the shared galaxy: radius `2.1 × event ring`, elliptical 1.25 : 0.8, galaxy hue from opacity 0.26 at the center to 0 |
| Ecliptic grid | Four dashed ellipses on `z = 0` at 0.30, 0.55, 0.80, and 1.00 × frame, opacity 0.10. In the galaxy view: rings in the galaxy plane |
| Stars | Emissive white-gold sphere with the §5.3 radius, plus an additive corona sprite (6.5 × r for major galaxies, 5 × r for the belt) shading from white through the galaxy hue to transparent. The corona breathes ±6% over 6 s |
| Planets | Camera-facing sprites with a shaded-sphere texture: highlight at (35%, 32%), the galaxy hue at 45%, `#1a2040` at the edge. Radius from §5.3 × 1.15, scaled by perspective. Class marks as thin sprites: reference and environment get a tilted ring (dashed for environment), procedure gets a bar |
| Events | One `THREE.Points` set per galaxy on its event ring, in the galaxy hue. The ring turns 0.01 rad/s about the galaxy axis |
| Lines | Constellation lines additive, opacity 0.42 in the overview and 0.28 in the galaxy view. Lanes are arcs lifted by `4u(1 − u) × 0.2 × length` along their length, 24 segments, dash 5 and gap 6, opacity 0.38. Typed lines at 0.8 opacity carry one flowing particle each (0.15 of the length per second) |
| Bloom | `UnrealBloomPass`: strength 1.1, radius 0.6, threshold 0.2, followed by `OutputPass`. Device pixel ratio capped at 2. Above 2,000 nodes bloom is off |
| Depth | Exponential fog, density `0.35 / frame`, so far bodies dim to no less than 45% |
| Labels | `CSS2DRenderer` DOM labels, so CJK text stays sharp. Galaxy names in the serif stack with a soft text glow. Collision checks run in screen space, throttled to 10 Hz |
| Intro | On open, the camera eases over 1.6 s from 1.6 × distance and elevation 0.9 to the overview |
| Idle drift | After 20 s without input, the camera orbits at 0.6°/s. Any input stops it |
| Reduced motion | No intro, no drift, no ring rotation, no breathing, no particles |
| WebGL unavailable | If the WebGL context cannot be created, the view opens in chart mode and shows one line: "3D 不可用，已切换为星图" |

Rendering stack: `3d-force-graph` with fixed node positions (`fx`, `fy`, `fz`
set from §4; `cooldownTicks(0)`), its `postProcessingComposer()`, and
`extraRenderers([new CSS2DRenderer()])`. The vendored bundle has
`EffectComposer` and `RenderPass` but no `UnrealBloomPass`.
`scripts/build.mjs` therefore bundles one entry, `view/vendor/universe-3d.mjs`.
It re-exports `3d-force-graph`, `three`, `UnrealBloomPass`, `OutputPass`, and
`CSS2DRenderer` from a single copy of `three`, the version `3d-force-graph`
resolves (0.186.1 today), so the passes and the renderer share one `three`
instance.

The "星图" button in the top-right switches between the 3D view and chart
mode (§5). The choice is remembered in `localStorage`.

## 8. Chrome and panels

| Area | Content |
|---|---|
| Top left | Title in the serif stack, then the note count, or the breadcrumb inside a galaxy |
| Top center | Search, 380 px wide; `/` focuses it |
| Top right | 3D/星图, Layers (≡), Settings (⚙) |
| Bottom right | Zoom + and − |

- **Layers menu** has toggles for event rings (on), constellation lines (on),
  lanes (on), navigation pages (off), and unresolved links (off). It also has
  class and stability filters. The archived and memory toggles appear only
  when that data exists.
- **Settings menu** opens health mode, time-lapse mode, retrieval settings (the
  existing panel), and language. Language follows the host until the user
  changes it.
- **Health mode** colors symbols by issue severity and lists the issues in a
  right panel. The default view shows no health badge.
- **Time-lapse mode** is the only place the timeline bar appears.
- The map covers at least 90% of the viewport whenever no panel is open.

## 9. Wording

| Class | zh-CN | en |
|---|---|---|
| `project` | 项目 | Project |
| `topic` | 主题 | Topic |
| `environment` | 环境 | Environment |
| `organization` | 组织 | Organization |
| `technology` | 技术 | Technology |
| `reference` | 资料 | Reference |
| `convention` | 规范 | Convention |
| `procedure` | 流程 | Procedure |
| `decision` | 决策 | Decision |
| `release` | 发布 | Release |
| `incident` | 事故 | Incident |
| `record` | 记录 | Record |
| navigation classes | 导航 | Navigation |
| unclassified | 未分类 | Unclassified |

| Issue code | zh-CN | en |
|---|---|---|
| `UNKNOWN_STATUS` | 状态取值不在规范里 | Status is not a known value |
| `LEGACY_TYPE` | 类型用的是旧写法 | Type uses a legacy name |
| `UNKNOWN_TYPE` | 没有写类型 | Type is missing |
| `UNKNOWN_STABILITY` | 稳定性取值不规范 | Stability is not a known value |
| `ORPHAN` | 没有任何链接 | No links |
| `OVERSIZE` | 笔记过长（超过 2.4 万字） | Note is too long (over 24,000 characters) |
| `STALE` | 超过复核周期 | Past its review window |
| `DOMAIN_VIOLATION`, `RANGE_VIOLATION` | 关系两端的笔记类型不对 | A relation links the wrong kinds of notes |
| `CARDINALITY_VIOLATION` | 这个关系只能有一个值 | This relation takes one value |
| `UNKNOWN_PREDICATE_TARGET` | 关系指向的笔记不存在 | The relation points to a missing note |
| `FRONTMATTER_INVALID` | 属性区格式错误 | Properties block is malformed |

Codes appear only inside health mode, next to the words.

## 10. Configuration and data changes

- `config/ontology.default.yaml`:
  - move `deployment` from `topic` to `release` in `typeAliases`;
  - add `navigationNamePatterns`;
  - add `projectTitlePrefixes`.
- Follow-ups for the migration plan, not part of this change:
  - add `project` to the 23 folder-inferred notes;
  - add `type` to the 8 untyped notes.

## 11. Removed from 0.2.0

- glow shells (replaced by a real bloom pass in §7);
- free automatic rotation (replaced by the idle drift in §7);
- default particles on every link (only typed links keep one);
- the free force simulation;
- the always-open filter and legend panels;
- the permanent timeline bar;
- the health badge;
- the EN button.

## 12. Development checks

1. `node --test` covers:
   - galaxy inference, including the folder rule;
   - kind rules, including `navigationNamePatterns`;
   - the ring split;
   - link-kind counts on a fixture vault;
   - the `deployment` alias;
   - layout determinism: shuffling the input order gives identical positions.
2. Export the real payload read-only to a temporary directory and never commit
   it. Render the view in BrowserPreview with a stub bridge. Take screenshots of
   the 3D overview, the 3D galaxy view, hover, the drawer, health mode, and
   chart mode.
3. On those screenshots, check:
   - the map covers at least 90% of the viewport;
   - every galaxy name is readable;
   - the overview has 120–135 lines (127 today);
   - the largest galaxy is at most 40% of the width (22% today);
   - the overview shows at most 12 planet names.
4. Measure frame rate on the user's M5 Pro at device pixel ratio 2: at least
   50 fps for the 3D view with bloom, at least 55 fps for chart pan and zoom.
5. Under `prefers-reduced-motion` there is no intro, drift, ring rotation,
   breathing, particle, camera easing, or pulse.
6. A stub that makes WebGL context creation fail opens chart mode with the
   notice.
7. Tests never touch the real `~/.personal-knowledge` (use the existing
   isolation helper).

## 13. Release

Ship as the next patch of the line that does not declare `memory.read`. The
memory work (0.3.0, ADR 0001 §11) rebases on it. Memory satellites in the star
chart use the galaxy hue, the four-point sparkle symbol, and sit just outside
the event ring.
