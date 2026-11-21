"""
fetch_entsoe_units.py
=====================
Download ONE real hour of unit-by-unit production from the ENTSO-E
Transparency Platform (RESTful API, https://transparency.entsoe.eu) for every
country of a bundle: *Actual Generation per Generation Unit* (Regulation
543/2013 art. 16.1.A — the units of 100 MW or more), averaged over the hour
that starts at ``--at``.

A unit is a *production unit* — the EIC code powerplantmatching records for
its plants (``match_power_plants.py`` keeps it): its output is what its
generation units produce minus what they draw (pumping, a stopped unit's
auxiliaries). A unit the hour has no value for is left out. With the result,
``build_situation.py --units`` gives every unit it finds on the network its
own output, and shares the rest of each type's production as before.

The API needs a security token (free, on request from ENTSO-E), read from
``--token-file`` or the ``ENTSOE_API_KEY`` environment variable. It travels
in a request header — never in a URL, a log line or the output.

Output (schema ``costudy4grid-unit-hour/1``)::

    {"at_utc": "2025-01-14T08:00Z", "source": {...},
     "countries": {"FR": {"areas": ["10YFR-RTE------C"],
                          "units": [{"eic": "17W100P100P0198Z", "name": "CIVAUX 2",
                                     "type": "B14", "mw": 1513.0,
                                     "parts": ["17W100P100P0114U"]}, …]}},
     "missing": {"HR": "no data for this hour"}}

Usage
-----
    python scripts/pypsa_eur/fetch_entsoe_units.py --token-file ~/entsoe_token.txt \\
        --network data/pypsa_eur_eur220_225_380_400/network.xiidm.zip \\
        --at 2025-01-14T08:00Z \\
        --out data/pypsa_eur_eur220_225_380_400/situations/entsoe_units_2025-01-14T0800Z.json
"""
from __future__ import annotations

import argparse
import io
import json
import logging
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)

API = "https://web-api.tp.entsoe.eu/api"
SCHEMA = "costudy4grid-unit-hour/1"
SOURCE = {
    "name": "ENTSO-E Transparency Platform",
    "url": "https://transparency.entsoe.eu",
    "dataset": "Actual Generation per Generation Unit [16.1.A]",
}
TOKEN_ENV = "ENTSOE_API_KEY"
NS = {"n": "urn:iec62325.351:tc57wg16:451-6:generationloaddocument:3:0"}
#: ISO 3166 code → the control areas the API reports units for (Germany's
#: four TSOs; the country and bidding-zone codes return nothing).
CONTROL_AREAS = {
    "AL": ("10YAL-KESH-----5",), "AT": ("10YAT-APG------L",), "BA": ("10YBA-JPCC-----D",),
    "BE": ("10YBE----------2",), "BG": ("10YCA-BULGARIA-R",), "CH": ("10YCH-SWISSGRIDZ",),
    "CZ": ("10YCZ-CEPS-----N",),
    "DE": ("10YDE-VE-------2", "10YDE-RWENET---I", "10YDE-EON------1", "10YDE-ENBW-----N"),
    "DK": ("10Y1001A1001A796",), "ES": ("10YES-REE------0",), "FR": ("10YFR-RTE------C",),
    "GR": ("10YGR-HTSO-----Y",), "HR": ("10YHR-HEP------M",), "HU": ("10YHU-MAVIR----U",),
    "IT": ("10YIT-GRTN-----B",), "LT": ("10YLT-1001A0008Q",), "LU": ("10YLU-CEGEDEL-NQ",),
    "MD": ("10Y1001A1001A990",), "ME": ("10YCS-CG-TSO---S",), "MK": ("10YMK-MEPSO----8",),
    "NL": ("10YNL----------L",), "PL": ("10YPL-AREA-----S",), "PT": ("10YPT-REN------W",),
    "RO": ("10YRO-TEL------P",), "RS": ("10YCS-SERBIATSOV",), "SI": ("10YSI-ELES-----O",),
    "SK": ("10YSK-SEPS-----K",), "UA": ("10Y1001C--00003F",), "XK": ("10Y1001C--00100H",),
}
PAUSE_S = 0.5
RETRIES = 5


def parse_instant(text: str) -> datetime:
    """``2025-01-14T08:00Z`` → aware UTC datetime."""
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)


def network_countries(path: Path) -> list[str]:
    """Countries of the substations of an XIIDM file (or its ``.zip``)."""
    if path.suffix == ".zip":
        with zipfile.ZipFile(path) as zf:
            text = zf.read(zf.namelist()[0]).decode("utf-8", errors="replace")
    else:
        text = path.read_text(encoding="utf-8", errors="replace")
    return sorted(set(re.findall(r'<iidm:substation [^>]*country="([A-Z]{2})"', text)))


def read_token(path: Path | None) -> str:
    token = path.read_text(encoding="utf-8").strip() if path else os.environ.get(TOKEN_ENV, "").strip()
    if not token:
        raise SystemExit(f"No ENTSO-E token: pass --token-file or set {TOKEN_ENV}")
    return token


