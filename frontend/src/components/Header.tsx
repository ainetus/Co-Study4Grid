// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import type { AnalysisResult } from '../types';
import { colors, radius, space } from '../styles/tokens';
import NoticesPanel, { type Notice } from './NoticesPanel';
import { useTheme } from '../hooks/useTheme';

type SettingsTab = 'paths' | 'recommender' | 'configurations';

interface HeaderProps {
  networkPath: string;
  setNetworkPath: (path: string) => void;
  /**
   * Called when the user "commits" a network path change — either by
   * blurring the path input after editing it, or by selecting a new
   * file via the picker. Goes through App's confirmation pipeline so
   * the user is warned before the currently-loaded study is dropped.
   */
  onCommitNetworkPath: (path: string) => void;
  configLoading: boolean;
  result: AnalysisResult | null;
  /** Currently APPLIED contingency (list of element IDs). */
  selectedContingency: string[];
  sessionRestoring: boolean;
  onPickSettingsPath: (type: 'file' | 'dir', setter: (val: string) => void) => void;
  onLoadStudy: () => void;
  onSaveResults: () => void;
  onOpenReloadModal: () => void;
  onOpenSettings: (tab: SettingsTab) => void;
  /** Background notices — surfaced as a NoticesPanel pill tucked
   *  directly under the app title. Self-hides when the list is empty. */
  notices?: Notice[];
}

const Header: React.FC<HeaderProps> = ({
  networkPath,
  setNetworkPath,
  onCommitNetworkPath,
  configLoading,
  result,
  selectedContingency,
  sessionRestoring,
  onPickSettingsPath,
  onLoadStudy,
  onSaveResults,
  onOpenReloadModal,
  onOpenSettings,
  notices,
}) => {
  const saveDisabled = !result && selectedContingency.length === 0;
  const { theme, toggleTheme } = useTheme();

  return (
    <header style={{
      background: colors.chrome, color: colors.textOnBrand, padding: `${space[2]} ${space[5]}`,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      gap: space[4], flexWrap: 'wrap'
    }}>
      <h2 style={{ margin: 0, fontSize: '1.1rem', whiteSpace: 'nowrap' }}>⚡ Co-Study4Grid</h2>

      <div style={{ flex: '1 1 200px', display: 'flex', flexDirection: 'column', gap: space.half }}>
        {/* Label and the Notices pill share one row — the pill is
            pushed to the right, just above the file-opener button,
            so the label line isn't a wasted standalone row. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[2] }}>
          <label style={{ fontSize: '0.7rem', opacity: 0.8, whiteSpace: 'nowrap' }}>Network Path</label>
          {notices && <NoticesPanel notices={notices} />}
        </div>
        <div style={{ display: 'flex', gap: space[1] }}>
          <input
            data-testid="header-network-path-input"
            type="text"
            value={networkPath}
            onChange={e => setNetworkPath(e.target.value)}
            // Run the confirmation pipeline once the user finishes
            // editing so that switching networks while a study is
            // already loaded prompts before silently dropping the
            // in-flight work.
            onBlur={e => onCommitNetworkPath(e.target.value)}
            placeholder="load your grid xiidm file path"
            style={{
              flex: 1, minWidth: 0, padding: `5px ${space[2]}`,
              border: '1px solid rgba(255,255,255,0.3)', borderRadius: radius.sm,
              background: 'rgba(255,255,255,0.1)', color: colors.textOnBrand, fontSize: '0.8rem'
            }}
          />
          <button
            // The picker also routes through onCommitNetworkPath: the
            // user just chose a new file — that's an intentional commit
            // and must trigger the confirmation dialog if it would
            // overwrite an active study.
            onClick={() => onPickSettingsPath('file', onCommitNetworkPath)}
            style={{
              padding: `${space[1]} ${space[2]}`, background: 'rgba(255,255,255,0.15)',
              border: '1px solid rgba(255,255,255,0.25)', borderRadius: radius.sm,
              color: colors.textOnBrand, cursor: 'pointer', fontSize: '0.8rem'
            }}
          >
            📄
          </button>
        </div>
      </div>

      <button
        onClick={onLoadStudy}
        disabled={configLoading}
        style={{
          padding: `${space[2]} 14px`,
          background: configLoading ? colors.disabled : colors.brand,
          color: colors.textOnBrand, border: 'none', borderRadius: radius.sm,
          cursor: configLoading ? 'not-allowed' : 'pointer',
          fontWeight: 'bold', fontSize: '0.8rem', whiteSpace: 'nowrap'
        }}
      >
        {configLoading ? '⏳ Loading...' : '🔄 Load Study'}
      </button>

      <button
        onClick={onSaveResults}
        disabled={saveDisabled}
        style={{
          padding: `${space[2]} 14px`,
          background: saveDisabled ? colors.disabled : colors.accent,
          color: colors.textOnBrand, border: 'none', borderRadius: radius.sm,
          cursor: saveDisabled ? 'not-allowed' : 'pointer',
          fontWeight: 'bold', fontSize: '0.8rem', whiteSpace: 'nowrap'
        }}
        title="Save session results to JSON"
      >
        💾 Save Results
      </button>

      <button
        onClick={onOpenReloadModal}
        disabled={sessionRestoring}
        style={{
          padding: `${space[2]} 14px`,
          background: sessionRestoring ? colors.disabled : colors.brandStrong,
          color: colors.textOnBrand, border: 'none', borderRadius: radius.sm,
          cursor: sessionRestoring ? 'not-allowed' : 'pointer',
          fontWeight: 'bold', fontSize: '0.8rem', whiteSpace: 'nowrap'
        }}
        title="Reload a previously saved session"
      >
        {sessionRestoring ? 'Restoring...' : 'Reload Session'}
      </button>

      <button
        data-testid="header-theme-toggle"
        onClick={toggleTheme}
        style={{
          background: colors.chromeSoft, display: 'flex', alignItems: 'center',
          justifyContent: 'center', padding: `${space[2]} ${space[2]}`, fontSize: '1rem',
          color: colors.textOnBrand, border: 'none', borderRadius: radius.sm,
          cursor: 'pointer', fontWeight: 'bold', minWidth: '34px'
        }}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>

      <button
        onClick={() => onOpenSettings('paths')}
        style={{
          background: colors.chromeSoft, display: 'flex', alignItems: 'center',
          justifyContent: 'center', padding: `${space[2]} ${space[2]}`, fontSize: '1rem',
          color: colors.textOnBrand, border: 'none', borderRadius: radius.sm,
          cursor: 'pointer', fontWeight: 'bold'
        }}
        title="Settings"
      >
        &#9881;
      </button>
    </header>
  );
};

export default Header;
