<!-- docsync: style=title -->

# Umakov 3D Gates & Fences Configurator

<!-- docsync: style=subtitle -->

## Discovery Inputs

# About this document

This document compiles a list of inputs Salsita will need in order to perform Discovery for the Gates & Fences configurator project and deliver it in a timely manner. We require those inputs in order to form a clear picture of the product and its constraints. We’ll study them offline in preparation for the first Discovery call.

We don’t require any specific format for this information, because we understand you will have most of it already, in various formats, and it’s much easier for everyone to provide what already exists. If you already have the requested information available, feel free to provide it directly as is. There’s no need to do additional work to, for example, make sure you have a separate document for each of the bullet points we describe: as long as the documents contain the information, we’re able to clearly understand the content, what’s actually in scope for this phase, and it’s up to date regarding the configurator project, it’s enough.

This document is tailored to the scope agreed in the Requirement Analysis. It takes into account what you have already shared with us during pre-discovery, and lists the remaining gaps. It’s not meant to be fully exhaustive, nor act as a checklist: more inputs will often be needed as our understanding of the configurable products and other project parameters evolves.

Where the railing configurator already established a format (the catalog spreadsheet, the BOM table, translations), we’ll happily reuse that format for gates and fences.

Any questions can be clarified by email or can be discussed live during the Kickoff meeting.

# What we already have

The following materials are already in the shared project folder. There is no need to send them again, unless a newer version exists:

- **Requirement Analysis** — the agreed high-level scope of this phase.
- **Aluminum fence catalog 2025/26** (ALUMINUM_FENCE-25-26-WEB-150dpi.pdf) — models 20 / 40 / 46, posts, gates, and accessories.
- **Design gallery for the configurator** (dizajny konfigurator v 26-06.pdf) — the AIR, LOUVRE, KLASIK, and LINE designs with slat dimensions, article numbers, and available colors.
- **Parameter sheet** (Parametre modelov AL plotov.xlsx) — per-design height and width limits, increments, slat colors, post area limits, adapters and brackets, gate compatibility, and the wall / pillar parameters.
- **Sample 3D models (STEP)** — the horizontal and vertical slat profiles with frames and posts, and three gate assemblies (pedestrian gate in two variants, wheeled sliding gate).

<!-- docsync:pagebreak -->

## Before Discovery starts (between contract signature and at latest 1 week after Kickoff)

**Product information**

- **Complete SKU list** for everything the configurator will put into the cart — the parameter sheet only contains partial codes (e.g. FG/FP50x60-...). We need the exact SKU for every combination of profile × color × stock length. This covers:
  - slats of all four families, in all colors and all stock lengths (1.2 – 6 m)
  - frame beams and crossbars (all 10 profiles × 2 post colors × stock lengths), including which frame profile / slot thickness belongs to which design
  - the AIR-ZERO and LINE “air-zero” filler profiles (F20x120, FC20, S20x100+S20x20)
  - posts (FP50x60, 56x60, PRO70x70, FP80x80, AL/9465) × 2 colors, their end caps, and base plates
  - fill adapters (FG/A20, FG/A40) with their cover profiles, and the crossbar / frame bracket (B2/01-80x25)
  - gate hardware: hinges (both types), gate stops, handles, locks, gate frame connectors
  - sliding gate running hardware: carriages, ground rail, upper guides, end stops, wheels
  - reinforcement profiles (support brace channels)
  - motors and pistons for each gate type and size threshold
  - screws, by target material (aluminum / concrete) and mount type
- **Slat colors** — the full list of the 7 slat colors (RAL 7016, RAL 9005, W01, W02, W03, natural aluminum, INOX, …), and which colors are available for each slat profile (the parameter sheet has this per design; please confirm it is per profile as well).
- **Color patterns** — the list of up to 20 predefined color patterns (e.g. slat 1 color A, slat 2 color B, repeat), with a name for each.
- **Post color** — confirm the 2 global post / frame colors (RAL 7016 and natural aluminum) and their names.
- **Pillar and wall materials** — the list of the 3 textures × 4 colors for pillars and walls, and the same for pillar caps and wall coping, with names.

**Rules**

The parameter sheet already captures most limits for fences. Please complete or confirm the following:

- **Gate frame** — the frame profile(s) used for each gate type, and how the frame dimensions relate to the ordered gate size (e.g. is the gate width the outer frame width, and what clearance to the posts is needed for hinges and the stop).
- **Vertical fills (KLASIK, LINE)** — the minimum and maximum spacing between slats for each slat width (the red cells in the parameter sheet), and the fixed crossbar offsets from the top and bottom for KLASIK.
- **Posts** — the height of the post end cap, so we can derive the post height from the fill height, and which post profiles have a flap for the adapter.
- **Ground clearance** — the gap between the ground and the bottom of the fill, on posts and on pillars.
- **Stock lengths** — for each length-based item, the list of available stock lengths (up to 4), and the cutting waste allowance (kerf) to use in the cutting optimization.
- Any other rule or constraint that is not on the list above and that the sales team applies when calculating a fence today.

