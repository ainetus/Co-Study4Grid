#!/usr/bin/env python3
# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""Decode the France THT grid networks committed as text.

Each data/rte7000_tht/grids/<gid>/network.xiidm is committed **compressed and
text-encoded** as network.xiidm.gz.b64 (gzip + base64) so it stays small and
pushes through git without Git-LFS (the raw ~8.8 MB XML would otherwise bloat the
repo, and a binary .zip needs LFS whose object endpoint is blocked in some CI
egress policies). This script decodes every .gz.b64 back to network.xiidm.

Run once after checkout / at image build:
    python scripts/game_mode/decode_tht_grids.py
"""
import base64
import gzip
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2] / "data" / "rte7000_tht" / "grids"


def main():
    n = 0
    for enc in sorted(ROOT.glob("*/network.xiidm.gz.b64")):
        out = enc.with_name(enc.name[: -len(".gz.b64")])  # network.xiidm
        out.write_bytes(gzip.decompress(base64.b64decode(enc.read_bytes())))
        n += 1
        print(f"decoded {enc.parent.name}/{out.name}")
    if n == 0:
        print(f"no network.xiidm.gz.b64 under {ROOT}")


if __name__ == "__main__":
    main()