def _get(token: str, **params) -> bytes | None:
    """One API call (the token in a header), retried with backoff on rate
    limits and timeouts; the XML document, unzipped, or ``None``."""
    request = urllib.request.Request(f"{API}?{urllib.parse.urlencode(params)}",
                                     headers={"SECURITY_TOKEN": token})
    delay = PAUSE_S
    for attempt in range(RETRIES):
        time.sleep(PAUSE_S)
        try:
            with urllib.request.urlopen(request, timeout=180) as resp:
                body = resp.read()
            if body[:2] == b"PK":
                with zipfile.ZipFile(io.BytesIO(body)) as zf:
                    body = zf.read(zf.namelist()[0])
            return body
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise SystemExit("ENTSO-E refused the token (HTTP 401)") from None
            if e.code in (429, 500, 502, 503, 504):
                delay *= 2
                log.info("  %s HTTP %s — retry in %.0f s", params.get("in_Domain"), e.code, delay)
                time.sleep(delay)
                continue
            log.warning("  %s: HTTP %s", params.get("in_Domain"), e.code)
            return None
        except (urllib.error.URLError, TimeoutError) as e:
            delay *= 2
            log.info("  %s: %s — retry in %.0f s (%d/%d)", params.get("in_Domain"), e, delay,
                     attempt + 1, RETRIES)
            time.sleep(delay)
    log.warning("  %s: no answer after %d attempts", params.get("in_Domain"), RETRIES)
    return None


def _minutes(resolution: str) -> int:
    match = re.fullmatch(r"PT(\d+)M", resolution)
    if match is None:
        raise ValueError(f"unexpected resolution {resolution!r}")
    return int(match.group(1))


def _series_mean(ts: ET.Element, at: datetime) -> float | None:
    """A time series' mean over [at, at + 1 h); a variable-sized block
    (curve ``A03``) holds its value until the next point."""
    curve = ts.findtext("n:curveType", namespaces=NS)
    end_hour = at + timedelta(hours=1)
    values = []
    for period in ts.findall("n:Period", NS):
        start = parse_instant(period.findtext("n:timeInterval/n:start", namespaces=NS))
        end = parse_instant(period.findtext("n:timeInterval/n:end", namespaces=NS))
        step = timedelta(minutes=_minutes(period.findtext("n:resolution", namespaces=NS)))
        points = {int(p.findtext("n:position", namespaces=NS)): float(p.findtext("n:quantity", namespaces=NS))
                  for p in period.findall("n:Point", NS)}
        held = None
        for pos in range(1, int((end - start) / step) + 1):
            held = points.get(pos, held if curve == "A03" else None)
            t = start + (pos - 1) * step
            if held is not None and at <= t < end_hour:
                values.append(held)
    return sum(values) / len(values) if values else None


def parse_units(xml: bytes, at: datetime) -> list[dict]:
    """Production units of one document with their hour's mean output (MW):
    generation in, consumption (``outBiddingZone``) out."""
    root = ET.fromstring(xml)
    units: dict[str, dict] = {}
    for ts in root.findall("n:TimeSeries", NS):
        mw = _series_mean(ts, at)
        if mw is None:
            continue
        part = ts.findtext("n:MktPSRType/n:PowerSystemResources/n:mRID", namespaces=NS)
        # A series may name its generation unit alone (a Polish one does).
        eic = ts.findtext("n:registeredResource.mRID", namespaces=NS) or part
        if eic is None:
            continue
        name = ts.findtext("n:MktPSRType/n:PowerSystemResources/n:name", namespaces=NS) or ""
        sign = -1.0 if ts.find("n:outBiddingZone_Domain.mRID", NS) is not None else 1.0
        unit = units.setdefault(eic, {"eic": eic, "name": name.strip(),
                                      "type": ts.findtext("n:MktPSRType/n:psrType", namespaces=NS),
                                      "mw": 0.0, "parts": []})
        unit["mw"] += sign * mw
        if part and part not in unit["parts"]:
            unit["parts"].append(part)
    for unit in units.values():
        unit["mw"] = round(unit["mw"], 1)
    return sorted(units.values(), key=lambda u: u["eic"])


def fetch_country(token: str, iso: str, at: datetime) -> dict | None:
    """The production units of one country over the hour (``None`` when the
    API covers none of its control areas)."""
    areas = CONTROL_AREAS.get(iso)
    if not areas:
        return None
    window = {"periodStart": at.strftime("%Y%m%d%H%M"),
              "periodEnd": (at + timedelta(hours=1)).strftime("%Y%m%d%H%M")}
    units: list[dict] = []
    for area in areas:
        xml = _get(token, documentType="A73", processType="A16", in_Domain=area, **window)
        if xml is not None and b"<TimeSeries>" in xml:
            units += parse_units(xml, at)
    return {"areas": list(areas), "units": units} if units else None


def run(countries: list[str], at: datetime, out: Path, token: str) -> dict:
    record = {
        "schema": SCHEMA,
        "at_utc": at.strftime("%Y-%m-%dT%H:%MZ"),
        "source": SOURCE,
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "countries": {},
        "missing": {},
    }
    for iso in countries:
        log.info("%s …", iso)
        data = fetch_country(token, iso, at)
        if data is None:
            record["missing"][iso] = ("no control area known" if iso not in CONTROL_AREAS
                                      else "no data for this hour")
            log.warning("  %s: %s", iso, record["missing"][iso])
            continue
        record["countries"][iso] = data
        log.info("  %d units, %.0f MW", len(data["units"]), sum(u["mw"] for u in data["units"]))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(record, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    log.info("Wrote %s (%d countries, missing: %s)", out, len(record["countries"]),
             ", ".join(record["missing"]) or "none")
    return record


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--at", required=True, help="UTC instant, e.g. 2025-01-14T08:00Z")
    parser.add_argument("--out", required=True, type=Path, help="Output JSON file")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--network", type=Path,
                       help="XIIDM network (or .zip) whose countries to fetch")
    group.add_argument("--countries", help="Comma-separated ISO codes, e.g. FR,DE,ES")
    parser.add_argument("--token-file", type=Path, default=None,
                        help=f"File holding the API security token (default: ${TOKEN_ENV}).")
    args = parser.parse_args()
    countries = ([c.strip().upper() for c in args.countries.split(",") if c.strip()]
                 if args.countries else network_countries(args.network))
    run(countries, parse_instant(args.at), args.out, read_token(args.token_file))


if __name__ == "__main__":
    main()
