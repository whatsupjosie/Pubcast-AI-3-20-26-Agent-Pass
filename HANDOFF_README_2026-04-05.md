# PubCast Full Handoff — 2026-04-05

This repository update is a pass-forward handoff note for the PubCast materials available in the current working session.

## What exists in the current session bundle

- current candidate dressing-room build
- facility map artifacts
- reference room images
- avatar / ethereal / skeleton docs
- Pete and Jeremy config JSON files
- prior source zip archives used as historical branches / pass-through bundles

## Current state summary

### Dressing Room
A dressing-room prototype has been wired, but it is **not fully trustworthy yet**.

Known working / mostly working:
- main dressing-room image references
- makeup station close-up
- corkboard close-up
- coffee-table close-up
- typewriter / scripts / foundry subviews
- Esc exits overlays

Known incomplete / must-fix:
- Dressing Room -> Green Room transition is still a placeholder, not a real room handoff
- top HUD Green Room route is also placeholder
- mirror is a lightweight live reflected-avatar implementation, not a final room-accurate mirror interaction
- hotspot placement still needs a visual audit against the final dressing-room art

### Facility map logic locked in
- Dressing Room <-> Green Room
- Green Room -> Control Room / Studio / Vortex Bar / Hallway
- Hallway -> Writer's Room or stairs to Movie Theater Entrance Hall
- Movie Theater Entrance Hall -> Lobby
- Lobby -> Front Doors and stairs to Lobby Balcony
- Lobby Balcony -> Projectionist's Booth / Purplis's Office
- Vortex Bar -> Green Room / Parking Lot / Basement Screening Room
- Studio -> set zone -> volume-stage threshold -> Pub World

Parking lot and hallway transition are acknowledged placeholder / no-image areas.

## Honesty note
This handoff is real, but it is **not a claim that the entire PubCast codebase is now unified or fully working**.
It reflects the current session state and the current candidate build direction.

## Recommended first checks
1. Replace fake Green Room transition with a real room handoff.
2. Audit dressing-room hotspot coordinates against final art.
3. Decide which historical source archive is authoritative before merging further.
4. Use the accepted facility map logic above as the routing spine.

## Requested follow-up
The current full local session bundle also includes a large archive containing the current handoff package and source archives. That binary bundle has not been committed by this connector in this update.
