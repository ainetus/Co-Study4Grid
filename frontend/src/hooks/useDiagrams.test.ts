// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDiagrams, computeKnownItemsSet } from './useDiagrams';
import type { MetadataIndex, NodeMeta, EdgeMeta } from '../types';
import { interactionLogger } from '../utils/interactionLogger';

const makeIndex = (nodes: string[], edges: string[]): MetadataIndex => ({
    nodesByEquipmentId: new Map<string, NodeMeta>(
        nodes.map(id => [id, { equipmentId: id, svgId: `svg-${id}`, x: 0, y: 0 }]),
    ),
    nodesBySvgId: new Map(),
    edgesByEquipmentId: new Map<string, EdgeMeta>(
        edges.map(id => [id, { equipmentId: id, svgId: `svg-${id}`, node1: 'n1', node2: 'n2' }]),
    ),
    edgesByNode: new Map(),
});

// Mock the api module
vi.mock('../api', () => ({
    api: {
        getNetworkDiagram: vi.fn().mockResolvedValue({ svg: '<svg></svg>', metadata: null }),
        getContingencyDiagram: vi.fn().mockResolvedValue({ svg: '<svg></svg>', metadata: null }),
        getContingencyDiagramPatch: vi.fn().mockResolvedValue({ patchable: false, reason: 'no_base' }),
        getActionVariantDiagram: vi.fn().mockResolvedValue({ svg: '<svg></svg>', metadata: null }),
        getActionVariantDiagramPatch: vi.fn().mockResolvedValue({ patchable: false, reason: 'no_base' }),
        simulateManualAction: vi.fn().mockResolvedValue({}),
        simulateAndVariantDiagramStream: vi.fn().mockResolvedValue({
            body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
        }),
        getNSld: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
        getContingencySld: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
        getActionVariantSld: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
        getElementVoltageLevels: vi.fn().mockResolvedValue({ voltage_level_ids: [] }),
        getFocusedDiagram: vi.fn().mockResolvedValue({ svg: '<svg></svg>', metadata: null }),
        regenerateOverflowGraph: vi.fn().mockResolvedValue({
            pdf_url: '/results/pdf/overflow_geo.html',
            pdf_path: '/tmp/Overflow_Graph/overflow_geo.html',
            mode: 'geo',
            cached: false,
        }),
    },
}));