**Formulas**

Prices come from the Shopify stores, so no pricing formula is needed. We do need the **bill of materials rules** for the automatically added material, ideally in the same sparse-table format as in the railing configurator (rows = designs, columns = SKUs, cells = quantities or multipliers):

- screws per slat, per mount (by mount SKU and target material), and per frame beam
- gate frame connectors per gate corner, by gate type
- sliding gate running hardware and end stops by gate type and size
- reinforcement profiles by gate type and size
- motors / pistons by gate type and size threshold
- lock SKU for non-motorized gates
- default handle and lock SKU by gate type and color
- gate stop SKU by gate type and color
- hinge pairs by gate type
- base plate SKU per post profile
- cover profile per adapter

If any of this exists in a form the sales team uses today (spreadsheet, calculator, or price list), please send it as is.

**Output examples**

- One or two **real quotes** the sales team prepared recently for a complete fence with a gate: the customer’s sketch, the calculated component list, and any visualization that was sent. This lets us verify the bill of materials the configurator produces against your current practice.
- If you would like the PDF summary to differ from the one generated by the railing configurator (layout, content, per-segment renders), a description or sketch of the changes. Otherwise we will follow the railing configurator.

<!-- docsync:pagebreak -->

## Before Discovery ends (4 weeks after Kickoff)

**3D assets**

We reviewed the STEP files provided so far and they are a good starting point. As agreed, please provide the final set — including the models we already have — simplified at the source to the visible geometry only (no threads, screws, or internal details), following the same naming as the article numbers:

- **Posts** — all 5 profiles (FP50x60, 56x60, PRO70x70, FP80x80, AL/9465), with their end caps and base plates.
- **Fill adapters** FG/A20 and FG/A40 with their cover profiles (FG/CA40x34, FG/CA60x40), and the crossbar / frame bracket B2/01-80x25, as mounted on a pillar.
- **Frame beams and crossbars** — all 10 profiles, including the LINE top / bottom frame and the KLASIK crossbar (the fence files we have show the frame only for some designs).
- **Missing slat profiles** — the AIR-ZERO filler profiles (F20x120, FC20), the LOUVRE 40/46 profiles (L40S 95, L40S 105, L40SL 95), and any AIR 40 profile not in the current set.
- **Gates** — the double-leaf gate and the self-supporting (cantilever) sliding gate assemblies, matching the pedestrian and wheeled gate assemblies we already have.
- **Gate hardware** — both hinge types, the 4 gate stops, handles and locks for each gate type, and the visible sliding gate hardware (carriages, ground rail, upper guides, end stops, wheels).
- **KeyShot scenes** — if the products already have UV-mapped, materialized models in KeyShot, exporting those (not only the renders) would save us most of the material work.
- **Textures and materials** — we will reuse the materials from the railing configurator where the finish is the same: RAL 7016 (anthracite), RAL 9005 (black), natural aluminum (anodized), and the INOX finish (please tell us whether it corresponds to the satin or the polished stainless steel of the railings). Please provide the rest:
  - the wood decors W01, W02 and W03 as high-resolution, seamless texture images — the railing configurator has a single oak decor; let us know if it matches one of them
  - the pillar / wall textures (3 textures × 4 colors) and the cap / coping materials as seamless texture images
- **Visual references** — real photographs of installed fences for each family (AIR, LOUVRE, KLASIK, LINE) and each gate type, including close-ups of the hinges, stops, handles, adapters and brackets on both posts and pillars, and of pillar caps and wall coping. The KeyShot renders from the design gallery are a good complement but do not replace photos.

**Branding**

- We assume the Gates & Fences configurator follows the same visual style as the railing configurator. Please confirm, and let us know about any brand changes (logo, colors, fonts) since the railing configurator was delivered.

**Integration**

- For each of the 7 Shopify stores (umakov.sk, umakov.cz, umakov.pl, umakov.hu, umakovshop.com, alwinox.at, umakovshop.it):
  - the Shopify collection containing all configurator product variants, with the `sku` property of each variant matching the SKU list above
  - confirmation that the existing Storefront API access from the railing configurator can be reused, or new access
- **Terminology** — the names of the families, designs, colors, materials, gate types, and all other product terms in the 8 languages (English, Czech, Slovak, Hungarian, Polish, German, French, Italian).
