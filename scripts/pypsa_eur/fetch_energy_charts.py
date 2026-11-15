"""
fetch_energy_charts.py
======================
Download ONE real hour of the European power system from the Energy-Charts
API (Fraunhofer ISE, https://api.energy-charts.info — data CC BY 4.0,
attribution "energy-charts.info"), for every country of a bundle:

  * ``total_power``     — load and net production per production type (MW),
                          averaged over the hour that starts at ``--at``,
                          industrial self-supply included where published
                          (Germany: ~7 GW the public figures leave out);
                          else ``public_power``;
  * ``cbpf``            — cross-border physical flows per neighbour (MW,
                          positive = import), same hour;
  * ``installed_power`` — installed capacity per production type (MW), at the
                          end of the last full year before ``--at``.

The result (schema ``costudy4grid-observed-hour/1``) feeds
``build_situation.py``, which rebuilds the bundle's loads and dispatch on that
hour. Countries the API does not cover (Albania) or returns nothing for are
listed under ``missing``; the builder fills them in.

Usage
-----
    python scripts/pypsa_eur/fetch_energy_charts.py \\
        --network data/pypsa_eur_eur220_225_380_400/network.xiidm \\
        --at 2025-01-14T08:00Z \\
        --out data/pypsa_eur_eur220_225_380_400/situations/energy_charts_2025-01-14T0800Z.json

    # Refetch some countries into an existing file
    python scripts/pypsa_eur/fetch_energy_charts.py --countries DE --update \\
        --at 2025-01-14T08:00Z --out .../energy_charts_2025-01-14T0800Z.json
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)

API = "https://api.energy-charts.info/v2"
SCHEMA = "costudy4grid-observed-hour/1"
SOURCE = {
    "name": "Energy-Charts (Fraunhofer ISE)",
    "url": "https://www.energy-charts.info",
    "licence": "CC BY 4.0",
    "attribution": "energy-charts.info",
}
#: ISO 3166 code → Energy-Charts country code, where they differ.
API_CODE = {"GB": "uk"}
#: Countries the API accepts (``/v2`` catalog, 2026-11).
API_COUNTRIES = {
    "ch", "at", "ba", "be", "bg", "cy", "cz", "de", "dk", "ee", "es", "fi", "fr", "ge",
    "gr", "hr", "hu", "ie", "it", "lt", "lu", "lv", "md", "me", "mk", "nl", "no", "pl",
    "pt", "ro", "rs", "se", "si", "sk", "ua", "uk", "xk",
}
#: ``cbpf`` neighbour series id → ISO 3166 code.
NEIGHBOUR_ISO = {
    "albania": "AL", "austria": "AT", "belarus": "BY", "belgium": "BE",
    "bosnia_and_herzegovina": "BA", "bosnia_herzegovina": "BA", "bulgaria": "BG",
    "croatia": "HR", "cyprus": "CY", "czech_republic": "CZ", "czechia": "CZ",
    "denmark": "DK", "estonia": "EE", "finland": "FI", "france": "FR", "georgia": "GE",
    "germany": "DE", "greece": "GR", "hungary": "HU", "ireland": "IE", "italy": "IT",
    "kosovo": "XK", "latvia": "LV", "lithuania": "LT", "luxembourg": "LU", "malta": "MT",
    "moldova": "MD", "montenegro": "ME", "morocco": "MA", "netherlands": "NL",
    "north_macedonia": "MK", "norway": "NO", "poland": "PL", "portugal": "PT",
    "romania": "RO", "russia": "RU", "serbia": "RS", "slovakia": "SK", "slovenia": "SI",
    "spain": "ES", "sweden": "SE", "switzerland": "CH", "turkey": "TR", "turkiye": "TR",
    "ukraine": "UA", "united_kingdom": "GB",
}
#: ``public_power`` series that are not a production type.
NOT_PRODUCTION = {
    "load", "load_incl_self_consumption", "residual_load", "cross_border_electricity_trading",
    "renewable_share_of_load", "renewable_share_of_generation",
}
PAUSE_S = 1.5
RETRIES = 6


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


def _get(endpoint: str, **params) -> dict | None:
    """One API call, retried with backoff on rate limits and timeouts;
    ``None`` when the API has nothing for these parameters."""
    url = f"{API}/{endpoint}?{urllib.parse.urlencode(params)}"
    delay = PAUSE_S
    for attempt in range(RETRIES):
        time.sleep(PAUSE_S)
        try:
            with urllib.request.urlopen(url, timeout=90) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                delay *= 2
                log.info("  %s %s — retry in %.0f s", endpoint, e.code, delay)
                time.sleep(delay)
                continue
            log.warning("  %s %s: HTTP %s", endpoint, params.get("country"), e.code)
            return None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            delay *= 2
            log.info("  %s: %s — retry in %.0f s (%d/%d)", endpoint, e, delay, attempt + 1, RETRIES)
            time.sleep(delay)
    log.warning("  %s %s: no answer after %d attempts", endpoint, params.get("country"), RETRIES)
    return None


def _hour_mean(payload: dict | None, at: datetime, scale: float = 1.0) -> tuple[dict, int]:
    """Mean of every series over the hour starting at ``at`` (15-min data
    averaged), with the number of intervals found."""
    if not payload or not payload.get("data"):
        return {}, 0
    end = at + timedelta(hours=1)
    rows = [r for r in payload["data"]
            if at <= datetime.fromisoformat(r["timestamp"]).astimezone(timezone.utc) < end]
    sums: dict[str, float] = {}
    counts: dict[str, int] = {}
    for row in rows:
        for key, value in row.get("values", {}).items():
            if isinstance(value, (int, float)):
                sums[key] = sums.get(key, 0.0) + float(value) * scale
                counts[key] = counts.get(key, 0) + 1
    return {k: round(sums[k] / counts[k], 1) for k in sums}, len(rows)


def _installed(payload: dict | None, at: datetime) -> tuple[dict, int | None]:
    """Installed capacity (MW) at the end of the last full year before ``at``
    (the API labels a year by its END state), else the latest year."""
    if not payload or not payload.get("data"):
        return {}, None
    rows = sorted(payload["data"], key=lambda r: r["timestamp"])
    chosen = None
    for row in rows:
        year = int(row["timestamp"][:4])
        if year < at.year and any(isinstance(v, (int, float)) for v in row["values"].values()):
            chosen = row
    chosen = chosen or rows[-1]
    values = {k: round(float(v) * 1000.0, 1) for k, v in chosen["values"].items()
              if isinstance(v, (int, float))}
    return values, int(chosen["timestamp"][:4])


def fetch_country(iso: str, at: datetime) -> dict | None:
    """Load, production, physical flows and installed capacity of one country."""
    code = API_CODE.get(iso, iso.lower())
    if code not in API_COUNTRIES:
        return None
    stamp = at.strftime("%Y-%m-%dT%H:%MZ")
    last = (at + timedelta(minutes=45)).strftime("%Y-%m-%dT%H:%MZ")
    # Industrial self-supply is real production, and the load counts what
    # it feeds: the totals keep a country balanced where they exist.
    basis = "total"
    power, n_power = _hour_mean(_get("total_power", country=code, start=stamp, end=last), at)
    if "load_incl_self_consumption" in power:
        power["load"] = power["load_incl_self_consumption"]
    else:
        basis = "public"
        power, n_power = _hour_mean(_get("public_power", country=code, start=stamp, end=last), at)
    if "load" not in power:
        return None
    flows_gw, _ = _hour_mean(_get("cbpf", country=code, start=stamp, end=last), at)
    installed, year = _installed(_get("installed_power", country=code, time_step="yearly",
                                      installation_decommission="false"), at)
    flows = {}
    for key, gw in flows_gw.items():
        if key != "sum":
            flows[NEIGHBOUR_ISO.get(key, key)] = round(gw * 1000.0, 1)
    production = {k: v for k, v in power.items() if k not in NOT_PRODUCTION}
    return {
        "basis": basis,
        "load": power["load"],
        "production": production,
        "trading": power.get("cross_border_electricity_trading"),
        "flows": flows,
        "installed": installed,
        "installed_year": year,
        "intervals": n_power,
    }


def run(countries: list[str], at: datetime, out: Path, update: bool = False) -> dict:
    record = {
        "schema": SCHEMA,
        "at_utc": at.strftime("%Y-%m-%dT%H:%MZ"),
        "source": SOURCE,
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "countries": {},
        "missing": {},
    }
    if update and out.is_file():
        record = json.loads(out.read_text(encoding="utf-8"))
        if record.get("at_utc") != at.strftime("%Y-%m-%dT%H:%MZ"):
            raise SystemExit(f"{out} holds {record.get('at_utc')}, not {at:%Y-%m-%dT%H:%MZ}")
        for iso in countries:
            record["countries"].pop(iso, None)
            record["missing"].pop(iso, None)
    for iso in countries:
        log.info("%s …", iso)
        data = fetch_country(iso, at)
        if data is None:
            code = API_CODE.get(iso, iso.lower())
            record["missing"][iso] = ("not covered by the API" if code not in API_COUNTRIES
                                      else "no data for this hour")
            log.warning("  %s: %s", iso, record["missing"][iso])
            continue
        record["countries"][iso] = data
        log.info("  load %.0f MW, production %.0f MW", data["load"],
                 sum(v for v in data["production"].values() if v > 0))
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
    parser.add_argument("--update", action="store_true",
                        help="Refetch only these countries into the existing --out file.")
    args = parser.parse_args()
    countries = ([c.strip().upper() for c in args.countries.split(",") if c.strip()]
                 if args.countries else network_countries(args.network))
    run(countries, parse_instant(args.at), args.out, args.update)


if __name__ == "__main__":
    main()