describe('useDiagrams — interaction logging', () => {
    beforeEach(() => {
        interactionLogger.clear();
        vi.clearAllMocks();
    });

    it('handleViewModeChange updates state but does NOT emit view_mode_changed (App.tsx owns the emission)', () => {
        // The spec-conformant event needs `{ mode, tab, scope }` — the
        // `scope` is computed from the detached-tabs map which isn't
        // visible inside this hook. So the event is emitted by
        // `App.tsx::handleViewModeChangeForTab`, and the hook handler
        // is a pure state setter. This test locks in that split so
        // neither side starts emitting a partial-shape event again
        // (regression: useDiagrams.ts used to emit `{ mode }` only).
        const { result } = renderHook(() => useDiagrams([], [], []));

        act(() => {
            result.current.handleViewModeChange('delta');
        });

        expect(result.current.actionViewMode).toBe('delta');
        expect(interactionLogger.getLog()).toHaveLength(0);
    });

    it('logs zoom_in when handleManualZoomIn is called', () => {
        const { result } = renderHook(() => useDiagrams([], [], []));

        act(() => {
            result.current.handleManualZoomIn();
        });

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe('zoom_in');
        expect(log[0].details).toEqual({ tab: 'n' }); // default tab
    });

    it('logs zoom_out when handleManualZoomOut is called', () => {
        const { result } = renderHook(() => useDiagrams([], [], []));

        act(() => {
            result.current.handleManualZoomOut();
        });

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe('zoom_out');
        expect(log[0].details).toEqual({ tab: 'n' });
    });

    it('logs zoom_reset when handleManualReset is called', () => {
        const { result } = renderHook(() => useDiagrams([], [], []));

        act(() => {
            result.current.handleManualReset();
        });

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe('zoom_reset');
        expect(log[0].details).toEqual({ tab: 'n' });
    });

    it('handleManualReset records the current contingency anchor so the auto-zoom effect does NOT re-zoom back onto the contingency (Unzoom must fully unzoom)', () => {
        // Regression: handleManualReset used to reset lastZoomState to
        // { query: '', branch: '' } while a contingency was still selected.
        // The auto-zoom effect then saw branch '' !== contingency anchor,
        // treated it as a branch change, and immediately re-zoomed onto the
        // contingency — so Unzoom snapped back instead of fully unzooming.
        const { result } = renderHook(() =>
            useDiagrams([], [], ['LINE_A', 'LINE_B']),
        );

        // A viewBox must exist for the reset to write lastZoomState.
        act(() => {
            result.current.setOriginalViewBox({ x: 0, y: 0, w: 100, h: 100 });
        });

        act(() => {
            result.current.handleManualReset();
        });

        expect(result.current.lastZoomState.current).toEqual({
            query: '',
            branch: 'LINE_A',
        });
    });

    it('handleManualReset records an empty branch when no contingency is selected', () => {
        const { result } = renderHook(() => useDiagrams([], [], []));

        act(() => {
            result.current.setOriginalViewBox({ x: 0, y: 0, w: 100, h: 100 });
        });

        act(() => {
            result.current.handleManualReset();
        });

        expect(result.current.lastZoomState.current).toEqual({
            query: '',
            branch: '',
        });
    });

    it('logs sld_overlay_opened when handleVlDoubleClick is called', () => {
        const { result } = renderHook(() => useDiagrams([], [], []));

        act(() => {
            result.current.handleVlDoubleClick('act_1', 'VL_225');
        });

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe('sld_overlay_opened');
        expect(log[0].details).toEqual({ vl_name: 'VL_225', action_id: 'act_1' });
    });

    it('logs sld_overlay_closed when handleOverlayClose is called', () => {
        const { result } = renderHook(() => useDiagrams([], [], []));

        act(() => {
            result.current.handleOverlayClose();
        });

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe('sld_overlay_closed');
    });

    it('logs sld_overlay_tab_changed when handleOverlaySldTabChange is called with active overlay', () => {
        const { result } = renderHook(() => useDiagrams([], [], []));

        // First open an overlay
        act(() => {
            result.current.handleVlDoubleClick('', 'VL_400');
        });
        interactionLogger.clear();

        act(() => {
            result.current.handleOverlaySldTabChange('contingency');
        });

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe('sld_overlay_tab_changed');
        expect(log[0].details).toEqual({ tab: 'contingency', vl_name: 'VL_400' });
    });

    it('logs asset_clicked when handleAssetClick is called', () => {
        const { result } = renderHook(() => useDiagrams([], [], []));

        act(() => {
            result.current.handleAssetClick('act_5', 'LINE_XY', 'contingency', null, vi.fn());
        });

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe('asset_clicked');
        expect(log[0].details).toEqual({ action_id: 'act_5', asset_name: 'LINE_XY', tab: 'contingency' });
    });

    it('logs action_deselected when re-selecting the same action', async () => {
        const { result } = renderHook(() => useDiagrams([], [], []));

        // Set a selected action ID first
        act(() => { result.current.setSelectedActionId('act_1'); });
        interactionLogger.clear();

        // Select same action again triggers deselect
        await act(async () => {
            await result.current.handleActionSelect('act_1', null, '', 0, vi.fn(), vi.fn());
        });

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe('action_deselected');
        // Replay contract (docs/features/interaction-logging.md): the key is
        // `previous_action_id`, not `action_id`. After this event
        // fires no action is selected, so carrying the previously-
        // selected id makes the semantics explicit.
        expect(log[0].details).toEqual({ previous_action_id: 'act_1' });
    });

    it('logs action_selected when selecting a new action', async () => {
        const { result } = renderHook(() => useDiagrams([], [], []));
        interactionLogger.clear();

        await act(async () => {
            await result.current.handleActionSelect('act_2', null, '', 0, vi.fn(), vi.fn());
        });

        const log = interactionLogger.getLog();
        expect(log.some(e => e.type === 'action_selected' && e.details.action_id === 'act_2')).toBe(true);
    });

    it('does not log action_selected when actionId is null', async () => {
        const { result } = renderHook(() => useDiagrams([], [], []));
        interactionLogger.clear();

        await act(async () => {
            await result.current.handleActionSelect(null, null, '', 0, vi.fn(), vi.fn());
        });

        const log = interactionLogger.getLog();
        expect(log.some(e => e.type === 'action_selected')).toBe(false);
    });

    it('logs zoom events for different active tabs', () => {
        const { result } = renderHook(() => useDiagrams([], [], []));

        act(() => { result.current.setActiveTab('action'); });
        interactionLogger.clear();

        act(() => { result.current.handleManualZoomIn(); });

        const log = interactionLogger.getLog();
        expect(log[0].type).toBe('zoom_in');
        expect(log[0].details).toEqual({ tab: 'action' });
    });

    // Bug 3: re-simulating an action that is ALREADY the currently-viewed
    // action must re-fetch its variant diagram instead of silently
    // deselecting it (which left the action tab blank). `handleActionSelect`
    // now accepts a `force` flag that bypasses the "same id → toggle off"
    // early return and always proceeds with the fetch.
    describe('handleActionSelect force flag (Bug 3)', () => {
        it('does NOT deselect when called with force=true on the already-selected action', async () => {
            const { api } = await import('../api');
            const { result } = renderHook(() => useDiagrams([], [], []));

            act(() => { result.current.setSelectedActionId('act_1'); });
            interactionLogger.clear();
            vi.mocked(api.getActionVariantDiagram).mockClear();

            await act(async () => {
                await result.current.handleActionSelect('act_1', null, '', 0, vi.fn(), vi.fn(), true);
            });

            // Must NOT have logged a deselect event.
            const log = interactionLogger.getLog();
            expect(log.some(e => e.type === 'action_deselected')).toBe(false);
            // Must have requested a fresh diagram fetch for act_1.
            expect(api.getActionVariantDiagram).toHaveBeenCalledWith('act_1');
            // Selection must still be on act_1.
            expect(result.current.selectedActionId).toBe('act_1');
        });

        it('still deselects when called without force on the already-selected action', async () => {
            const { api } = await import('../api');
            const { result } = renderHook(() => useDiagrams([], [], []));

            act(() => { result.current.setSelectedActionId('act_1'); });
            interactionLogger.clear();
            vi.mocked(api.getActionVariantDiagram).mockClear();

            await act(async () => {
                await result.current.handleActionSelect('act_1', null, '', 0, vi.fn(), vi.fn());
            });

            const log = interactionLogger.getLog();
            expect(log.some(e => e.type === 'action_deselected')).toBe(true);
            // No fetch is issued on the toggle-off path.
            expect(api.getActionVariantDiagram).not.toHaveBeenCalled();
        });
    });

    // No-blank-flash during the patch-fetch window. Before this guard
    // `handleActionSelect` called `setActionDiagram(null)` immediately
    // on click, which on large grids showed the action-tab container
    // blank for the ~200-500 ms the patch took to arrive. Now the
    // previous action's diagram stays mounted until the new clone is
    // ready, and is replaced atomically.
    describe('action-patch loading window', () => {
        it('does NOT clear actionDiagram between click and patch response', async () => {
            const { api } = await import('../api');
            const { result } = renderHook(() => useDiagrams([], [], []));

            // Seed a previous action diagram so we can detect if it
            // gets cleared during the subsequent click.
            act(() => {
                result.current.setActionDiagram({
                    svg: '<svg>prev</svg>',
                    metadata: null,
                    action_id: 'act_prev',
                } as unknown as Parameters<typeof result.current.setActionDiagram>[0]);
                result.current.setSelectedActionId('act_prev');
            });
            expect(result.current.actionDiagram).not.toBeNull();

            // Never-resolving patch & full-fetch mocks — the handler
            // stays pending through the observable window. `Once`
            // variants so the defaults are restored for subsequent
            // tests in the file (otherwise every later test hangs).
            vi.mocked(api.getActionVariantDiagramPatch).mockReturnValueOnce(
                new Promise(() => {}) as unknown as Promise<import('../types').DiagramPatch>,
            );
            vi.mocked(api.getActionVariantDiagram).mockReturnValueOnce(
                new Promise(() => {}) as unknown as Promise<
                    Awaited<ReturnType<typeof api.getActionVariantDiagram>>
                >,
            );

            act(() => {
                void result.current.handleActionSelect('act_next', null, '', 0, vi.fn(), vi.fn());
            });

            // Critical assertion: the previous diagram is still visible
            // while the new one is being fetched — no blank flash.
            expect(result.current.actionDiagram).not.toBeNull();
            expect(result.current.selectedActionId).toBe('act_next');
        });

        it('clears actionDiagram only on explicit deselect (actionId === null)', async () => {
            const { result } = renderHook(() => useDiagrams([], [], []));

            act(() => {
                result.current.setActionDiagram({
                    svg: '<svg>x</svg>',
                    metadata: null,
                    action_id: 'act_keep',
                } as unknown as Parameters<typeof result.current.setActionDiagram>[0]);
                result.current.setSelectedActionId('act_keep');
            });
            expect(result.current.actionDiagram).not.toBeNull();

            await act(async () => {
                await result.current.handleActionSelect(null, null, '', 0, vi.fn(), vi.fn());
            });

            expect(result.current.actionDiagram).toBeNull();
            expect(result.current.selectedActionId).toBeNull();
        });
    });

    // Stale-response guard. Clicking action A → then action B before
    // A's patch arrives: A's late response must drop itself so the
    // user sees B, not A-after-B. Prevents visible flicker /
    // reverted-selection when users rapidly cycle through actions.
    describe('action-patch stale-response guard', () => {
        it('drops a late patch response for an action that is no longer selected', async () => {
            const { api } = await import('../api');
            const { result } = renderHook(() => useDiagrams([], [], []));

            // Two manually-resolvable promises so we control the
            // relative timing of the two in-flight patch responses.
            type PatchP = Promise<import('../types').DiagramPatch>;
            let resolveA: (v: import('../types').DiagramPatch) => void = () => {};
            let resolveB: (v: import('../types').DiagramPatch) => void = () => {};
            const patchA: PatchP = new Promise(res => { resolveA = res; });
            const patchB: PatchP = new Promise(res => { resolveB = res; });
            vi.mocked(api.getActionVariantDiagramPatch)
                .mockReturnValueOnce(patchA)
                .mockReturnValueOnce(patchB);
            // Never-resolving full-fetch so a `patchable:false` branch
            // cannot finish on its own during the test. Stack two
            // `Once` variants (one per click) so the default is
            // restored for subsequent tests.
            vi.mocked(api.getActionVariantDiagram)
                .mockReturnValueOnce(new Promise(() => {}) as unknown as Promise<
                    Awaited<ReturnType<typeof api.getActionVariantDiagram>>
                >)
                .mockReturnValueOnce(new Promise(() => {}) as unknown as Promise<
                    Awaited<ReturnType<typeof api.getActionVariantDiagram>>
                >);

            // Click A, then B before A resolves.
            act(() => {
                void result.current.handleActionSelect('A', null, '', 0, vi.fn(), vi.fn());
            });
            act(() => {
                void result.current.handleActionSelect('B', null, '', 0, vi.fn(), vi.fn());
            });
            expect(result.current.selectedActionId).toBe('B');

            // B responds first (user's current selection) — OK to apply
            // (the jsdom container has no base SVG so the patch path
            // falls through to the full-fetch, but the guard is
            // exercised regardless).
            await act(async () => {
                resolveB({ patchable: false, reason: 'no_base' } as import('../types').DiagramPatch);
            });

            // Now A responds late. The guard must prevent it from
            // overwriting state that belongs to B.
            await act(async () => {
                resolveA({ patchable: false, reason: 'no_base' } as import('../types').DiagramPatch);
            });

            // Selection must still be B; no revert to A.
            expect(result.current.selectedActionId).toBe('B');
        });
    });

        // SVG DOM-recycling patch path. The frontend tries
    // `getActionVariantDiagramPatch` first; on `patchable:false` or
    // throw, it falls back to the full-SVG `getActionVariantDiagram`.
    // These tests run in jsdom with no mounted N or N-1 SVG DOM, so
    // `baseSvgEl = n1SvgContainerRef.current?.querySelector('svg')`
    // is null and the patch branch is skipped entirely — the full
    // fetch is what every assertion below checks.
    //
    // See docs/performance/history/svg-dom-recycling.md.
    describe('action-variant patch path — falls back to full fetch when no base SVG DOM is mounted', () => {
        it('skips the patch branch entirely when the N-1 / N SVG containers are empty', async () => {
            const { api } = await import('../api');
            const { result } = renderHook(() => useDiagrams([], [], []));

            vi.mocked(api.getActionVariantDiagram).mockClear();
            vi.mocked(api.getActionVariantDiagramPatch).mockClear();

            await act(async () => {
                await result.current.handleActionSelect('act_42', null, '', 0, vi.fn(), vi.fn());
            });

            // No base SVG DOM in jsdom → patch endpoint never called.
            expect(api.getActionVariantDiagramPatch).not.toHaveBeenCalled();
            // Fallback full-fetch IS called.
            expect(api.getActionVariantDiagram).toHaveBeenCalledWith('act_42');
        });
    });

    // Regression tests for the detachable-tab fixes (see
    // docs/features/detachable-viz-tabs.md "Bugs fixed in the second iteration").
    // The previous `active` gate on usePanZoom was `activeTab === '<id>'`
    // alone, which meant that when the user detached a tab the main
    // window auto-switched activeTab elsewhere and the detached tab's
    // pan/zoom listeners were never bound — the popup looked frozen.
    // The fix threads a detachedTabs map through useDiagrams so a
    // detached tab stays interactive even when it is not activeTab.
    describe('useDiagrams accepts detachedTabs for pan/zoom activation (Bug 1)', () => {
        it('accepts a detachedTabs map as the 4th argument', () => {
            // With an empty map the hook behaves exactly like before.
            const { result } = renderHook(() => useDiagrams([], [], [], {}));
            expect(result.current.activeTab).toBe('n');
        });

        it('tolerates each detached-tab key variant without throwing', () => {
            const maps: Array<Partial<Record<string, unknown>>> = [
                { n: { window: {}, mountNode: document.createElement('div') } },
                { 'contingency': { window: {}, mountNode: document.createElement('div') } },
                { action: { window: {}, mountNode: document.createElement('div') } },
                { overflow: { window: {}, mountNode: document.createElement('div') } },
            ];
            for (const m of maps) {
                // Each map represents one tab being detached; the
                // hook should still initialise without any runtime
                // error. This guards against a regression where the
                // 4th-argument type tightens and the map's shape can
                // no longer be passed in.
                expect(() => renderHook(() => useDiagrams([], [], [], m as never))).not.toThrow();
            }
        });

        // When the action tab is detached into a popup, selecting an
        // action card must NOT switch the main window's activeTab to
        // 'action'. The popup gets the new diagram via the existing
        // render path; the main window stays on whatever tab the user
        // had open (typically N or N-1). Without this guard the main
        // window blanks out into the "Detached" placeholder every time
        // the user clicks a different action card. (Sync window/zoom
        // view fix.)
        describe('handleActionSelect respects detached action tab', () => {
            it('does NOT switch activeTab to "action" when the action tab is detached', async () => {
                const { result, rerender } = renderHook(
                    ({ dt }: { dt: Record<string, unknown> }) => useDiagrams([], [], [], dt),
                    {
                        initialProps: {
                            dt: { action: { window: {}, mountNode: document.createElement('div') } } as Record<string, unknown>,
                        },
                    },
                );

                // User parked the main window on the N-1 tab while the
                // action tab is open in a popup.
                act(() => { result.current.setActiveTab('contingency'); });
                expect(result.current.activeTab).toBe('contingency');

                // Re-render with the same detached map so the ref mirror
                // is up-to-date before the callback fires.
                rerender({ dt: { action: { window: {}, mountNode: document.createElement('div') } } });

                await act(async () => {
                    await result.current.handleActionSelect('act_42', null, '', 0, vi.fn(), vi.fn());
                });

                // selection moved, but main-window activeTab is unchanged.
                expect(result.current.selectedActionId).toBe('act_42');
                expect(result.current.activeTab).toBe('contingency');
            });

            it('still switches activeTab to "action" when the action tab is NOT detached', async () => {
                const { result } = renderHook(() => useDiagrams([], [], [], {}));

                act(() => { result.current.setActiveTab('contingency'); });
                expect(result.current.activeTab).toBe('contingency');

                await act(async () => {
                    await result.current.handleActionSelect('act_99', null, '', 0, vi.fn(), vi.fn());
                });

                expect(result.current.selectedActionId).toBe('act_99');
                expect(result.current.activeTab).toBe('action');
            });

            it('still fetches the action variant diagram when the action tab is detached', async () => {
                const { api } = await import('../api');
                const { result, rerender } = renderHook(
                    ({ dt }: { dt: Record<string, unknown> }) => useDiagrams([], [], [], dt),
                    {
                        initialProps: {
                            dt: { action: { window: {}, mountNode: document.createElement('div') } } as Record<string, unknown>,
                        },
                    },
                );

                act(() => { result.current.setActiveTab('n'); });
                rerender({ dt: { action: { window: {}, mountNode: document.createElement('div') } } });
                vi.mocked(api.getActionVariantDiagram).mockClear();

                await act(async () => {
                    await result.current.handleActionSelect('act_77', null, '', 0, vi.fn(), vi.fn());
                });

                // The popup-rendered tab still needs the new diagram, so
                // the fetch must fire even though the main window did not
                // switch to the action tab.
                expect(api.getActionVariantDiagram).toHaveBeenCalledWith('act_77');
                // And the main window stays on N.
                expect(result.current.activeTab).toBe('n');
            });

            it('does NOT switch main window to "contingency" on deselect when action tab is detached', async () => {
                const { result, rerender } = renderHook(
                    ({ dt }: { dt: Record<string, unknown> }) => useDiagrams([], [], [], dt),
                    {
                        initialProps: {
                            dt: { action: { window: {}, mountNode: document.createElement('div') } } as Record<string, unknown>,
                        },
                    },
                );

                // User is on the N tab in the main window; action tab
                // detached and showing 'act_1'.
                act(() => { result.current.setSelectedActionId('act_1'); });
                act(() => { result.current.setActiveTab('n'); });
                rerender({ dt: { action: { window: {}, mountNode: document.createElement('div') } } });

                // Re-clicking the same card toggles deselect.
                await act(async () => {
                    await result.current.handleActionSelect('act_1', null, '', 0, vi.fn(), vi.fn());
                });

                // Selection cleared, but main-window tab is unchanged.
                expect(result.current.selectedActionId).toBe(null);
                expect(result.current.activeTab).toBe('n');
            });

            it('stays on the action tab on deselect so the overview view takes over', async () => {
                // Previous behaviour was to force-switch to n-1 on deselect,
                // which erased the pin-overview view the user was effectively
                // returning to. The new contract: deselect simply nulls
                // selectedActionId and lets VisualizationPanel's action tab
                // fall back to the ActionOverviewDiagram (pin view) — same
                // UX as clicking the ✕ chip on the action tab header.
                const { result } = renderHook(() => useDiagrams([], [], [], {}));

                act(() => { result.current.setSelectedActionId('act_1'); });
                act(() => { result.current.setActiveTab('action'); });

                await act(async () => {
                    await result.current.handleActionSelect('act_1', null, '', 0, vi.fn(), vi.fn());
                });

                expect(result.current.selectedActionId).toBe(null);
                expect(result.current.activeTab).toBe('action');
            });
        });

        // When the action tab is detached into a popup, clicking another
        // action card must preserve the pan/zoom the user had on the
        // previous action — same behaviour as the inline (attached) case.
        // The capture + restore pattern in handleActionSelect / the re-sync
        // effect were previously gated on `activeTab === 'action'`, which
        // is FALSE for the detached case (the main window is on N or N-1),
        // so the viewBox fell through to the N-1 / N viewBox fallback and
        // the popup snapped to a completely different zoom every time the
        // user clicked a different action card.
        describe('handleActionSelect preserves action-tab zoom when detached', () => {
            const zoomedVb = { x: 10, y: 20, w: 50, h: 40 };

            it('keeps the previous action-tab viewBox after switching actions (detached case)', async () => {
                const { api } = await import('../api');
                // Return a new SVG with a native viewBox so usePanZoom's
                // sync effect actively tries to reset to it — this
                // mirrors real diagram loads and makes the test
                // observably exercise the capture+restore path (if the
                // restore were missing, viewBox would end up as the
                // native one, not `zoomedVb`).
                vi.mocked(api.getActionVariantDiagram).mockResolvedValueOnce({
                    svg: '<svg viewBox="0 0 1000 800"></svg>',
                    metadata: null,
                });

                const { result, rerender } = renderHook(
                    ({ dt }: { dt: Record<string, unknown> }) => useDiagrams([], [], [], dt),
                    {
                        initialProps: {
                            dt: { action: { window: {}, mountNode: document.createElement('div') } } as Record<string, unknown>,
                        },
                    },
                );

                // User parked the main window on N-1; the action tab
                // lives in a popup and currently shows 'act_prev' at a
                // zoomed-in viewBox.
                act(() => { result.current.setActiveTab('contingency'); });
                act(() => { result.current.setSelectedActionId('act_prev'); });
                act(() => { result.current.actionPZ.setViewBox(zoomedVb); });
                rerender({ dt: { action: { window: {}, mountNode: document.createElement('div') } } });
                expect(result.current.actionPZ.viewBox).toEqual(zoomedVb);

                // User clicks a different action card in the popup.
                // handleActionSelect must capture the current action
                // viewBox (zoomedVb) into actionSyncSourceRef and
                // re-apply it after the new diagram loads — so the
                // popup stays exactly where it was.
                await act(async () => {
                    await result.current.handleActionSelect('act_next', null, '', 0, vi.fn(), vi.fn());
                });

                expect(result.current.selectedActionId).toBe('act_next');
                // Main window stayed on N-1 (covered by a previous test,
                // but double-checked here as the precondition for the
                // zoom-preserve branch).
                expect(result.current.activeTab).toBe('contingency');
                // The captured viewBox was re-applied — NOT the native
                // one from the freshly loaded SVG.
                expect(result.current.actionPZ.viewBox).toEqual(zoomedVb);
            });

            it('still preserves the action-tab viewBox across action switches when the action tab is inline (attached case)', async () => {
                const { api } = await import('../api');
                vi.mocked(api.getActionVariantDiagram).mockResolvedValueOnce({
                    svg: '<svg viewBox="0 0 1000 800"></svg>',
                    metadata: null,
                });

                const { result } = renderHook(() => useDiagrams([], [], [], {}));

                // User is on the action tab inline, zoomed into
                // 'act_prev'.
                act(() => { result.current.setActiveTab('action'); });
                act(() => { result.current.setSelectedActionId('act_prev'); });
                act(() => { result.current.actionPZ.setViewBox(zoomedVb); });
                expect(result.current.actionPZ.viewBox).toEqual(zoomedVb);

                // Click a different action card.
                await act(async () => {
                    await result.current.handleActionSelect('act_next', null, '', 0, vi.fn(), vi.fn());
                });

                // Sanity: this is the long-standing attached-case
                // behaviour. Regression guard for it.
                expect(result.current.selectedActionId).toBe('act_next');
                expect(result.current.activeTab).toBe('action');
                expect(result.current.actionPZ.viewBox).toEqual(zoomedVb);
            });

            it('falls back to the N-1 viewBox when selecting an action with no prior action-tab viewBox (detached case)', async () => {
                const { api } = await import('../api');
                vi.mocked(api.getActionVariantDiagram).mockResolvedValueOnce({
                    svg: '<svg viewBox="0 0 1000 800"></svg>',
                    metadata: null,
                });

                const n1Vb = { x: 100, y: 200, w: 300, h: 400 };

                const { result, rerender } = renderHook(
                    ({ dt }: { dt: Record<string, unknown> }) => useDiagrams([], [], [], dt),
                    {
                        initialProps: {
                            dt: { action: { window: {}, mountNode: document.createElement('div') } } as Record<string, unknown>,
                        },
                    },
                );

                // Main window on N-1 with a viewBox, action tab
                // detached but the user has NOT yet selected an
                // action — so actionPZ.viewBox is still null.
                act(() => { result.current.setActiveTab('contingency'); });
                act(() => { result.current.n1PZ.setViewBox(n1Vb); });
                rerender({ dt: { action: { window: {}, mountNode: document.createElement('div') } } });
                expect(result.current.actionPZ.viewBox).toBeNull();

                // Picking the first action in the detached popup
                // should fall back to the N-1 viewBox (the standard
                // "sync across tabs" behaviour, unchanged by this fix).
                await act(async () => {
                    await result.current.handleActionSelect('act_first', null, '', 0, vi.fn(), vi.fn());
                });

                expect(result.current.actionPZ.viewBox).toEqual(n1Vb);
            });
        });

        // Any interaction targeting a tab that is currently detached
        // must leave the main window's `activeTab` alone. In particular,
        // clicking an asset button inside an action card (or an N / N-1
        // overload badge) used to force the main window to switch to
        // that tab — for a detached tab, that means the main window
        // goes from N or N-1 to the blank "Detached" placeholder every
        // time. The fix routes the auto-zoom via `setInspectQueryForTab`
        // (so the zoom still lands on the detached tab) while skipping
        // the `setActiveTab` call for any detached target.
        describe('handleAssetClick does not force activeTab onto detached tabs', () => {
            it('does NOT switch activeTab to "action" when clicking an asset on the already-selected action card while the action tab is detached', () => {
                const { result, rerender } = renderHook(
                    ({ dt }: { dt: Record<string, unknown> }) => useDiagrams([], [], [], dt),
                    {
                        initialProps: {
                            dt: { action: { window: {}, mountNode: document.createElement('div') } } as Record<string, unknown>,
                        },
                    },
                );

                // Main window on N-1, action tab in popup showing 'act_1'.
                act(() => { result.current.setActiveTab('contingency'); });
                act(() => { result.current.setSelectedActionId('act_1'); });
                rerender({ dt: { action: { window: {}, mountNode: document.createElement('div') } } });

                // User clicks an asset badge inside the act_1 card.
                act(() => {
                    result.current.handleAssetClick('act_1', 'LINE_XY', 'action', 'act_1', vi.fn());
                });

                // Main-window activeTab unchanged.
                expect(result.current.activeTab).toBe('contingency');
                // And the inspect query is set (drives the auto-zoom
                // on the detached action tab).
                expect(result.current.inspectQuery).toBe('LINE_XY');
            });

            it('still switches activeTab to "action" when clicking an asset on the already-selected action and the action tab is NOT detached', () => {
                const { result } = renderHook(() => useDiagrams([], [], [], {}));

                act(() => { result.current.setSelectedActionId('act_1'); });
                act(() => { result.current.setActiveTab('contingency'); });

                act(() => {
                    result.current.handleAssetClick('act_1', 'LINE_XY', 'action', 'act_1', vi.fn());
                });

                // No detachment → main window follows the click.
                expect(result.current.activeTab).toBe('action');
                expect(result.current.inspectQuery).toBe('LINE_XY');
            });

            it('does NOT switch activeTab to "n" when clicking an asset targeting a detached N tab', () => {
                const { result, rerender } = renderHook(
                    ({ dt }: { dt: Record<string, unknown> }) => useDiagrams([], [], [], dt),
                    {
                        initialProps: {
                            dt: { n: { window: {}, mountNode: document.createElement('div') } } as Record<string, unknown>,
                        },
                    },
                );

                act(() => { result.current.setActiveTab('action'); });
                rerender({ dt: { n: { window: {}, mountNode: document.createElement('div') } } });

                act(() => {
                    result.current.handleAssetClick('', 'LINE_N', 'n', null, vi.fn());
                });

                expect(result.current.activeTab).toBe('action');
                expect(result.current.inspectQuery).toBe('LINE_N');
            });

            it('does NOT switch activeTab to "contingency" when clicking an asset targeting a detached N-1 tab', () => {
                const { result, rerender } = renderHook(
                    ({ dt }: { dt: Record<string, unknown> }) => useDiagrams([], [], [], dt),
                    {
                        initialProps: {
                            dt: { 'contingency': { window: {}, mountNode: document.createElement('div') } } as Record<string, unknown>,
                        },
                    },
                );

                act(() => { result.current.setActiveTab('action'); });
                act(() => { result.current.setSelectedActionId('act_1'); });
                rerender({ dt: { 'contingency': { window: {}, mountNode: document.createElement('div') } } });

                act(() => {
                    result.current.handleAssetClick('', 'LINE_N1', 'contingency', 'act_1', vi.fn());
                });

                expect(result.current.activeTab).toBe('action');
                expect(result.current.inspectQuery).toBe('LINE_N1');
            });

            it('still switches activeTab to "contingency" when clicking an asset targeting an INLINE N-1 tab', () => {
                const { result } = renderHook(() => useDiagrams([], [], [], {}));

                act(() => { result.current.setActiveTab('action'); });

                act(() => {
                    result.current.handleAssetClick('', 'LINE_N1', 'contingency', null, vi.fn());
                });

                expect(result.current.activeTab).toBe('contingency');
            });

            it('still forwards to handleActionSelect (which has its own detached guard) when clicking an asset on a DIFFERENT action while the action tab is detached', () => {
                const handleActionSelectFn = vi.fn();
                const { result, rerender } = renderHook(
                    ({ dt }: { dt: Record<string, unknown> }) => useDiagrams([], [], [], dt),
                    {
                        initialProps: {
                            dt: { action: { window: {}, mountNode: document.createElement('div') } } as Record<string, unknown>,
                        },
                    },
                );

                act(() => { result.current.setSelectedActionId('act_prev'); });
                act(() => { result.current.setActiveTab('contingency'); });
                rerender({ dt: { action: { window: {}, mountNode: document.createElement('div') } } });

                act(() => {
                    result.current.handleAssetClick('act_new', 'LINE_X', 'action', 'act_prev', handleActionSelectFn);
                });

                // The different-action branch delegates to the caller
                // (wrappedActionSelect → handleActionSelect), NOT to
                // setActiveTab directly. The detached-guard for the
                // activeTab switch lives in handleActionSelect itself
                // (tested elsewhere in this file).
                expect(handleActionSelectFn).toHaveBeenCalledWith('act_new');
                expect(result.current.activeTab).toBe('contingency');
            });
        });

        it('re-renders with a new detachedTabs map without losing state', () => {
            // Start with no detached tabs.
            const { result, rerender } = renderHook(
                ({ dt }: { dt: Record<string, unknown> }) => useDiagrams([], [], [], dt),
                { initialProps: { dt: {} as Record<string, unknown> } }
            );
            const initialActiveTab = result.current.activeTab;

            // Detach the N tab.
            rerender({ dt: { n: { window: {}, mountNode: document.createElement('div') } } });
            // Hook state (refs, active tab) is not clobbered.
            expect(result.current.activeTab).toBe(initialActiveTab);
            // SVG refs remain the same object identity — critical for
            // stable pan/zoom across detach.
            const nRef = result.current.nSvgContainerRef;
            rerender({ dt: {} });
            expect(result.current.nSvgContainerRef).toBe(nRef);
        });
    });
});

