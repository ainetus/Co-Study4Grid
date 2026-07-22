// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { colors } from '../../styles/tokens';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';

export type ConfirmDialogState = {
  type: 'contingency' | 'loadStudy' | 'applySettings' | 'changeNetwork' | 'clearSuggested';
  pendingBranch?: string;
  pendingNetworkPath?: string;
} | null;

interface ConfirmationDialogProps {
  confirmDialog: ConfirmDialogState;
  onCancel: () => void;
  onConfirm: () => void;
}

const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
  confirmDialog,
  onCancel,
  onConfirm,
}) => {
  // Escape-to-cancel + focus trap/restore (QW20). Called before the early
  // return so the hook order stays stable across open/closed renders.
  const { containerRef, dialogProps } = useModalKeyboard({
    isOpen: !!confirmDialog,
    onClose: onCancel,
  });
  if (!confirmDialog) return null;

  const title =
    confirmDialog.type === 'contingency' ? 'Change Contingency?'
      : confirmDialog.type === 'applySettings' ? 'Apply New Settings?'
        : confirmDialog.type === 'changeNetwork' ? 'Change Network?'
          : confirmDialog.type === 'clearSuggested' ? 'Clear Suggestions?'
            : 'Reload Study?';

  // The `clearSuggested` flow keeps the operator's decisions, so it
  // gets a bespoke body instead of the shared "everything is cleared"
  // copy used by the study-reset confirmations.
  const body =
    confirmDialog.type === 'clearSuggested'
      ? (
        <>
          Recommender suggestions you have <strong>not</strong> starred, rejected, or
          manually added will be removed from the feed. Your starred, rejected, and
          manually-added actions are kept. You can then pick a different model and
          re-run the analysis.
        </>
      )
      : (
        <>
          All previous analysis results, manual simulations, action selections, and diagrams will be cleared.
          {confirmDialog.type === 'contingency'
            ? ' The network state will be preserved.'
            : confirmDialog.type === 'applySettings'
              ? ' The network will be reloaded with the new configuration.'
              : confirmDialog.type === 'changeNetwork'
                ? ' The current study will be reloaded from the new network file.'
                : ' The network will be reloaded from scratch.'}
        </>
      );

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 4000,
      display: 'flex', justifyContent: 'center', alignItems: 'center'
    }}>
      <div
        ref={containerRef}
        {...dialogProps}
        data-testid={`confirm-dialog-${confirmDialog.type}`}
        style={{
          background: colors.surface, padding: '25px', borderRadius: '10px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          maxWidth: '450px', width: '90%', textAlign: 'center'
        }}
      >
        <div style={{ fontSize: '2rem', marginBottom: '12px' }}>&#9888;</div>
        <h3 style={{ margin: '0 0 12px', color: colors.chrome, fontSize: '1.1rem' }}>
          {title}
        </h3>
        <p style={{ margin: '0 0 20px', color: colors.textSecondary, fontSize: '0.9rem', lineHeight: '1.5' }}>
          {body}
        </p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '8px 20px', background: colors.disabled, color: colors.textOnBrand,
              border: 'none', borderRadius: '5px', cursor: 'pointer',
              fontWeight: 'bold', fontSize: '0.85rem'
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '8px 20px', background: colors.warningStrong, color: colors.textOnBrand,
              border: 'none', borderRadius: '5px', cursor: 'pointer',
              fontWeight: 'bold', fontSize: '0.85rem'
            }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmationDialog;
