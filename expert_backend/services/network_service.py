# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import pypowsybl.network as pn
import os

class NetworkService:
    def __init__(self):
        self.network = None

    def load_network(self, network_path: str):
        if not os.path.exists(network_path):
            raise FileNotFoundError(f"Network file/directory not found: {network_path}")
        
        # Determine if it's a file or directory and load accordingly
        # Assuming bare_env is a directory of xiidm files or a single xiidm file
        # pypowsybl can load from file. 
        # If it's a directory, we might need to pick the xiidm file inside.
        if os.path.isdir(network_path):
            files = [f for f in os.listdir(network_path) if f.endswith('.xiidm') or f.endswith('.xml')]
            if not files:
                 raise FileNotFoundError(f"No .xiidm or .xml file found in {network_path}")
            file_path = os.path.join(network_path, files[0])
        else:
            file_path = network_path

        # NOTE: pypowsybl exposes `allow_variant_multi_thread_access=True`
        # on `pn.load()` which looks like a silver bullet for the
        # `/api/config` contention between the NAD prefetch worker and
        # grid2op env setup. It is NOT safe to enable here, see
        # docs/performance/history/concurrent-variants.md: when ON, every thread that
        # touches the Network must FIRST call `n.set_working_variant(...)`,
        # otherwise pypowsybl raises "Variant index not set for current
        # thread". FastAPI serves each request on a thread-pool worker
        # whose identity is unstable — the read-only endpoints
        # (`/api/branches`, `/api/voltage-levels`, `/api/nominal-voltages`)
        # would need a per-endpoint variant-set guard, which we currently
        # do NOT have. Keeping the default (False) preserves correctness;
        # the contention (~2-3 s) is an accepted residual cost.
        self.network = pn.load(file_path)
        return {"message": "Network loaded successfully", "id": self.network.id}

    def get_disconnectable_elements(self):
        if not self.network:
            raise ValueError("Network not loaded")

        # get lines and two winding transformers
        lines = self.network.get_lines()
        transformers = self.network.get_2_windings_transformers()

        elements = []
        if lines is not None and not lines.empty:
            elements.extend(lines.index.tolist())
        if transformers is not None and not transformers.empty:
            elements.extend(transformers.index.tolist())

        return sorted(elements)

    def get_element_names(self):
        """Return {element_id: display_name} for all lines and transformers.

        The display name is the pypowsybl ``name`` field when it is set and
        differs from the element ID; otherwise the ID itself.

        For lines/transformers whose name is still a raw OSM identifier
        (e.g. ``way/426020732-400``), a composite name is built from the
        voltage-level names at each endpoint (e.g. ``CHARPENAY — ST-VULBAS-EST``).
        """
        if not self.network:
            raise ValueError("Network not loaded")

        import re
        _RAW_OSM_RE = re.compile(r'^(way|relation)[/_]')

        # Pre-load VL display names for fallback construction
        vl_names: dict[str, str] = {}
        voltage_levels = self.network.get_voltage_levels()
        if voltage_levels is not None and not voltage_levels.empty and 'name' in voltage_levels.columns:
            for vl_id, row in voltage_levels.iterrows():
                n = row.get('name')
                if n and str(n) != 'nan':
                    # Strip trailing " 400kV" etc. for a cleaner composite name
                    clean = re.sub(r'\s+\d+\s*kV$', '', str(n))
                    vl_names[vl_id] = clean

        def _display_name(eid: str, row, name_col_exists: bool, vl1_col: str, vl2_col: str) -> str | None:
            """Return a human-readable name, or None to skip."""
            n = row.get('name') if name_col_exists else None
            if n and str(n) != str(eid) and str(n) != 'nan' and not _RAW_OSM_RE.match(str(n)):
                return str(n)
            # Name is missing or is a raw OSM ID → build from VL endpoint names
            vl1 = row.get(vl1_col) if vl1_col in row.index else None
            vl2 = row.get(vl2_col) if vl2_col in row.index else None
            name1 = vl_names.get(str(vl1), '') if vl1 else ''
            name2 = vl_names.get(str(vl2), '') if vl2 else ''
            if name1 and name2 and name1 != name2:
                return f"{name1} \u2014 {name2}"
            if name1:
                return name1
            if name2:
                return name2
            # Fallback: use the raw name if it exists and differs from ID
            if n and str(n) != str(eid) and str(n) != 'nan':
                return str(n)
            return None

        name_map: dict[str, str] = {}

        lines = self.network.get_lines()
        if lines is not None and not lines.empty:
            has_name = 'name' in lines.columns
            for eid, row in lines.iterrows():
                display = _display_name(eid, row, has_name, 'voltage_level1_id', 'voltage_level2_id')
                if display:
                    name_map[eid] = display

        transformers = self.network.get_2_windings_transformers()
        if transformers is not None and not transformers.empty:
            has_name = 'name' in transformers.columns
            for eid, row in transformers.iterrows():
                display = _display_name(eid, row, has_name, 'voltage_level1_id', 'voltage_level2_id')
                if display:
                    name_map[eid] = display

        return name_map

    def get_monitored_elements(self):
        """Return the list of element IDs that have at least one permanent operational limit."""
        if not self.network:
            raise ValueError("Network not loaded")

        # Narrow query — only (element_id, type, acceptable_duration) are
        # consumed below, and all three live in the pypowsybl MultiIndex.
        # `value`, `element_type`, `name`, `group_name` are fetched by the
        # default call but unused here. `attributes=[]` drops those
        # columns and saves ~90 ms on the 55 k-row limit table of the
        # PyPSA-EUR France grid (265 ms → 175 ms). A `6835 × 0`
        # DataFrame is reported as `.empty` by pandas, so we check
        # `len(index)` instead.
        limits = self.network.get_operational_limits(attributes=[])
        if limits is None or len(limits.index) == 0:
            return []

        limits = limits.reset_index()
        # Filter for limits of type 'CURRENT' with acceptable_duration == -1 (permanent)
        # Note: some networks might use 'THERMAL' or other types, but 'CURRENT' is standard for ampere limits.
        # Expert Assist uses 'CURRENT' (see recommender_service.py:601)
        permanent_limits = limits[(limits['type'] == 'CURRENT') & (limits['acceptable_duration'] == -1)]
        if permanent_limits.empty:
            return []

        ids = sorted(permanent_limits['element_id'].unique().tolist())
        return ids

    def get_voltage_levels(self):
        if not self.network:
            raise ValueError("Network not loaded")

        # Narrow query — only the index is consumed downstream. Requesting
        # `attributes=[]` skips pypowsybl's Java→Python serialisation of
        # `nominal_v`, `name`, `topology_kind`, etc. (~3-4 ms saved on the
        # 6 835-VL PyPSA-EUR France grid). We check `len(index)` rather
        # than `.empty`, because a DataFrame with rows but 0 columns is
        # still reported as empty by pandas.
        voltage_levels = self.network.get_voltage_levels(attributes=[])
        if voltage_levels is not None and len(voltage_levels.index) > 0:
            return sorted(voltage_levels.index.tolist())
        return []

    def get_voltage_level_substations(self):
        """Return ``{vl_id: substation_id}`` for every voltage level.

        Used by the frontend to anchor action-overview pins on the
        overflow graph: the overflow graph nodes are pypowsybl
        substation IDs, while action data references voltage-level IDs
        — this map closes that gap. Returns an empty dict if the
        ``substation_id`` column is missing (pure-VL networks without
        substations).
        """
        if not self.network:
            raise ValueError("Network not loaded")

        # `substation_id` ships in the default attribute set so a narrow
        # query is enough; we don't pull `name` / `nominal_v` here.
        voltage_levels = self.network.get_voltage_levels(attributes=['substation_id'])
        if voltage_levels is None or voltage_levels.empty:
            return {}
        if 'substation_id' not in voltage_levels.columns:
            return {}
        sub_ids = voltage_levels['substation_id'].tolist()
        idx = voltage_levels.index.tolist()
        return {
            vl_id: str(sub_id)
            for vl_id, sub_id in zip(idx, sub_ids)
            if sub_id is not None and str(sub_id) != 'nan'
        }

    def get_voltage_level_names(self):
        """Return {vl_id: display_name} for all voltage levels."""
        if not self.network:
            raise ValueError("Network not loaded")

        name_map: dict[str, str] = {}
        voltage_levels = self.network.get_voltage_levels()
        if voltage_levels is not None and not voltage_levels.empty and 'name' in voltage_levels.columns:
            for vl_id, row in voltage_levels.iterrows():
                n = row.get('name')
                if n and str(n) != str(vl_id) and str(n) != 'nan':
                    name_map[vl_id] = str(n)

        return name_map

    def get_nominal_voltages(self):
        """Return {vl_id: nominal_v_kv} mapping for all voltage levels, snapped to detected grid values.

        Optimised path — narrow pypowsybl query + vectorised final dict
        build (no pandas `iterrows`). Measured on the 6 835-VL PyPSA-EUR
        France grid: 144 ms → 6.6 ms (~22× speedup). Output strictly
        identical.
        """
        if not self.network:
            raise ValueError("Network not loaded")

        # Narrow query — only `nominal_v` is needed. `get_voltage_levels()`
        # with `all_attributes=True` materialises `name`, `topology_kind`,
        # `substation_id`, ... adding ~4 ms of Java→Python serialisation.
        voltage_levels = self.network.get_voltage_levels(attributes=['nominal_v'])
        if voltage_levels is None or voltage_levels.empty:
            return {}

        # Pull the column as a plain numpy array once — avoids repeated
        # pandas column access in the final dict comprehension.
        nom_v_arr = voltage_levels['nominal_v'].values
        idx_list = voltage_levels.index.tolist()

        # 1. Collect all unique nominal voltages
        import numpy as np
        raw_voltages = sorted(np.unique(nom_v_arr).tolist())
        if not raw_voltages:
            return {}

        # 2. Cluster voltages within 2% of each other
        clusters = []
        current_cluster = [raw_voltages[0]]
        for v in raw_voltages[1:]:
            # If v is within 2% of the cluster average, add it
            avg = sum(current_cluster) / len(current_cluster)
            if abs(v - avg) / avg < 0.02:
                current_cluster.append(v)
            else:
                clusters.append(current_cluster)
                current_cluster = [v]
        clusters.append(current_cluster)

        # 3. Create representative cleaned values for each cluster
        # Map each raw voltage to its clean representative
        raw_to_clean = {}
        for cluster in clusters:
            avg = sum(cluster) / len(cluster)
            # Bucketing: anything < 25kV goes into the 25kV bucket
            if avg < 25:
                clean_v = 25.0
            else:
                # Clean representative: round to int
                clean_v = round(avg, 0)

            for v in cluster:
                raw_to_clean[v] = clean_v

        # 4. Map each voltage level to its clean representative.
        # Vectorised over the numpy array (avoids iterrows which was the
        # dominant cost — ~130 ms for 6 835 rows).
        nom_v_list = nom_v_arr.tolist()
        return {
            idx_list[i]: raw_to_clean[float(nom_v_list[i])]
            for i in range(len(idx_list))
        }

    def get_element_voltage_levels(self, element_id: str):
        """Resolve an equipment ID (line, transformer, or VL) to its voltage level IDs."""
        if not self.network:
            raise ValueError("Network not loaded")

        # Check if it's already a voltage level
        voltage_levels = self.network.get_voltage_levels()
        if voltage_levels is not None and element_id in voltage_levels.index:
            return [element_id]

        # Check lines (have voltage_level1_id and voltage_level2_id columns)
        lines = self.network.get_lines()
        if lines is not None and element_id in lines.index:
            row = lines.loc[element_id]
            vls = set()
            if 'voltage_level1_id' in row.index:
                vls.add(row['voltage_level1_id'])
            if 'voltage_level2_id' in row.index:
                vls.add(row['voltage_level2_id'])
            return sorted(vls)

        # Check 2-winding transformers
        transformers = self.network.get_2_windings_transformers()
        if transformers is not None and element_id in transformers.index:
            row = transformers.loc[element_id]
            vls = set()
            if 'voltage_level1_id' in row.index:
                vls.add(row['voltage_level1_id'])
            if 'voltage_level2_id' in row.index:
                vls.add(row['voltage_level2_id'])
            return sorted(vls)

        return []

    def get_load_voltage_level(self, load_id: str) -> str | None:
        """Return the voltage level ID that a given load belongs to."""
        if not self.network:
            raise ValueError("Network not loaded")

        loads = self.network.get_loads()
        if loads is not None and load_id in loads.index:
            row = loads.loc[load_id]
            if 'voltage_level_id' in row.index:
                return row['voltage_level_id']
        return None

    def get_load_voltage_levels_bulk(self, load_ids: list[str]) -> dict[str, str]:
        """Return {load_id: voltage_level_id} for a list of loads."""
        if not self.network:
            raise ValueError("Network not loaded")

        loads = self.network.get_loads()
        if loads is None or loads.empty:
            return {}

        result: dict[str, str] = {}
        for lid in load_ids:
            if lid in loads.index:
                row = loads.loc[lid]
                if 'voltage_level_id' in row.index:
                    result[lid] = row['voltage_level_id']
        return result

    def get_generator_voltage_level(self, gen_id: str) -> str | None:
        """Return the voltage level ID that a given generator belongs to."""
        if not self.network:
            raise ValueError("Network not loaded")

        generators = self.network.get_generators()
        if generators is not None and gen_id in generators.index:
            row = generators.loc[gen_id]
            if 'voltage_level_id' in row.index:
                return row['voltage_level_id']
        return None

    def get_generator_active_power_limits(self, gen_id: str) -> tuple[float, float] | None:
        """Return ``(min_p, max_p)`` active-power limits (MW) of a generator.

        Used to expose the maximum redispatch headroom on a remedial action
        card (raise: ``max_p - current``; lower: ``current - min_p``)."""
        if not self.network:
            raise ValueError("Network not loaded")

        generators = self.network.get_generators(attributes=['min_p', 'max_p'])
        if generators is not None and gen_id in generators.index:
            row = generators.loc[gen_id]
            if 'min_p' in row.index and 'max_p' in row.index:
                try:
                    return float(row['min_p']), float(row['max_p'])
                except (TypeError, ValueError):
                    return None
        return None

    def get_generator_type(self, gen_id: str) -> str | None:
        """Return the energy source type of a given generator."""
        if not self.network:
            raise ValueError("Network not loaded")

        generators = self.network.get_generators()
        if generators is not None and gen_id in generators.index:
            row = generators.loc[gen_id]
            if 'energy_source' in row.index:
                return row['energy_source']
        return None

    def get_generator_types_bulk(self, gen_ids: list[str]) -> dict[str, str]:
        """Return {gen_id: energy_source} for a list of generators."""
        if not self.network:
            raise ValueError("Network not loaded")

        generators = self.network.get_generators()
        if generators is None or generators.empty:
            return {}

        result = {}
        for gid in gen_ids:
            if gid in generators.index:
                row = generators.loc[gid]
                if 'energy_source' in row.index:
                    result[gid] = row['energy_source']
        return result

network_service = NetworkService()
