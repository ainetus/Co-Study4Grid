// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { colors } from '../../styles/tokens';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';

interface ReloadSessionModalProps {
  showReloadModal: boolean;
  setShowReloadModal: (v: boolean) => void;
  outputFolderPath: string;
  sessionListLoading: boolean;
  sessionList: string[];
  sessionRestoring: boolean;
  onRestoreSession: (name: string) => void;
}

const ReloadSessionModal: React.FC<ReloadSessionModalProps> = ({
  showReloadModal,
  setShowReloadModal,
  outputFolderPath,
  sessionListLoading,
  sessionList,
  sessionRestoring,
  onRestoreSession,
}) => {
  // Escape-to-close + focus trap/restore (QW20). Called before the early
  // return so hook order stays stable across open/closed renders.
  const { containerRef, dialogProps } = useModalKeyboard({
    isOpen: showReloadModal,
    onClose: () => setShowReloadModal(false),
  });

  if (!showReloadModal) return null;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 3500,
      display: 'flex', justifyContent: 'center', alignItems: 'center'
    }}>
      <div
        ref={containerRef}
        {...dialogProps}
        style={{
        background: colors.surface, borderRadius: '10px',
        width: '500px', maxWidth: '95vw', maxHeight: '70vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 8px 32px rgba(0,0,0,0.3)', color: colors.textPrimary
      }}>
        <div style={{
          padding: '15px 20px', borderBottom: `1px solid ${colors.borderSubtle}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center'
        }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Reload Session</h3>
          <button
            onClick={() => setShowReloadModal(false)}
            style={{ border: 'none', background: 'none', fontSize: '20px', cursor: 'pointer', color: colors.textTertiary }}
          >
            &times;
          </button>
        </div>

        <div style={{
          padding: '15px 20px', fontSize: '0.8rem',
          color: colors.textTertiary, borderBottom: `1px solid ${colors.borderSubtle}`
        }}>
          From: {outputFolderPath}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px' }}>
          {sessionListLoading ? (
            <div style={{ padding: '30px', textAlign: 'center', color: colors.textTertiary }}>
              Loading sessions...
            </div>
          ) : sessionList.length === 0 ? (
            <div style={{ padding: '30px', textAlign: 'center', color: colors.textTertiary }}>
              No saved sessions found in this folder.
            </div>
          ) : (
            sessionList.map(name => (
              <div
                key={name}
                onClick={() => !sessionRestoring && onRestoreSession(name)}
                style={{
                  padding: '10px 12px', margin: '4px 0',
                  border: `1px solid ${colors.borderSubtle}`, borderRadius: '6px',
                  cursor: sessionRestoring ? 'not-allowed' : 'pointer',
                  fontSize: '0.85rem', fontFamily: 'monospace',
                  transition: 'background 0.15s',
                  opacity: sessionRestoring ? 0.5 : 1,
                }}
                onMouseOver={e => { if (!sessionRestoring) (e.currentTarget as HTMLElement).style.background = colors.brandSoft; }}
                onMouseOut={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                {name}
              </div>
            ))
          )}
        </div>

        <div style={{ padding: '12px 20px', borderTop: `1px solid ${colors.borderSubtle}`, display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={() => setShowReloadModal(false)}
            style={{
              padding: '8px 20px', background: colors.disabled, color: colors.textOnBrand,
              border: 'none', borderRadius: '5px', cursor: 'pointer',
              fontWeight: 'bold', fontSize: '0.85rem'
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default ReloadSessionModal;
