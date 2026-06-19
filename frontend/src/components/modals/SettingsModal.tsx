// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { interactionLogger } from '../../utils/interactionLogger';
import type { SettingsState } from '../../hooks/useSettings';
import { useSmoothPanZoom } from '../../utils/smoothPanZoom';
import { colors } from '../../styles/tokens';
import { ACTION_TYPE_FILTER_TOKENS, ACTION_TYPE_LABELS } from '../../utils/actionTypes';
import type { ActionTypeKind } from '../../utils/actionTypes';

interface SettingsModalProps {
  settings: SettingsState;
  onApply: () => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ settings, onApply }) => {
  // Pure client rendering preference (localStorage, not backend config) —
  // read from its own singleton rather than SettingsState.
  const { enabled: smoothPanZoom, setEnabled: setSmoothPanZoom } = useSmoothPanZoom();
  const {
    isSettingsOpen,
    settingsTab, setSettingsTab,
    networkPath, setNetworkPath,
    actionPath, setActionPath,
    layoutPath, setLayoutPath,
    outputFolderPath, setOutputFolderPath,
    configFilePath, setConfigFilePath, changeConfigFilePath,
    minLineReconnections, setMinLineReconnections,
    minCloseCoupling, setMinCloseCoupling,
    minOpenCoupling, setMinOpenCoupling,
    minLineDisconnections, setMinLineDisconnections,
    nPrioritizedActions, setNPrioritizedActions,
    minPst, setMinPst,
    minLoadShedding, setMinLoadShedding,
    minRenewableCurtailmentActions, setMinRenewableCurtailmentActions,
    minRedispatch, setMinRedispatch,
    allowedActionTypes, setAllowedActionTypes,
    ignoreReconnections, setIgnoreReconnections,
    recommenderModel, setRecommenderModel,
    computeOverflowGraph, setComputeOverflowGraph,
    availableModels,
    monitoringFactor, setMonitoringFactor,
    linesMonitoringPath, setLinesMonitoringPath,
    preExistingOverloadThreshold, setPreExistingOverloadThreshold,
    pypowsyblFastMode, setPypowsyblFastMode,
    pickSettingsPath,
    handleCloseSettings,
  } = settings;

  if (!isSettingsOpen) return null;

  // Resolve the active model descriptor (or null when the registry is
  // still loading). The set of parameter names it declares drives which
  // recommender inputs are visible.
  //
  // ``availableModels`` may be ``undefined`` when the parent test
  // suite hand-builds a partial ``SettingsState`` mock that pre-dates
  // the pluggable recommender feature — fall back to an empty list so
  // those tests don't crash on a ``find`` lookup of ``undefined``.
  const models = availableModels ?? [];
  const activeModel = models.find(m => m.name === recommenderModel) ?? null;
  const declaredParamNames = new Set((activeModel?.params ?? []).map(p => p.name));
  // When `availableModels` is empty (initial load), the active model is
  // unknown, OR the active model declares NO params (the degraded
  // fallback served when `/api/models` errored, or a params_spec failure),
  // fall back to showing every input — same behaviour as before the
  // pluggable model selector existed. Without the empty-params guard a
  // single backend params_spec() exception would blank out every
  // parameter in this tab (regression).
  const showAll = models.length === 0 || activeModel === null || declaredParamNames.size === 0;
  const showField = (name: string): boolean => showAll || declaredParamNames.has(name);

  // When the active model declares `requires_overflow_graph`, the step
  // is not optional: the checkbox is forced ON + disabled so the
  // operator can see WHY it's locked rather than wondering where the
  // toggle went. The backend mirrors this guarantee
  // (`needs_graph = requires_overflow_graph OR compute_overflow_graph`)
  // so a direct API call can't bypass it either.
  const graphRequired = !!activeModel?.requires_overflow_graph;

  const tabButton = (id: 'paths' | 'recommender' | 'configurations', label: string) => (
    <button
      onClick={() => {
        if (id !== settingsTab) {
          interactionLogger.record('settings_tab_changed', { from_tab: settingsTab, to_tab: id });
        }
        setSettingsTab(id);
      }}
      style={{
        flex: 1, padding: '10px', cursor: 'pointer', background: 'none',
        border: 'none', borderBottom: settingsTab === id ? `2px solid ${colors.brand}` : 'none',
        fontWeight: settingsTab === id ? 'bold' : 'normal',
        color: settingsTab === id ? colors.brand : colors.textSecondary
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 3000,
      display: 'flex', justifyContent: 'center', alignItems: 'center'
    }}>
      <div
        role="dialog"
        style={{
          background: colors.surface, padding: '25px', borderRadius: '8px',
          width: '450px', boxShadow: '0 4px 15px rgba(0,0,0,0.2)',
          display: 'flex', flexDirection: 'column', gap: '15px', color: colors.textPrimary
        }}
      >
        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: `1px solid ${colors.borderSubtle}`, marginBottom: '15px' }}>
          {tabButton('paths', 'Paths')}
          {tabButton('recommender', 'Recommender')}
          {tabButton('configurations', 'Configurations')}
        </div>

        {/* Paths Tab */}
        {settingsTab === 'paths' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label htmlFor="networkPathInput" style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>Network File Path (.xiidm)</label>
              <div style={{ fontSize: '0.75rem', color: colors.textTertiary, marginTop: '-3px' }}>Synchronized with the banner field</div>
              <div style={{ display: 'flex', gap: '5px' }}>
                <input id="networkPathInput" type="text" value={networkPath} onChange={e => setNetworkPath(e.target.value)} placeholder="load your grid xiidm file path" style={{ flex: 1, padding: '8px', border: `1px solid ${colors.border}`, borderRadius: '4px' }} />
                <button onClick={() => pickSettingsPath('file', setNetworkPath)} style={{ padding: '8px', background: colors.chromeSoft, color: colors.textOnBrand, border: 'none', borderRadius: '4px', cursor: 'pointer', flexShrink: 0 }}>📄</button>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label htmlFor="actionPathInput" style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>Action Dictionary File Path</label>
              <div style={{ display: 'flex', gap: '5px' }}>
                <input id="actionPathInput" type="text" value={actionPath} onChange={e => setActionPath(e.target.value)} style={{ flex: 1, padding: '8px', border: `1px solid ${colors.border}`, borderRadius: '4px' }} />
                <button onClick={() => pickSettingsPath('file', setActionPath)} style={{ padding: '8px', background: colors.chromeSoft, color: colors.textOnBrand, border: 'none', borderRadius: '4px', cursor: 'pointer', flexShrink: 0 }}>📄</button>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label htmlFor="layoutPathInput" style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>Layout File Path (.json)</label>
              <div style={{ display: 'flex', gap: '5px' }}>
                <input id="layoutPathInput" type="text" value={layoutPath} onChange={e => setLayoutPath(e.target.value)} style={{ flex: 1, padding: '8px', border: `1px solid ${colors.border}`, borderRadius: '4px' }} />
                <button onClick={() => pickSettingsPath('file', setLayoutPath)} style={{ padding: '8px', background: colors.chromeSoft, color: colors.textOnBrand, border: 'none', borderRadius: '4px', cursor: 'pointer', flexShrink: 0 }}>📄</button>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>Output Folder Path</label>
              <div style={{ fontSize: '0.75rem', color: colors.textTertiary, marginTop: '-3px' }}>Session folders (JSON + PDF) are saved here. Leave empty to download JSON to browser.</div>
              <div style={{ display: 'flex', gap: '5px' }}>
                <input type="text" value={outputFolderPath} onChange={e => setOutputFolderPath(e.target.value)} placeholder="e.g. /home/user/sessions" style={{ flex: 1, padding: '8px', border: `1px solid ${colors.border}`, borderRadius: '4px' }} />
                <button onClick={() => pickSettingsPath('dir', setOutputFolderPath)} style={{ padding: '8px', background: colors.chromeSoft, color: colors.textOnBrand, border: 'none', borderRadius: '4px', cursor: 'pointer', flexShrink: 0 }}>📂</button>
              </div>
            </div>
            <hr style={{ border: 'none', borderTop: `1px solid ${colors.borderSubtle}`, margin: '5px 0' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label htmlFor="configFilePathInput" style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>Config File Path</label>
              <div style={{ fontSize: '0.75rem', color: colors.textTertiary, marginTop: '-3px' }}>
                Path to the <code>config.json</code> settings file. Change this to use a config stored outside the repository.
                The file will be created from defaults if it does not exist.
              </div>
              <div style={{ display: 'flex', gap: '5px' }}>
                <input
                  id="configFilePathInput"
                  type="text"
                  value={configFilePath}
                  onChange={e => setConfigFilePath(e.target.value)}
                  onBlur={e => changeConfigFilePath(e.target.value).catch(err => console.error('Failed to change config file path', err))}
                  placeholder="e.g. /home/user/my_costudy4grid_config.json"
                  style={{ flex: 1, padding: '8px', border: `1px solid ${colors.border}`, borderRadius: '4px' }}
                />
                <button
                  onClick={() => pickSettingsPath('file', (p) => changeConfigFilePath(p).catch(err => console.error('Failed to change config file path', err)))}
                  style={{ padding: '8px', background: colors.chromeSoft, color: colors.textOnBrand, border: 'none', borderRadius: '4px', cursor: 'pointer', flexShrink: 0 }}
                >📄</button>
              </div>
            </div>
          </div>
        )}

        {/* Recommender Tab */}
        {settingsTab === 'recommender' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            {/* Model selector */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px',
                          padding: '10px', background: colors.surfaceMuted,
                          border: `1px solid ${colors.borderSubtle}`, borderRadius: '4px' }}>
              <label htmlFor="recommenderModelSelect" style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>Recommendation Model</label>
              <select
                id="recommenderModelSelect"
                value={recommenderModel}
                onChange={e => setRecommenderModel(e.target.value)}
                style={{ padding: '6px', border: `1px solid ${colors.border}`, borderRadius: '4px', background: colors.surface, color: colors.textPrimary }}
              >
                {models.length === 0 && (
                  <option value="expert">Expert system</option>
                )}
                {models.map(m => (
                  <option key={m.name} value={m.name}>{m.label}</option>
                ))}
              </select>

              {/* Compute Overflow Graph toggle:
                  - models that REQUIRE the graph → forced checked + disabled,
                    label suffixed with "required by this model" so the
                    operator understands why the choice is locked;
                  - models that don't require it → toggle hidden entirely
                    (no choice to make, computing it would be wasted work). */}
              {activeModel && graphRequired && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '5px' }}>
                  <input
                    type="checkbox" id="computeOverflowGraph"
                    checked={true}
                    disabled={true}
                    readOnly
                    style={{
                      width: '16px', height: '16px',
                      cursor: 'not-allowed', opacity: 0.7,
                    }}
                  />
                  <label
                    htmlFor="computeOverflowGraph"
                    style={{
                      fontSize: '0.85rem',
                      cursor: 'not-allowed', opacity: 0.7,
                    }}
                  >
                    Compute Overflow Graph (step 1)
                    <span style={{ marginLeft: '6px', fontStyle: 'italic', fontSize: '0.75rem', color: colors.textTertiary }}>
                      required by this model
                    </span>
                  </label>
                </div>
              )}
              {activeModel && !graphRequired && (
                // Models that don't consume the graph: expose the toggle
                // as an opt-in (default off). Useful only for ops who
                // want to inspect the overflow analysis alongside a
                // graph-agnostic recommender.
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '5px' }}>
                  <input
                    type="checkbox" id="computeOverflowGraph"
                    checked={computeOverflowGraph}
                    onChange={e => setComputeOverflowGraph(e.target.checked)}
                    style={{ width: '16px', height: '16px' }}
                  />
                  <label
                    htmlFor="computeOverflowGraph"
                    style={{ fontSize: '0.85rem', cursor: 'pointer' }}
                  >
                    Compute Overflow Graph (step 1)
                    <span style={{ marginLeft: '6px', fontStyle: 'italic', fontSize: '0.75rem', color: colors.textTertiary }}>
                      optional for this model
                    </span>
                  </label>
                </div>
              )}
            </div>

            {/* Parameter inputs — each one is rendered only when the
                active model declares it in params_spec. */}
            {[
              { label: 'Min Line Reconnections', value: minLineReconnections, setter: setMinLineReconnections, id: 'minLineReconnections', name: 'min_line_reconnections' },
              { label: 'Min Close Coupling', value: minCloseCoupling, setter: setMinCloseCoupling, id: 'minCloseCoupling', name: 'min_close_coupling' },
              { label: 'Min Open Coupling', value: minOpenCoupling, setter: setMinOpenCoupling, id: 'minOpenCoupling', name: 'min_open_coupling' },
              { label: 'Min Line Disconnections', value: minLineDisconnections, setter: setMinLineDisconnections, id: 'minLineDisconnections', name: 'min_line_disconnections' },
              { label: 'Min PST Actions', value: minPst, setter: setMinPst, id: 'minPst', name: 'min_pst' },
              { label: 'Min Load Shedding', value: minLoadShedding, setter: setMinLoadShedding, id: 'minLoadShedding', name: 'min_load_shedding' },
              { label: 'Min Renewable Curtailment', value: minRenewableCurtailmentActions, setter: setMinRenewableCurtailmentActions, id: 'minRenewableCurtailment', name: 'min_renewable_curtailment_actions' },
              { label: 'Min Redispatch', value: minRedispatch, setter: setMinRedispatch, id: 'minRedispatch', name: 'min_redispatch' },
            ].filter(({ name }) => showField(name)).map(({ label, value, setter, id }) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label htmlFor={id} style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>{label}</label>
                <input
                  id={id}
                  type="number" step="0.1" value={value}
                  onChange={e => setter(parseFloat(e.target.value))}
                  style={{ width: '80px', padding: '5px', border: `1px solid ${colors.border}`, borderRadius: '4px' }}
                />
              </div>
            ))}
            {showField('n_prioritized_actions') && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label htmlFor="nPrioritizedActions" style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>N Prioritized Actions</label>
                <input
                  id="nPrioritizedActions"
                  type="number" step="1" value={nPrioritizedActions}
                  onChange={e => setNPrioritizedActions(parseInt(e.target.value, 10))}
                  style={{ width: '80px', padding: '5px', border: `1px solid ${colors.border}`, borderRadius: '4px' }}
                />
              </div>
            )}
            {showField('ignore_reconnections') && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', background: colors.surfaceMuted, borderRadius: '4px', border: `1px solid ${colors.borderSubtle}` }}>
                <input
                  type="checkbox" id="ignoreRec" checked={ignoreReconnections}
                  onChange={e => setIgnoreReconnections(e.target.checked)}
                  style={{ width: '16px', height: '16px' }}
                />
                <label htmlFor="ignoreRec" style={{ fontWeight: 'bold', fontSize: '0.9rem', cursor: 'pointer' }}>Ignore Reconnections</label>
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px', background: colors.surfaceMuted, borderRadius: '4px', border: `1px solid ${colors.borderSubtle}` }}>
              <label style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>Restrict to action types</label>
              <span style={{ fontSize: '0.75rem', color: colors.textTertiary }}>
                None selected = all families. Select one or more to make the recommender propose ONLY those.
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
                {ACTION_TYPE_FILTER_TOKENS.filter(t => t !== 'all').map(token => {
                  const active = allowedActionTypes.includes(token);
                  return (
                    <button
                      key={token}
                      type="button"
                      data-testid={`allowed-type-${token}`}
                      aria-pressed={active}
                      onClick={() => setAllowedActionTypes(
                        active
                          ? allowedActionTypes.filter(t => t !== token)
                          : [...allowedActionTypes, token]
                      )}
                      style={{
                        fontSize: '0.75rem', padding: '3px 9px', borderRadius: '12px', cursor: 'pointer',
                        border: `1px solid ${active ? colors.brand : colors.border}`,
                        background: active ? colors.brandSoft : colors.surface,
                        color: active ? colors.brand : colors.textSecondary,
                        fontWeight: active ? 600 : 400,
                      }}
                    >
                      {ACTION_TYPE_LABELS[token as ActionTypeKind]}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Configurations Tab */}
        {settingsTab === 'configurations' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label htmlFor="monitoringFactor" style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>Monitoring Factor Thermal Limits</label>
              <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                <input
                  id="monitoringFactor" type="number" step="0.01" min="0" max="2"
                  value={monitoringFactor} onChange={e => setMonitoringFactor(parseFloat(e.target.value))}
                  style={{ padding: '6px', width: '80px', border: `1px solid ${colors.border}`, borderRadius: '4px' }}
                />
                <span style={{ fontSize: '0.85rem', color: colors.textTertiary }}>Multiplier applied to standard limits (e.g., 0.95)</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label htmlFor="linesMonitoringPathInput" style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>Lines Monitoring File (Optional)</label>
              <div style={{ display: 'flex', gap: '5px' }}>
                <input
                  id="linesMonitoringPathInput"
                  type="text" value={linesMonitoringPath}
                  onChange={e => setLinesMonitoringPath(e.target.value)}
                  placeholder="Leave empty for IGNORE_LINES_MONITORING=True"
                  style={{ flex: 1, padding: '8px', border: `1px solid ${colors.border}`, borderRadius: '4px' }}
                />
                <button onClick={() => pickSettingsPath('file', setLinesMonitoringPath)} style={{ padding: '8px', background: colors.chromeSoft, color: colors.textOnBrand, border: 'none', borderRadius: '4px', cursor: 'pointer', flexShrink: 0 }}>📁</button>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label htmlFor="preExistingOverloadThreshold" style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>Pre-existing Overload Threshold</label>
              <input
                id="preExistingOverloadThreshold"
                type="number" step="0.01" min="0" max="1" value={preExistingOverloadThreshold}
                onChange={e => setPreExistingOverloadThreshold(parseFloat(e.target.value))}
                style={{ width: '80px', padding: '5px', border: `1px solid ${colors.border}`, borderRadius: '4px' }}
              />
            </div>
            <div style={{ fontSize: '0.75rem', color: colors.textTertiary, marginTop: '-10px' }}>
              Pre-existing overloads excluded from N-1 &amp; max loading unless worsened by this fraction (default 2%)
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px', background: colors.surfaceMuted, borderRadius: '4px', border: `1px solid ${colors.borderSubtle}` }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <input
                    type="checkbox" id="fastMode" checked={pypowsyblFastMode}
                    onChange={e => setPypowsyblFastMode(e.target.checked)}
                    style={{ width: '16px', height: '16px' }}
                  />
                  <label htmlFor="fastMode" style={{ fontWeight: 'bold', fontSize: '0.9rem', cursor: 'pointer' }}>Pypowsybl Fast Mode</label>
                </div>
                <div style={{ fontSize: '0.75rem', color: colors.textTertiary, fontStyle: 'italic', marginLeft: '26px' }}>
                  Disable voltage control in pypowsybl for faster simulations (may affect convergence)
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px', background: colors.surfaceMuted, borderRadius: '4px', border: `1px solid ${colors.borderSubtle}` }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <input
                    type="checkbox" id="smoothPanZoom" checked={smoothPanZoom}
                    onChange={e => setSmoothPanZoom(e.target.checked)}
                    style={{ width: '16px', height: '16px' }}
                    data-testid="smooth-pan-zoom-toggle"
                  />
                  <label htmlFor="smoothPanZoom" style={{ fontWeight: 'bold', fontSize: '0.9rem', cursor: 'pointer' }}>Smooth pan/zoom (GPU)</label>
                </div>
                <div style={{ fontSize: '0.75rem', color: colors.textTertiary, fontStyle: 'italic', marginLeft: '26px' }}>
                  Pan/zoom the diagram with a GPU-composited transform instead of repainting it each frame. Much smoother on large grids with a hardware-accelerated browser; leave OFF on software-rendered / remote-desktop / VDI sessions, where it can stutter. Applies on the next gesture.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Footer buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px', gap: '10px' }}>
          <button
            onClick={handleCloseSettings}
            style={{ padding: '8px 20px', background: colors.danger, color: colors.textOnBrand, border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
          >
            Close
          </button>
          <button
            onClick={onApply}
            style={{ padding: '8px 20px', background: colors.brand, color: colors.textOnBrand, border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
