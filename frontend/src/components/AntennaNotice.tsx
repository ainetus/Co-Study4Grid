import type { AntennaMeta } from '../types';
import { colors, space, text, radius } from '../styles/tokens';

interface AntennaNoticeProps {
    meta: AntennaMeta;
}

/**
 * Banner shown when the contingency islands a radial ("antenne") pocket of
 * substations. In that case the overflow graph is a synthetic downstream graph
 * of the disconnected zone and the recommender only proposes injection actions
 * (load shedding / curtailment / redispatch) — topological actions are filtered
 * out because they cannot help an isolated pocket.
 */
function AntennaNotice({ meta }: AntennaNoticeProps) {
    const subs = meta.antenna_sub_names || [];
    const shown = subs.slice(0, 6);
    const extra = subs.length - shown.length;
    const directionLabel = meta.direction === 'producer'
        ? 'net producer (export) — curtailment / redispatch-down'
        : 'net consumer (import) — load shedding / redispatch-up';

    return (
        <div
            role="status"
            data-testid="antenna-notice"
            style={{
                background: colors.warningSoft,
                border: `1px solid ${colors.warningBorder}`,
                color: colors.warningText,
                borderRadius: radius.md,
                padding: `${space[2]} ${space[3]}`,
                margin: `${space[2]} 0`,
                fontSize: text.sm,
                lineHeight: 1.4,
            }}
        >
            <div style={{ fontWeight: 600, marginBottom: space.half }}>
                ⚠ Islanded radial pocket — injection actions only
            </div>
            <div>
                Disconnecting the overloaded line <strong>{meta.constraint_line_name}</strong> isolates a
                radial pocket of <strong>{meta.n_subs}</strong> substation{meta.n_subs > 1 ? 's' : ''} fed
                from <strong>{meta.root_sub_name}</strong>. Topological actions can't help an isolated zone,
                so only load shedding, curtailment and redispatch are suggested.
            </div>
            <div style={{ marginTop: space.half, color: colors.textSecondary }}>
                Pocket: {shown.join(', ')}{extra > 0 ? ` +${extra} more` : ''} · {directionLabel}
                {' '}({meta.net_mw} MW net).
            </div>
        </div>
    );
}

export default AntennaNotice;