describe('computeKnownItemsSet — auto-zoom guard', () => {
    it('includes branches and voltage levels', () => {
        const set = computeKnownItemsSet(['BRANCH_A', 'BRANCH_B'], ['VL1', 'VL2'], []);
        expect(set.has('BRANCH_A')).toBe(true);
        expect(set.has('BRANCH_B')).toBe(true);
        expect(set.has('VL1')).toBe(true);
        expect(set.has('VL2')).toBe(true);
    });

    it('still rejects partial / unknown text so typed-input guard works', () => {
        const set = computeKnownItemsSet(['BRANCH_A'], ['VL1'], []);
        expect(set.has('BRAN')).toBe(false);
        expect(set.has('UNKNOWN_LINE')).toBe(false);
    });

    it('includes equipment IDs from metadata edge indices', () => {
        // A line that is NOT in the disconnectable branches list
        // (e.g. an action reshuffles flows and a different line
        // becomes the new max_rho line) must still be zoomable via
        // an explicit asset click.
        const actionMeta = makeIndex([], ['CHALOL31LOUHA']);
        const set = computeKnownItemsSet(['BEONL31CPVAN'], [], [null, null, actionMeta]);
        expect(set.has('BEONL31CPVAN')).toBe(true);
        expect(set.has('CHALOL31LOUHA')).toBe(true);
    });

    it('includes equipment IDs from metadata node indices', () => {
        const nMeta = makeIndex(['VL_FOO'], []);
        const set = computeKnownItemsSet([], [], [nMeta]);
        expect(set.has('VL_FOO')).toBe(true);
    });

    it('is the union of branches, voltageLevels and every provided index', () => {
        const nMeta = makeIndex(['NODE_N'], ['EDGE_N']);
        const n1Meta = makeIndex(['NODE_N1'], ['EDGE_N1']);
        const actionMeta = makeIndex(['NODE_A'], ['EDGE_A']);
        const set = computeKnownItemsSet(
            ['BRANCH_X'], ['VL_X'], [nMeta, n1Meta, actionMeta],
        );
        for (const k of ['BRANCH_X', 'VL_X', 'NODE_N', 'EDGE_N', 'NODE_N1', 'EDGE_N1', 'NODE_A', 'EDGE_A']) {
            expect(set.has(k)).toBe(true);
        }
    });

    it('tolerates null / undefined metadata indices', () => {
        expect(() => computeKnownItemsSet([], [], [null, undefined, null])).not.toThrow();
        const set = computeKnownItemsSet(['BRANCH_A'], [], [null]);
        expect(set.has('BRANCH_A')).toBe(true);
    });
});

