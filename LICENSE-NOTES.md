# License notes for the recorded data

Status 2026-08-16. **Written confirmation from IMGW-PIB is pending** — until it arrives, treat the IMGW paragraph as our reading of the law and IMGW's published rules, not as a granted right. The recorder itself only reads public endpoints with a descriptive User-Agent at 6 requests/hour per endpoint; nothing here is redistributed yet.

## IMGW-PIB (danepubliczne.imgw.pl, meteo.imgw.pl)

- Legal basis for reuse: Polish Act of 11 August 2021 on open data and re-use of public sector information, implementing Directive (EU) 2019/1024, plus **Commission Implementing Regulation (EU) 2023/138** on high-value datasets (HVD). The Regulation's meteorological category lists **"weather alerts"** among HVDs, which must be available free of charge, in machine-readable form, via API, for any reuse including commercial, under CC BY 4.0 or an equivalent open licence.
- IMGW's own regulations (danepubliczne.imgw.pl/regulations) exempt HVD from its paid / signed-agreement regime for commercial use of measurement data, and require attribution: **"Źródłem pochodzenia danych jest Instytut Meteorologii i Gospodarki Wodnej – Państwowy Instytut Badawczy"** and, if processed, **"Dane IMGW-PIB zostały przetworzone"**.
- Not stated by IMGW verbatim for the `warningsmeteo` / `warningshydro` endpoints: that they are the HVD "weather alerts" dataset. Strongly implied by the Regulation; to be confirmed in writing (dane@imgw.pl / synoptyk.kraju@imgw.pl). Ask at the same time whether machine-readable warning history can be provided (the public archive is PDF-only) and whether the `meteo.imgw.pl … osmet-teryt` endpoint may be used by third parties.
- `imgw-osmet` is undocumented and carries no stated terms; recorded for research, do not build a product on it before the written answer.

## EUMETNET Meteoalarm (feeds.meteoalarm.org)

- Feed `<rights>` element, verified live: *"Licensed under terms equivalent to CC BY 4.0, with additional requirements for redistributing outlined in our Terms and Conditions."* Commercial use permitted.
- Terms and Conditions (meteoalarm.org/en/page/terms-and-conditions) and the Redistribution Hub add: single-country redistribution must credit the national met service (here IMGW-PIB); multi-country redistribution must credit "EUMETNET – MeteoAlarm"; **modified information must be redistributed together with the unmodified original**; the hub publishes a CAP profile and SLAs for redistributors.
- Attribution to carry on any product surface: source IMGW-PIB via Meteoalarm; keep the original CAP alongside anything derived.

## What this repo does with the data

- Stores raw responses (gzip) and derived observation records for research and to design an ingest. No public redistribution, no product surface, no resale.
- If the repo is public, the raw snapshots are technically redistributed. That is within CC BY 4.0-equivalent for Meteoalarm (attribution above) and within HVD reuse for IMGW; the attribution strings above are in this file and in README.md. If IMGW's written answer says otherwise, make the repo private — the recorder keeps working (see RUNBOOK step 0 for the cron change).

## Attribution block (copy verbatim where data is shown)

> Źródłem pochodzenia danych jest Instytut Meteorologii i Gospodarki Wodnej – Państwowy Instytut Badawczy. Dane IMGW-PIB zostały przetworzone. Warnings also sourced via EUMETNET Meteoalarm (meteoalarm.org), licensed under terms equivalent to CC BY 4.0.
