// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { colors, radius, space, text } from '../styles/tokens';

export interface Notice {
  /** Stable id used as React key and for dismiss tracking. */
  id: string;
  /** One-line title shown bold on the notice card. */
  title: string;
  /**
   * Body content. ReactNode so callers can compose icons / inline buttons /
   * styled fragments. Rendered with the warning-text color on a soft yellow
   * background for visual continuity with the previous inline banners.
   */
  body: React.ReactNode;
  /**
   * Visual severity. `info` renders blue, `warning` renders yellow.
   * Both share the same panel layout so the operator can scan all
   * active notices at once.
   */
  severity?: 'info' | 'warning';
  /** Optional dismiss handler — when set, a × appears on the card. */
  onDismiss?: () => void;
  /** Optional in-card action button (e.g. "Open settings"). */
  action?: { label: string; onClick: () => void };
}

interface NoticesPanelProps {
  notices: Notice[];
}

/**
 * Sidebar-header pill that opens an inline panel listing every active
 * background notice (action-dict info, recommender thresholds,
 * monitoring coverage). Replaces the five concurrent yellow banners
 * called out in `docs/proposals/ui-design-critique.md` recommendation
 * #4 — one entry point, one place to dismiss, no warning-fatigue
 * stack.
 *
 * The pill self-hides when there are zero active notices so the
 * sidebar header stays clean once the operator has dismissed
 * everything they wanted to dismiss.
 */
const PANEL_WIDTH = 320;
const PANEL_GAP = 4;
const VIEWPORT_MARGIN = 8;

export default function NoticesPanel({ notices }: NoticesPanelProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null);

  // Anchor the floating panel to the pill button using viewport
  // coordinates. We render it in a portal so it escapes the sidebar's
  // `overflow: hidden` clip and any ancestor stacking contexts that
  // would otherwise let the visualization panel paint over it.
  const recomputePosition = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const top = rect.bottom + PANEL_GAP;
    // Right-align the panel with the pill so it grows leftward into
    // the sidebar instead of bleeding into the visualization area.
    let left = rect.right - PANEL_WIDTH;
    if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;
    if (left + PANEL_WIDTH > viewportW - VIEWPORT_MARGIN) {
      left = viewportW - VIEWPORT_MARGIN - PANEL_WIDTH;
    }
    setPanelPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    recomputePosition();
  }, [open, recomputePosition, notices.length]);

  useEffect(() => {
    if (!open) return;
    const handle = () => recomputePosition();
    window.addEventListener('resize', handle);
    window.addEventListener('scroll', handle, true);
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('scroll', handle, true);
    };
  }, [open, recomputePosition]);

  // Close-on-outside-click — keeps the panel modal-light without
  // requiring a backdrop layer that would compete with the rest of
  // the chrome. The panel itself lives in a portal, so we also have
  // to exempt clicks that land inside it.
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const insidePill = containerRef.current?.contains(target);
      const insidePanel = panelRef.current?.contains(target);
      if (!insidePill && !insidePanel) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // When the underlying state retires every notice (e.g. operator
  // hits Dismiss on the last one) we early-return below so the pill
  // and the open panel both unmount. The `open` state is intentionally
  // not reset here — when fresh notices arrive on a later render the
  // panel will be re-mounted in its default collapsed state because
  // useState defaults run per-mount.
  if (notices.length === 0) return null;

  return (
    <div
      ref={containerRef}
      data-testid="notices-panel"
      style={{ position: 'relative', flexShrink: 0 }}
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid="notices-pill"
        onClick={() => setOpen(prev => !prev)}
        title={`${notices.length} active notice${notices.length === 1 ? '' : 's'}`}
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: space[1],
          padding: `3px ${space[2]}`,
          border: `1px solid ${colors.warningBorder}`,
          background: colors.warningSoft,
          color: colors.warningText,
          borderRadius: radius.lg,
          fontSize: text.xs,
          fontWeight: 600,
          cursor: 'pointer',
          lineHeight: 1.4,
        }}
      >
        <span aria-hidden="true">🔔</span>
        Notices
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: '18px',
            height: '18px',
            padding: `0 ${space[1]}`,
            background: colors.warning,
            color: colors.textOnBright,
            borderRadius: '999px',
            fontSize: text.xs,
            fontWeight: 700,
          }}
        >
          {notices.length}
        </span>
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          data-testid="notices-list"
          role="dialog"
          aria-label="Active notices"
          style={{
            position: 'fixed',
            top: panelPos?.top ?? -9999,
            left: panelPos?.left ?? -9999,
            zIndex: 1000,
            width: `${PANEL_WIDTH}px`,
            maxHeight: '60vh',
            overflowY: 'auto',
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: radius.md,
            boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
            padding: space[2],
            display: 'flex',
            flexDirection: 'column',
            gap: space[2],
            visibility: panelPos ? 'visible' : 'hidden',
          }}
        >
          {notices.map(notice => {
            const isInfo = notice.severity === 'info';
            return (
              <div
                key={notice.id}
                data-testid={`notice-${notice.id}`}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: space[2],
                  padding: `${space[2]} ${space[3]}`,
                  background: isInfo ? colors.infoSoft : colors.warningSoft,
                  border: `1px solid ${isInfo ? colors.infoBorder : colors.warningBorder}`,
                  borderRadius: radius.sm,
                  fontSize: text.sm,
                  color: isInfo ? colors.infoText : colors.warningText,
                  lineHeight: 1.45,
                  overflow: 'hidden',
                  overflowWrap: 'anywhere',
                  wordBreak: 'break-word',
                }}
              >
                <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                  <div style={{ fontWeight: 700, marginBottom: space[1] }}>{notice.title}</div>
                  <div>{notice.body}</div>
                  {notice.action && (
                    <button
                      type="button"
                      onClick={notice.action.onClick}
                      style={{
                        marginTop: space[1],
                        background: 'none',
                        border: 'none',
                        color: colors.brandStrong,
                        textDecoration: 'underline',
                        cursor: 'pointer',
                        padding: 0,
                        fontSize: text.xs,
                      }}
                    >
                      {notice.action.label}
                    </button>
                  )}
                </div>
                {notice.onDismiss && (
                  <button
                    type="button"
                    onClick={notice.onDismiss}
                    title="Dismiss"
                    aria-label={`Dismiss ${notice.title}`}
                    style={{
                      flexShrink: 0,
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      fontSize: text.lg,
                      lineHeight: 1,
                      color: 'inherit',
                    }}
                  >
                    &times;
                  </button>
                )}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