describe('useDiagrams — overflow layout toggle', () => {
    beforeEach(() => {
        interactionLogger.clear();
        vi.clearAllMocks();
    });

    const makeResult = (pdf_url: string) => ({
        pdf_url,
        pdf_path: `/tmp/Overflow_Graph/${pdf_url.split('/').pop()}`,
        actions: {},
        action_scores: null,
        lines_overloaded: [],
        message: '',
        dc_fallback: false,
    });

    it('handleOverflowLayoutChange calls api.regenerateOverflowGraph and merges pdf_url', async () => {
        const { result } = renderHook(() => useDiagrams([], [], []));
        const api = (await import('../api')).api;
        (api.regenerateOverflowGraph as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            pdf_url: '/results/pdf/new_geo.html',
            pdf_path: '/tmp/Overflow_Graph/new_geo.html',
            mode: 'geo',
            cached: false,
        });

        const setResult = vi.fn();
        setResult.mockImplementation((updater: unknown) => {
            if (typeof updater === 'function') {
                return (updater as (p: unknown) => unknown)(makeResult('/results/pdf/old.html'));
            }
            return updater;
        });
        const setError = vi.fn();

        await act(async () => {
            await result.current.handleOverflowLayoutChange('geo', setResult, setError);
        });

        expect(api.regenerateOverflowGraph).toHaveBeenCalledWith('geo');
        // setResult must receive a function that merges the new pdf_url
        // into the previous result without wiping other fields.
        expect(setResult).toHaveBeenCalled();
        const updater = setResult.mock.calls[0][0] as (prev: ReturnType<typeof makeResult>) => unknown;
        const merged = updater(makeResult('/results/pdf/old.html'));
        expect((merged as { pdf_url: string }).pdf_url).toBe('/results/pdf/new_geo.html');
        expect((merged as { pdf_path: string }).pdf_path).toBe('/tmp/Overflow_Graph/new_geo.html');
        expect(setError).not.toHaveBeenCalled();
        expect(result.current.overflowLayoutMode).toBe('geo');
    });

    it('emits overflow_layout_mode_toggled interaction event with the target mode', async () => {
        const { result } = renderHook(() => useDiagrams([], [], []));
        await act(async () => {
            await result.current.handleOverflowLayoutChange('geo', vi.fn(), vi.fn());
        });
        const events = interactionLogger.getLog();
        const toggle = events.find((e) => e.type === 'overflow_layout_mode_toggled');
        expect(toggle).toBeDefined();
        expect(toggle?.details).toMatchObject({ to: 'geo' });
    });

    it('surfaces errors via setError without throwing', async () => {
        const { result } = renderHook(() => useDiagrams([], [], []));
        const api = (await import('../api')).api;
        (api.regenerateOverflowGraph as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new Error('backend down'),
        );

        const setResult = vi.fn();
        const setError = vi.fn();
        await act(async () => {
            await result.current.handleOverflowLayoutChange('geo', setResult, setError);
        });
        expect(setError).toHaveBeenCalled();
        const msg = setError.mock.calls[0][0] as string;
        expect(msg).toContain('backend down');
        // State isn't flipped on failure — the previous mode persists.
        expect(result.current.overflowLayoutMode).toBe('hierarchical');
    });

    it('clears overflowLayoutLoading after the request resolves', async () => {
        const { result } = renderHook(() => useDiagrams([], [], []));
        await act(async () => {
            await result.current.handleOverflowLayoutChange('geo', vi.fn(), vi.fn());
        });
        expect(result.current.overflowLayoutLoading).toBe(false);
    });
});

