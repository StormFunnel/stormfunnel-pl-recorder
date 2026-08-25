# License notes for the recorded data

Status 2026-08-25. **IMGW-PIB answered (reported by the owner, 2026-08-25):** (1) current warnings from the official danepubliczne.imgw.pl API — **free of charge, commercial use allowed, attribution required, no agreement needed**; (2) the map endpoint (`meteo.imgw.pl … osmet-teryt`) — **avoid in production**; (3) machine-readable warning history — available on formal request (wniosek), possibly for a fee. File the written answer with this repo when convenient. The recorder itself only reads public endpoints with a descriptive User-Agent at 6 requests/hour per endpoint.

## IMGW-PIB (danepubliczne.imgw.pl, meteo.imgw.pl)

- Legal basis for reuse: Polish Act of 11 August 2021 on open data and re-use of public sector information, implementing Directive (EU) 2019/1024, plus **Commission Implementing Regulation (EU) 2023/138** on high-value datasets (HVD). The Regulation's meteorological category lists **"weather alerts"** among HVDs, which must be available free of charge, in machine-readable form, via API, for any reuse including commercial, under CC BY 4.0 or an equivalent open licence.
- IMGW's own regulations (danepubliczne.imgw.pl/regulations) exempt HVD from its paid / signed-agreement regime for commercial use of measurement data, and require attribution: **"Źródłem pochodzenia danych jest Instytut Meteorologii i Gospodarki Wodnej – Państwowy Instytut Badawczy"** and, if processed, **"Dane IMGW-PIB zostały przetworzone"**.
- **Confirmed 2026-08-25 (owner-reported IMGW answer):** the `warningsmeteo` / `warningshydro` endpoints are free for commercial reuse with attribution, no agreement required. Machine-readable history (public archive is PDF-only) is a separate formal request, possibly paid.
- `imgw-osmet` — IMGW's answer: **avoid in production.** Recorded here for research/observation only; the product ingest must depend on `warningsmeteo`/`warningshydro` (+ Meteoalarm fallback), never on osmet.

## EUMETNET Meteoalarm (feeds.meteoalarm.org)

- Feed `<rights>` element, verified live: *"Licensed under terms equivalent to CC BY 4.0, with additional requirements for redistributing outlined in our Terms and Conditions."* Commercial use permitted.
- Terms and Conditions (meteoalarm.org/en/page/terms-and-conditions) and the Redistribution Hub add: single-country redistribution must credit the national met service (here IMGW-PIB); multi-country redistribution must credit "EUMETNET – MeteoAlarm"; **modified information must be redistributed together with the unmodified original**; the hub publishes a CAP profile and SLAs for redistributors.
- Attribution to carry on any product surface: source IMGW-PIB via Meteoalarm; keep the original CAP alongside anything derived.

## What this repo does with the data

- Stores raw responses (gzip) and derived observation records for research and to design an ingest. No public redistribution, no product surface, no resale.
- If the repo is public, the raw snapshots are technically redistributed. That is within CC BY 4.0-equivalent for Meteoalarm (attribution above) and within HVD reuse for IMGW; the attribution strings above are in this file and in README.md. If IMGW's written answer says otherwise, make the repo private — the recorder keeps working (see RUNBOOK step 0 for the cron change).

## Attribution block (copy verbatim where data is shown)

> Źródłem pochodzenia danych jest Instytut Meteorologii i Gospodarki Wodnej – Państwowy Instytut Badawczy. Dane IMGW-PIB zostały przetworzone. Warnings also sourced via EUMETNET Meteoalarm (meteoalarm.org), licensed under terms equivalent to CC BY 4.0.