describe('useDiagrams — voltage range filter', () => {
    // Regression guards for the kV-filter reset bug: when the user
    // collapsed the range to a single voltage (hiding elements on
    // other levels) and then expanded it back out, the previously
    // hidden elements stayed invisible because an early-return in
    // applyVoltageFilter short-circuited the fully-open case without
    // resetting `display:none` from the prior narrow-range run.
    beforeEach(() => {
        interactionLogger.clear();
        vi.clearAllMocks();
    });

    const buildHarness = () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg><g id="svg-VL400"></g><g id="svg-VL225"></g></svg>';
        document.body.appendChild(container);
        const el400 = container.querySelector('#svg-VL400') as HTMLElement;
        const el225 = container.querySelector('#svg-VL225') as HTMLElement;
        return { container, el400, el225 };
    };

    const populate = (
        result: { current: ReturnType<typeof useDiagrams> },
        container: HTMLElement,
    ) => {
        act(() => {
            result.current.nSvgContainerRef.current = container as HTMLDivElement;
            result.current.setNDiagram({
                svg: '<svg></svg>',
                metadata: {
                    nodes: [
                        { equipmentId: 'VL400', svgId: 'svg-VL400', x: 0, y: 0 },
                        { equipmentId: 'VL225', svgId: 'svg-VL225', x: 0, y: 0 },
                    ],
                    edges: [],
                } as unknown as string,
                originalViewBox: { x: 0, y: 0, width: 100, height: 100 },
            });
            result.current.setNominalVoltageMap({ VL400: 400, VL225: 225 });
            result.current.setUniqueVoltages([225, 400]);
        });
    };

    it('hides out-of-range voltage-level elements when the range is narrowed', () => {
        const { result } = renderHook(() => useDiagrams([], [], []));
        const { container, el400, el225 } = buildHarness();
        populate(result, container);

        act(() => {
            result.current.setVoltageRange([225, 225]);
        });

        expect(el400.style.display).toBe('none');
        expect(el225.style.display).toBe('');
        document.body.removeChild(container);
    });

    it('restores previously hidden elements when the range is expanded back to fully open', () => {
        const { result } = renderHook(() => useDiagrams([], [], []));
        const { container, el400, el225 } = buildHarness();
        populate(result, container);

        // Narrow the range to hide 400 kV.
        act(() => {
            result.current.setVoltageRange([225, 225]);
        });
        expect(el400.style.display).toBe('none');

        // Expand back to fully open. Previously the early-return would
        // short-circuit and leave el400 stuck at display:none.
        act(() => {
            result.current.setVoltageRange([225, 400]);
        });
        expect(el400.style.display).toBe('');
        expect(el225.style.display).toBe('');
        document.body.removeChild(container);
    });
});
